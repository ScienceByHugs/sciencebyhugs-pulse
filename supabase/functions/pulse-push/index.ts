import { ensureKeys, deliver, handleSubscription } from '../_shared/web-push.ts'
import { packageState } from '../_shared/inventory.ts'
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
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || secretKeys.default
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 })

async function vaultSecret(name: string) {
  const rows = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name} limit 1`
  return rows[0]?.decrypted_secret as string | undefined
}

async function ensureVapid() { return ensureKeys(sql, 'pulse') }

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
  if (!schedule.active || schedule.frequency === "as_needed" || dateKey < schedule.start_date || (schedule.end_date && dateKey > schedule.end_date)) return false
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
  const rows=await sql`select notification_key from public.push_delivery_log where user_id=${userId} and notification_key=${key} limit 1`
  return rows.length>0
}
async function markSent(userId: string, key: string) {
  await sql`insert into public.push_delivery_log(user_id,notification_key,sent_at) values(${userId},${key},now()) on conflict(user_id,notification_key) do update set sent_at=now()`
}

async function sendToUser(userId: string, subscriptions: any[], title: string, body: string, tag: string, url = './?view=today') {
  let delivered = false
  for (const sub of subscriptions.filter(s => s.user_id === userId)) {
    try {
      if (await deliver(admin, 'push_subscriptions', sub, { title, body, tag, url }, sql)) delivered = true
    } catch (error: any) { console.error('Push delivery failed', error?.statusCode || 'network') }
  }
  return delivered
}

async function dispatch() {
  const subs=await sql`select * from public.push_subscriptions`
  if (!subs.length) return {sent:0}
  const { publicKey, privateKey } = await ensureVapid()
  webpush.setVapidDetails('mailto:notifications@sciencebyhugs.com',publicKey,privateKey)
  // Direct database reads avoid short-lived gateway JWT clock skew in scheduled jobs.
  const [prefs,profiles,schedules,logs,inventory]=await Promise.all([
    sql`select * from public.notification_preferences`,
    sql`select user_id,timezone from public.profiles`,
    sql`select s.*,s.start_date::text as start_date,s.end_date::text as end_date,s.scheduled_time::text as scheduled_time,
      jsonb_build_object('name',t.name,'active',t.active) as tracked_items
      from public.schedules s join public.tracked_items t on t.id=s.tracked_item_id where s.active`,
    sql`select user_id,schedule_id,scheduled_for,status from public.logs where logged_at>=now()-interval '3 days'`,
    sql`select i.*,i.expiration_date::text as expiration_date,
      jsonb_build_object('name',t.name,'default_amount',t.default_amount,'default_unit',t.default_unit) as tracked_items
      from public.inventory i join public.tracked_items t on t.id=i.tracked_item_id`,
  ])

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
          if (existing?.status === "completed" || existing?.status === "skipped") continue
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
        const state = packageState(row,row.tracked_items?.default_amount,row.tracked_items?.default_unit)
        const low = row.low_threshold !== null && Number(row.quantity) <= Number(row.low_threshold)
        const expired = !!row.expiration_date && row.expiration_date < lp.date
        const change = state?.changeSoon || state?.lastDoseInPackage
        const out = state?.out || Number(row.quantity)===0
        if (!low && !expired && !change && !out) continue
        const reason = out ? "out" : expired ? "expired" : low ? "low" : "package"
        const key = `inventory:${row.id}:${reason}:${lp.date}`
        if (await alreadySent(pref.user_id,key)) continue
        const name = row.tracked_items?.name || "An item"
        const body = out ? `${name} has insufficient stock for another dose. Review inventory and explore the NEXUS research catalog.`
          : expired ? `${name} has expired. Review your stock in PULSE.`
          : low ? `${name} is at your reorder threshold. Explore the NEXUS research catalog from inventory.`
          : state?.changeSoon ? `${name}: change ${row.package_type || "package"} for your next dose.`
          : `${name}: one full dose remains in the current ${row.package_type || "package"}. Have the next one ready.`
        const delivered = await sendToUser(pref.user_id,userSubs,"PULSE · Inventory alert",body,key,"./?view=inventory")
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

    if (action === "dispatch") {
      const provided = req.headers.get("x-cron-key") || ""
      const expected = await vaultSecret("pulse_push_cron_secret")
      if (!expected || provided !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 })
      const result = await dispatch()
      return Response.json(result)
    }

    return await handleSubscription(req, admin, sql, 'pulse', 'push_subscriptions', corsHeaders, 'pulse')
  } catch (error: any) {
    console.error(error)
    return Response.json({ error: "Unable to process notifications. Please try again." }, { status: 500, headers: corsHeaders })
  }
})

