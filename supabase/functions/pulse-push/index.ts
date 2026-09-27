import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.117.1"
import postgres from "npm:postgres@3.4.5"
import webpush from "npm:web-push@3.6.7"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")
const serviceKey = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 })

async function vaultSecret(name: string) {
  const rows = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name} limit 1`
  return rows[0]?.decrypted_secret as string | undefined
}

async function ensureVapid() {
  let publicKey = await vaultSecret("pulse_vapid_public")
  let privateKey = await vaultSecret("pulse_vapid_private")
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys()
    publicKey = generated.publicKey
    privateKey = generated.privateKey
    if (!(await vaultSecret("pulse_vapid_public"))) {
      await sql`select vault.create_secret(${publicKey}, 'pulse_vapid_public', 'PULSE Web Push VAPID public key')`
    }
    if (!(await vaultSecret("pulse_vapid_private"))) {
      await sql`select vault.create_secret(${privateKey}, 'pulse_vapid_private', 'PULSE Web Push VAPID private key')`
    }
  }
  return { publicKey, privateKey }
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value || ""
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  }
}

const weekdayIndex: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }

function addLocalDays(dateKey: string, days: number) {
  const [y,m,d] = dateKey.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m-1, d + days))
  return dt.toISOString().slice(0,10)
}

function weekdayForDateKey(dateKey: string) {
  const [y,m,d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y,m-1,d)).getUTCDay()
}

function dayDiffKeys(a: string, b: string) {
  const [ay,am,ad]=a.split("-").map(Number)
  const [by,bm,bd]=b.split("-").map(Number)
  return Math.floor((Date.UTC(ay,am-1,ad)-Date.UTC(by,bm-1,bd))/86400000)
}

function dueOn(schedule: any, dateKey: string) {
  if (!schedule.active || schedule.frequency === "as_needed" || dateKey < schedule.start_date) return false
  if (schedule.frequency === "daily") return true
  if (schedule.frequency === "interval") return !!schedule.interval_days && dayDiffKeys(dateKey, schedule.start_date) % schedule.interval_days === 0
  const days = schedule.days_of_week || []
  const weekday = weekdayForDateKey(dateKey)
  if (schedule.frequency === "weekly" && !days.length) return weekday === weekdayForDateKey(schedule.start_date)
  return days.includes(weekday)
}

function logMatches(log: any, scheduleId: string, dateKey: string, timeZone: string) {
  if (log.schedule_id !== scheduleId || !log.scheduled_for) return false
  return localParts(new Date(log.scheduled_for), timeZone).date === dateKey
}

async function alreadySent(userId: string, key: string) {
  const { data } = await admin.from("push_delivery_log").select("notification_key").eq("user_id", userId).eq("notification_key", key).maybeSingle()
  return !!data
}

async function markSent(userId: string, key: string) {
  await admin.from("push_delivery_log").upsert({ user_id: userId, notification_key: key, sent_at: new Date().toISOString() })
}

async function sendToUser(userId: string, subscriptions: any[], title: string, body: string, tag: string) {
  let delivered = false
  for (const sub of subscriptions.filter(s => s.user_id === userId)) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, tag, url: "/sciencebyhugs-pulse/" }),
        { TTL: 3600 }
      )
      delivered = true
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", sub.id)
      } else {
        console.error("push send error", error?.statusCode, error?.message)
      }
    }
  }
  return delivered
}

async function dispatch() {
  const { publicKey, privateKey } = await ensureVapid()
  webpush.setVapidDetails("mailto:notifications@sciencebyhugs.com", publicKey, privateKey)

  const [
    { data: prefs, error: prefsError },
    { data: subs, error: subsError },
    { data: profiles, error: profilesError },
    { data: schedules, error: schedulesError },
    { data: logs, error: logsError },
    { data: inventory, error: inventoryError },
  ] = await Promise.all([
    admin.from("notification_preferences").select("*"),
    admin.from("push_subscriptions").select("*"),
    admin.from("profiles").select("user_id,timezone"),
    admin.from("schedules").select("id,user_id,frequency,scheduled_time,days_of_week,interval_days,start_date,active,tracked_items(name,active)").eq("active",true),
    admin.from("logs").select("user_id,schedule_id,scheduled_for,status").gte("logged_at", new Date(Date.now()-3*86400000).toISOString()),
    admin.from("inventory").select("id,user_id,quantity,unit,low_threshold,expiration_date,tracked_items(name)"),
  ])
  const problem = prefsError || subsError || profilesError || schedulesError || logsError || inventoryError
  if (problem) throw problem

  const now = new Date()
  let sent = 0

  for (const pref of prefs || []) {
    const userSubs = (subs || []).filter((s:any) => s.user_id === pref.user_id)
    if (!userSubs.length) continue
    const timezone = (profiles || []).find((p:any) => p.user_id === pref.user_id)?.timezone || "America/Los_Angeles"
    const lp = localParts(now, timezone)
    const nowMinutes = lp.hour * 60 + lp.minute
    const userLogs = (logs || []).filter((l:any) => l.user_id === pref.user_id)
    const userSchedules = (schedules || []).filter((s:any) => s.user_id === pref.user_id && s.tracked_items?.active)

    if (pref.dose_reminders_enabled) {
      for (const s of userSchedules) {
        if (!s.scheduled_time) continue
        const [h,m] = s.scheduled_time.split(":").map(Number)
        const scheduledMinutes = h*60+m
        for (const offset of [0,1]) {
          const occurrenceDate = addLocalDays(lp.date, offset)
          if (!dueOn(s, occurrenceDate)) continue
          const diff = offset*1440 + scheduledMinutes - nowMinutes
          const lead = Number(pref.reminder_lead_minutes || 0)
          if (diff > lead || diff <= lead-5) continue
          const existing = userLogs.find((l:any) => logMatches(l,s.id,occurrenceDate,timezone))
          if (existing?.status === "completed") continue
          const key = `dose:${s.id}:${occurrenceDate}:lead:${lead}`
          if (await alreadySent(pref.user_id,key)) continue
          const delivered = await sendToUser(pref.user_id,userSubs,"PULSE · Dose due soon",`${s.tracked_items?.name || "Scheduled dose"} is due soon.`,key)
          if (delivered) { await markSent(pref.user_id,key); sent++ }
        }
      }
    }

    if (pref.overdue_reminders_enabled) {
      for (const s of userSchedules) {
        if (!s.scheduled_time || !dueOn(s,lp.date)) continue
        const [h,m] = s.scheduled_time.split(":").map(Number)
        const scheduledMinutes = h*60+m
        if (nowMinutes < scheduledMinutes + 30) continue
        const existing = userLogs.find((l:any) => logMatches(l,s.id,lp.date,timezone))
        if (existing?.status === "completed" || existing?.status === "skipped") continue
        const key = `overdue:${s.id}:${lp.date}`
        if (await alreadySent(pref.user_id,key)) continue
        const delivered = await sendToUser(pref.user_id,userSubs,"PULSE · Dose overdue",`${s.tracked_items?.name || "Scheduled dose"} is overdue.`,key)
        if (delivered) { await markSent(pref.user_id,key); sent++ }
      }
    }

    if (pref.low_stock_notifications_enabled) {
      for (const row of (inventory || []).filter((i:any)=>i.user_id===pref.user_id)) {
        const low = row.low_threshold !== null && Number(row.quantity) <= Number(row.low_threshold)
        const expired = !!row.expiration_date && row.expiration_date < lp.date
        if (!low && !expired) continue
        const key = `inventory:${row.id}:${lp.date}`
        if (await alreadySent(pref.user_id,key)) continue
        const reason = low && expired ? "low stock and expired" : low ? "running low" : "expired"
        const delivered = await sendToUser(pref.user_id,userSubs,"PULSE · Inventory alert",`${row.tracked_items?.name || "An item"} is ${reason}.`,key)
        if (delivered) { await markSent(pref.user_id,key); sent++ }
      }
    }
  }

  return { sent }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  try {
    const url = new URL(req.url)
    const action = url.searchParams.get("action") || "config"

    if (action === "config") {
      const authHeader = req.headers.get("Authorization") || ""
      const token = authHeader.replace(/^Bearer\s+/i,"")
      if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
      const { data: { user }, error } = await admin.auth.getUser(token)
      if (error || !user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
      const { publicKey } = await ensureVapid()
      return Response.json({ publicKey }, { headers: corsHeaders })
    }

    if (action === "dispatch") {
      const provided = req.headers.get("x-cron-key") || ""
      const expected = await vaultSecret("pulse_push_cron_secret")
      if (!expected || provided !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 })
      const result = await dispatch()
      return Response.json(result)
    }

    return Response.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders })
  } catch (error: any) {
    console.error(error)
    return Response.json({ error: error?.message || "Internal error" }, { status: 500, headers: corsHeaders })
  }
})
