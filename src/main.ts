import './styles.css'
import './brand.css'
import { supabase } from './supabase'

const pulseLogoUrl = `${import.meta.env.BASE_URL}brand/pulse.svg`
const pushFunctionUrl = 'https://pspiqukuhtazmkyfleii.supabase.co/functions/v1/pulse-push?action=config'
const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root not found')
let reminderTimer:number|undefined
let deferredInstallPrompt:any=null
window.addEventListener('beforeinstallprompt',(event:any)=>{
  event.preventDefault()
  deferredInstallPrompt=event
})

type Category = 'anabolic'|'hormone'|'peptide'|'glp'|'medication'|'vitamin'|'supplement'|'injection'|'other'
type Form = 'injectable'|'oral'|'suppository'|'topical'
type Item = {
  id:string; name:string; category:Category; form:Form|null; default_amount:number|null; default_unit:string|null;
  route:string|null; notes:string|null; active:boolean
}
type Log = {
  id:string; tracked_item_id:string; logged_at:string; amount:number|null; unit:string|null; status:string;
  route:string|null; injection_site:string|null; notes:string|null; schedule_id:string|null; scheduled_for:string|null;
  tracked_items?: { name:string; category:string; form?:Form|null } | null
}
type Schedule = {
  id:string; tracked_item_id:string; frequency:'daily'|'weekly'|'interval'|'as_needed'|'custom';
  scheduled_time:string|null; days_of_week:number[]|null; interval_days:number|null; start_date:string;
  active:boolean; tracked_items?: { name:string; active?:boolean } | null
}
type Cycle = {
  id:string; name:string; start_date:string; end_date:string|null; status:'planned'|'active'|'completed'|'paused'; notes:string|null
}
type CycleItem = { id:string; cycle_id:string; tracked_item_id:string }
type NotificationPrefs = {
  user_id:string; dose_reminders_enabled:boolean; reminder_lead_minutes:number;
  overdue_reminders_enabled:boolean; low_stock_notifications_enabled:boolean
}

type Inventory = {
  id:string; tracked_item_id:string; quantity:number; unit:string; low_threshold:number|null;
  lot_number:string|null; expiration_date:string|null; auto_decrement:boolean; decrement_amount:number|null;
  strength_amount:number|null; strength_unit:string|null; strength_per_amount:number|null; strength_per_unit:string|null;
  containers_on_hand:number|null;
  tracked_items?: { name:string; active?:boolean; category?:string; route?:string|null; default_amount?:number|null; default_unit?:string|null; form?:Form|null } | null
}

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const titleCase=(v:string)=>v.charAt(0).toUpperCase()+v.slice(1)
const localInputValue=(d=new Date())=>{
  const pad=(n:number)=>String(n).padStart(2,'0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dateKey=(d:Date)=>localInputValue(d).slice(0,10)
const startOfDay=(d=new Date())=>new Date(d.getFullYear(),d.getMonth(),d.getDate())
const endOfDay=(d=new Date())=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)
const dayDiff=(a:Date,b:Date)=>Math.floor((startOfDay(a).getTime()-startOfDay(b).getTime())/86400000)
const scheduleDueOn=(s:Schedule,d:Date)=>{
  const start=new Date(s.start_date+'T00:00:00')
  if(startOfDay(d)<startOfDay(start) || !s.active || s.frequency==='as_needed') return false
  if(s.frequency==='daily') return true
  if(s.frequency==='interval') return !!s.interval_days && dayDiff(d,start)%s.interval_days===0
  const days=s.days_of_week??[]
  if(s.frequency==='weekly' && !days.length) return d.getDay()===start.getDay()
  return days.includes(d.getDay())
}
const occurrenceDate=(s:Schedule,d:Date)=>{
  const result=startOfDay(d)
  if(s.scheduled_time){
    const [h,m]=s.scheduled_time.split(':').map(Number)
    result.setHours(h||0,m||0,0,0)
  }
  return result
}
const scheduleLabel=(s:Schedule)=>{
  if(s.frequency==='daily') return 'Daily'
  if(s.frequency==='interval') return 'Every '+(s.interval_days??'?')+' days'
  if(s.frequency==='as_needed') return 'As needed'
  const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const days=(s.days_of_week??[]).map(d=>names[d]).join(', ')
  return days || titleCase(s.frequency)
}

async function boot() {
  const { data:{ session } } = await supabase.auth.getSession()
  if (!session) return renderAuth()
  await renderDashboard(session.user.id, session.user.email ?? 'Researcher')
}

function renderAuth(message='') {
  app!.innerHTML=`
    <main class="auth-shell">
      <section class="brand-panel"><img class="pulse-auth-lockup" src="${pulseLogoUrl}" alt="Pulse — Science By Hugs"><p>Track. Measure. Evolve.</p><div class="pulse-line"></div></section>
      <section class="auth-card">
        <span class="kicker">PRIVATE TRACKING</span><h2>Welcome to PULSE</h2>
        <p class="muted">Sign in or create your PULSE account.</p>
        ${message ? `<div class="notice">${esc(message)}</div>` : ''}
        <form id="auth-form">
          <label>Email<input id="email" type="email" required autocomplete="email"></label>
          <label>Password<input id="password" type="password" minlength="8" required autocomplete="current-password"></label>
          <button class="primary" type="submit">Sign in</button>
          <button class="ghost" id="signup" type="button">Create account</button>
          <button class="text-button" id="forgot-password" type="button">Forgot password?</button>
        </form>
      </section>
    </main>`
  const email=()=>document.querySelector<HTMLInputElement>('#email')!.value.trim()
  const pass=()=>document.querySelector<HTMLInputElement>('#password')!.value
  document.querySelector('#auth-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const {error}=await supabase.auth.signInWithPassword({email:email(),password:pass()})
    if(error) return renderAuth(error.message)
    boot()
  })
  document.querySelector('#signup')!.addEventListener('click',async()=>{
    const emailRedirectTo=new URL(import.meta.env.BASE_URL,window.location.origin).toString()
    const {error}=await supabase.auth.signUp({
      email:email(),
      password:pass(),
      options:{emailRedirectTo}
    })
    renderAuth(error ? error.message : 'Account created. Check your email if confirmation is required, then sign in.')
  })
  document.querySelector('#forgot-password')!.addEventListener('click',async()=>{
    if(!email()) return renderAuth('Enter your email address first.')
    const redirectTo=new URL(import.meta.env.BASE_URL,window.location.origin).toString()
    const {error}=await supabase.auth.resetPasswordForEmail(email(),{redirectTo})
    renderAuth(error?error.message:'Password reset email sent. Check your inbox.')
  })
}

function renderPasswordReset(message=''){
  app!.innerHTML=`
    <main class="auth-shell">
      <section class="brand-panel"><img class="pulse-auth-lockup" src="${pulseLogoUrl}" alt="Pulse — Science By Hugs"><p>Track. Measure. Evolve.</p><div class="pulse-line"></div></section>
      <section class="auth-card">
        <span class="kicker">ACCOUNT RECOVERY</span><h2>Choose a new password</h2>
        <p class="muted">Use at least 8 characters.</p>
        ${message?`<div class="notice">${esc(message)}</div>`:''}
        <form id="password-update-form">
          <label>New password<input id="new-password" type="password" minlength="8" required autocomplete="new-password"></label>
          <label>Confirm password<input id="confirm-password" type="password" minlength="8" required autocomplete="new-password"></label>
          <button class="primary" type="submit">Update password</button>
        </form>
      </section>
    </main>`
  document.querySelector('#password-update-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const password=document.querySelector<HTMLInputElement>('#new-password')!.value
    const confirm=document.querySelector<HTMLInputElement>('#confirm-password')!.value
    if(password!==confirm) return renderPasswordReset('Passwords do not match.')
    const {error}=await supabase.auth.updateUser({password})
    if(error) return renderPasswordReset(error.message)
    await boot()
  })
}

function routeOptions(selected:string|null=''){
  const options=[
    ['intramuscular','Intramuscular'],
    ['subcutaneous','Subcutaneous'],
    ['powder','Powder'],
    ['oral','Oral'],
    ['topical','Topical']
  ]
  return '<option value="">Select route</option>'+options.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('')
}

function urlBase64ToUint8Array(base64String:string){
  const padding='='.repeat((4-base64String.length%4)%4)
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/')
  const raw=window.atob(base64)
  return Uint8Array.from([...raw].map(char=>char.charCodeAt(0)))
}

async function ensureBackgroundPush(userId:string){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Background push is not supported in this browser.')
  if(!('Notification' in window)) throw new Error('Notifications are not supported in this browser.')
  const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission()
  if(permission!=='granted') throw new Error(permission==='denied'?'Notifications are blocked in your browser settings.':'Notification permission was not granted.')

  const {data:{session}}=await supabase.auth.getSession()
  if(!session) throw new Error('Your session expired. Sign in again.')

  const response=await fetch(pushFunctionUrl,{
    headers:{Authorization:`Bearer ${session.access_token}`}
  })
  const config=await response.json()
  if(!response.ok || !config.publicKey) throw new Error(config.error||'Unable to load push configuration.')

  const registration=await navigator.serviceWorker.ready
  let subscription=await registration.pushManager.getSubscription()
  if(!subscription){
    subscription=await registration.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(config.publicKey)
    })
  }
  const json=subscription.toJSON()
  const p256dh=json.keys?.p256dh
  const auth=json.keys?.auth
  if(!p256dh || !auth) throw new Error('Push subscription keys are unavailable.')

  const {error}=await supabase.from('push_subscriptions').upsert({
    user_id:userId,
    endpoint:subscription.endpoint,
    p256dh,
    auth,
    user_agent:navigator.userAgent,
    updated_at:new Date().toISOString()
  },{onConflict:'user_id,endpoint'})
  if(error) throw error
  return subscription
}

async function hasBackgroundPush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  try{
    const registration=await navigator.serviceWorker.ready
    return !!(await registration.pushManager.getSubscription())
  }catch{
    return false
  }
}

function categoryFields(item:Item){
  return `
    <label>Route<select id="log-route">${routeOptions(item.route)}</select></label>
    ${item.form==='injectable' || item.category==='injection' ? `
      <label>Injection site<select id="log-site">
        <option value="">Select injection site</option>
        <optgroup label="Abdomen">
          <option value="Abdomen — Right Lower Quadrant (RLQ)">Lower right</option>
          <option value="Abdomen — Left Lower Quadrant (LLQ)">Lower left</option>
          <option value="Abdomen — Right Upper Quadrant (RUQ)">Upper right</option>
          <option value="Abdomen — Left Upper Quadrant (LUQ)">Upper left</option>
          <option value="Abdomen — Left Lateral Flank">Left love handle</option>
          <option value="Abdomen — Right Lateral Flank">Right love handle</option>
        </optgroup>
        <optgroup label="Deltoid Muscle">
          <option value="Deltoid Muscle — Right">Right</option>
          <option value="Deltoid Muscle — Left">Left</option>
        </optgroup>
        <optgroup label="Vastus Lateralis">
          <option value="Vastus Lateralis — Right">Right</option>
          <option value="Vastus Lateralis — Left">Left</option>
        </optgroup>
        <optgroup label="Latissimus Dorsi">
          <option value="Latissimus Dorsi — Right">Right</option>
          <option value="Latissimus Dorsi — Left">Left</option>
        </optgroup>
        <optgroup label="Trapezius Muscle">
          <option value="Trapezius Muscle — Right">Right</option>
          <option value="Trapezius Muscle — Left">Left</option>
        </optgroup>
        <optgroup label="Gluteal Region">
          <option value="Gluteal Region — Right">Right</option>
          <option value="Gluteal Region — Left">Left</option>
        </optgroup>
      </select></label>` : ''}`
}

async function renderDashboard(userId:string,email:string,showArchived=false,jwtRetry=0) {
  const today=new Date()
  const [{data:items,error:itemError},{data:allItems,error:allItemError},{data:logs,error:logError},{data:schedules,error:scheduleError},{data:todayLogs,error:todayLogError},{data:inventory,error:inventoryError},{data:cycles,error:cycleError},{data:cycleItems,error:cycleItemError},{data:cycleLogs,error:cycleLogError},{data:notificationPrefs,error:notificationPrefsError}] = await Promise.all([
    supabase.from('tracked_items')
      .select('id,name,category,form,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).eq('active',!showArchived).order('created_at',{ascending:false}),
    supabase.from('tracked_items')
      .select('id,name,category,form,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).order('name',{ascending:true}),
    supabase.from('logs')
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category,form)')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(8),
    supabase.from('schedules')
      .select('id,tracked_item_id,frequency,scheduled_time,days_of_week,interval_days,start_date,active,tracked_items!inner(name,active)')
      .eq('user_id',userId).eq('active',true).eq('tracked_items.active',true).order('scheduled_time',{ascending:true}),
    supabase.from('logs')
      .select('id,schedule_id,scheduled_for,status')
      .eq('user_id',userId).not('schedule_id','is',null)
      .gte('scheduled_for',startOfDay(today).toISOString()).lt('scheduled_for',endOfDay(today).toISOString()),
    supabase.from('inventory')
      .select('id,tracked_item_id,quantity,unit,low_threshold,lot_number,expiration_date,auto_decrement,decrement_amount,strength_amount,strength_unit,strength_per_amount,strength_per_unit,containers_on_hand,tracked_items(name,active,category,route,default_amount,default_unit,form)')
      .eq('user_id',userId).order('updated_at',{ascending:false}),
    supabase.from('cycles')
      .select('id,name,start_date,end_date,status,notes')
      .eq('user_id',userId).order('start_date',{ascending:false}),
    supabase.from('cycle_items')
      .select('id,cycle_id,tracked_item_id')
      .eq('user_id',userId),
    supabase.from('logs')
      .select('tracked_item_id,logged_at,status,schedule_id,scheduled_for')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(1000),
    supabase.from('notification_preferences')
      .select('user_id,dose_reminders_enabled,reminder_lead_minutes,overdue_reminders_enabled,low_stock_notifications_enabled')
      .eq('user_id',userId).maybeSingle()
  ])
  if(itemError || allItemError || logError || scheduleError || todayLogError || inventoryError || cycleError || cycleItemError || cycleLogError || notificationPrefsError) {
    const problem=itemError?.message??allItemError?.message??logError?.message??scheduleError?.message??todayLogError?.message??inventoryError?.message??cycleError?.message??cycleItemError?.message??cycleLogError?.message??notificationPrefsError?.message
    if(jwtRetry<1 && problem?.toLowerCase().includes('jwt issued at future')){
      await new Promise(resolve=>setTimeout(resolve,1500))
      return renderDashboard(userId,email,showArchived,jwtRetry+1)
    }
    app!.innerHTML=`<main class="app-shell"><div class="notice">Unable to load PULSE: ${esc(problem)}</div></main>`
    return
  }

  const itemList=(items??[]) as Item[]
  const allItemList=(allItems??[]) as Item[]
  const recent=(logs??[]) as unknown as Log[]
  const scheduleList=(schedules??[]) as unknown as Schedule[]
  const inventoryList=(inventory??[]) as unknown as Inventory[]
  const cycleList=(cycles??[]) as Cycle[]
  const cycleItemList=(cycleItems??[]) as CycleItem[]
  const cycleLogList=(cycleLogs??[]) as {tracked_item_id:string;logged_at:string;status:string;schedule_id:string|null;scheduled_for:string|null}[]
  const reminderPrefs=(notificationPrefs??{
    user_id:userId,dose_reminders_enabled:true,reminder_lead_minutes:30,
    overdue_reminders_enabled:true,low_stock_notifications_enabled:true
  }) as NotificationPrefs
  const inventoryByItem=new Map(inventoryList.map(row=>[row.tracked_item_id,row]))
  const todayKey=dateKey(today)
  const lowInventory=inventoryList.filter(row=>row.low_threshold!==null && Number(row.quantity)<=Number(row.low_threshold))
  const expiredInventory=inventoryList.filter(row=>!!row.expiration_date && row.expiration_date<todayKey)
  const inventoryAlerts=[...new Map([...lowInventory,...expiredInventory].map(row=>[row.id,row])).values()]
  const weeklyPlanFor=(itemId:string)=>{
    const item=allItemList.find(i=>i.id===itemId)
    if(!item?.default_amount || !item.default_unit) return null
    const itemSchedules=scheduleList.filter(s=>s.tracked_item_id===itemId && s.active)
    let weeklyOccurrences=0
    let exact=true
    for(const s of itemSchedules){
      if(s.frequency==='daily') weeklyOccurrences+=7
      else if(s.frequency==='weekly') weeklyOccurrences+=(s.days_of_week?.length||1)
      else if(s.frequency==='interval' && s.interval_days){
        weeklyOccurrences+=7/s.interval_days
        exact=false
      } else if(s.frequency!=='as_needed') exact=false
    }
    if(!weeklyOccurrences) return null
    return {
      occurrences:weeklyOccurrences,
      total:Number(item.default_amount)*weeklyOccurrences,
      unit:item.default_unit,
      exact
    }
  }
  const todayDone=new Map((todayLogs??[]).map((l:any)=>[l.schedule_id,l.status]))
  const dueToday=scheduleList.filter(s=>scheduleDueOn(s,today)).map(s=>{
    const when=occurrenceDate(s,today)
    const status=todayDone.get(s.id) as string|undefined
    return {schedule:s,when,status,overdue:!status && !!s.scheduled_time && when.getTime()<Date.now()}
  })
  const completedToday=dueToday.filter(x=>x.status==='completed').length
  const skippedToday=dueToday.filter(x=>x.status==='skipped').length

  const activeCycle=cycleList.find(c=>c.status==='active')??null
  const activeCycleItemIds=new Set(cycleItemList.filter(ci=>ci.cycle_id===activeCycle?.id).map(ci=>ci.tracked_item_id))
  const cycleStart=activeCycle?new Date(activeCycle.start_date+'T00:00:00'):null
  const cycleEnd=activeCycle?.end_date?new Date(activeCycle.end_date+'T23:59:59'):null
  const cycleRelevantLogs=activeCycle?cycleLogList.filter(l=>{
    if(!activeCycleItemIds.has(l.tracked_item_id)) return false
    const d=new Date(l.logged_at)
    if(cycleStart && d<cycleStart) return false
    if(cycleEnd && d>cycleEnd) return false
    return true
  }):[]
  const cycleCompleted=cycleRelevantLogs.filter(l=>l.status==='completed').length
  const cycleSkipped=cycleRelevantLogs.filter(l=>l.status==='skipped').length
  const cycleAdherence=(cycleCompleted+cycleSkipped)>0?Math.round(cycleCompleted/(cycleCompleted+cycleSkipped)*100):null
  const cycleProgress=(()=>{
    if(!activeCycle || !cycleStart || !cycleEnd) return null
    const total=Math.max(1,cycleEnd.getTime()-cycleStart.getTime())
    const elapsed=Math.min(total,Math.max(0,today.getTime()-cycleStart.getTime()))
    return Math.round(elapsed/total*100)
  })()

  const adherenceWindowDays=7
  const adherenceStart=startOfDay(new Date(today.getFullYear(),today.getMonth(),today.getDate()-(adherenceWindowDays-1)))
  const expectedOccurrences:{schedule:Schedule;when:Date;status:string|null}[]=[]
  for(const schedule of scheduleList){
    for(let offset=0;offset<adherenceWindowDays;offset++){
      const d=new Date(adherenceStart.getFullYear(),adherenceStart.getMonth(),adherenceStart.getDate()+offset)
      if(!scheduleDueOn(schedule,d)) continue
      const when=occurrenceDate(schedule,d)
      if(when.getTime()>Date.now()) continue
      const matching=cycleLogList.find(log=>
        log.schedule_id===schedule.id &&
        !!log.scheduled_for &&
        dateKey(new Date(log.scheduled_for))===dateKey(when)
      )
      expectedOccurrences.push({schedule,when,status:matching?.status??null})
    }
  }
  const expectedCount=expectedOccurrences.length
  const completedExpected=expectedOccurrences.filter(x=>x.status==='completed').length
  const missedExpected=expectedOccurrences.filter(x=>!x.status || x.status==='skipped').length
  const adherence7d=expectedCount?Math.round(completedExpected/expectedCount*100):null
  const dueSoon=dueToday.filter(x=>!x.status && x.schedule.scheduled_time && x.when.getTime()>=Date.now() && x.when.getTime()-Date.now()<=reminderPrefs.reminder_lead_minutes*60000)
  const overdueNow=dueToday.filter(x=>x.overdue)
  const adherenceTrend=Array.from({length:7},(_,index)=>{
    const d=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(6-index))
    const key=dateKey(d)
    const expected=expectedOccurrences.filter(x=>dateKey(x.when)===key)
    const completed=expected.filter(x=>x.status==='completed').length
    return {
      key,
      label:d.toLocaleDateString(undefined,{weekday:'short'}),
      expected:expected.length,
      completed,
      percent:expected.length?Math.round(completed/expected.length*100):null
    }
  })


  const nextDoseFor=(itemId:string)=>{
    const schedules=scheduleList.filter(s=>s.tracked_item_id===itemId && s.active && s.frequency!=='as_needed')
    for(let offset=0;offset<60;offset++){
      const d=new Date(today.getFullYear(),today.getMonth(),today.getDate()+offset)
      for(const schedule of schedules){
        if(!scheduleDueOn(schedule,d)) continue
        const when=occurrenceDate(schedule,d)
        if(when.getTime()>=Date.now()) return {schedule,when}
      }
    }
    return null
  }

  const adherenceForItem=(itemId:string,days:number)=>{
    const start=startOfDay(new Date(today.getFullYear(),today.getMonth(),today.getDate()-(days-1)))
    let expected=0
    let completed=0
    for(const schedule of scheduleList.filter(s=>s.tracked_item_id===itemId && s.active)){
      for(let offset=0;offset<days;offset++){
        const d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+offset)
        if(!scheduleDueOn(schedule,d)) continue
        const when=occurrenceDate(schedule,d)
        if(when.getTime()>Date.now()) continue
        expected++
        const matching=cycleLogList.find(log=>
          log.schedule_id===schedule.id &&
          !!log.scheduled_for &&
          dateKey(new Date(log.scheduled_for))===dateKey(when)
        )
        if(matching?.status==='completed') completed++
      }
    }
    return {expected,completed,percent:expected?Math.round(completed/expected*100):null}
  }

  const supplyFor=(item:Item)=>{
    const stock=inventoryByItem.get(item.id)
    if(!stock || !item.default_amount || !item.default_unit) return null
    let availableDoses:number|null=null
    let basis=''
    if(stock.auto_decrement && stock.decrement_amount && Number(stock.decrement_amount)>0){
      availableDoses=Number(stock.quantity)/Number(stock.decrement_amount)
      basis='inventory decrement'
    }else if(stock.unit===item.default_unit){
      availableDoses=Number(stock.quantity)/Number(item.default_amount)
      basis='matching units'
    }else if(
      stock.strength_amount!==null && stock.strength_per_amount!==null &&
      stock.strength_unit===item.default_unit && stock.strength_per_unit===stock.unit &&
      Number(stock.strength_per_amount)>0
    ){
      const totalDoseUnits=Number(stock.quantity)*(Number(stock.strength_amount)/Number(stock.strength_per_amount))
      availableDoses=totalDoseUnits/Number(item.default_amount)
      basis='concentration'
    }
    if(availableDoses===null || !Number.isFinite(availableDoses)) return null
    const weekly=weeklyPlanFor(item.id)
    const daysRemaining=weekly?.occurrences ? availableDoses/weekly.occurrences*7 : null
    const depletionDate=daysRemaining!==null
      ? new Date(today.getFullYear(),today.getMonth(),today.getDate()+Math.floor(daysRemaining))
      : null
    return {doses:Math.max(0,availableDoses),daysRemaining,depletionDate,basis}
  }

  const runwayWarnings=allItemList
    .map(item=>({item,supply:supplyFor(item)}))
    .filter(row=>row.supply?.daysRemaining!==null && row.supply?.daysRemaining!==undefined && row.supply.daysRemaining<=14)
    .sort((a,b)=>(a.supply!.daysRemaining??999)-(b.supply!.daysRemaining??999))

  app!.innerHTML=`
    <main class="app-shell">
      <header>
        <div><img class="pulse-brand-lockup" src="${pulseLogoUrl}" alt="Pulse — Science By Hugs"></div>
        <button class="ghost compact" id="signout">Sign out</button>
      </header>

      <section class="welcome"><span class="kicker">YOUR PROTOCOL</span><h2>Stay on schedule.</h2><p class="muted">${esc(email)}</p></section>

      <section class="quick-actions">
        <button class="primary" id="quick-log" ${itemList.length && !showArchived?'':'disabled'}>+ Log dose</button>
        <button class="ghost" id="add-item">+ Add substance</button>
        <button class="ghost" id="open-cycles">Cycles</button>
        <button class="ghost" id="open-reminders">Reminders</button>
        <button class="ghost" id="open-inventory">Inventory${inventoryAlerts.length?` · ${inventoryAlerts.length}`:''}</button>
        <button class="ghost" id="open-settings">Settings & Data</button>
        <button class="ghost" id="toggle-archive">${showArchived?'View active':'Archived substances'}</button>
      </section>

      ${!showArchived?`
      <section class="today-panel panel">
        <div class="panel-head">
          <div><span class="kicker">TODAY</span><h3>${today.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'})}</h3></div>
          <button class="ghost compact" id="add-schedule" ${itemList.length?'':'disabled'}>+ Schedule</button>
        </div>
        <div class="today-summary">
          <span><b>${completedToday}</b> complete</span>
          <span><b>${skippedToday}</b> skipped</span>
          <span><b>${dueSoon.length}</b> due soon</span>
          <span><b>${overdueNow.length}</b> overdue</span>
        </div>
        <div class="rows today-rows">
          ${dueToday.length?dueToday.map(x=>`
            <div class="row today-row ${x.status?'done':x.overdue?'overdue':''}">
              <span>
                <b>${esc(x.schedule.tracked_items?.name??'Scheduled item')}</b>
                <small>${x.schedule.scheduled_time?x.when.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'Any time'} · ${esc(scheduleLabel(x.schedule))}</small>
              </span>
              <div class="today-actions">
                ${x.status?`<span class="status-pill ${x.status}">${esc(titleCase(x.status))}</span>`:`
                  <button class="primary compact" data-today-action="complete" data-schedule-id="${x.schedule.id}">Log</button>
                  <button class="ghost compact" data-today-action="skip" data-schedule-id="${x.schedule.id}">Skip</button>`}
                <button class="ghost compact" data-today-action="edit" data-schedule-id="${x.schedule.id}">Edit</button>
              </div>
            </div>`).join(''):'<p class="empty">Nothing scheduled for today.</p>'}
        </div>
      </section>`:''}

      <section class="stats v2-stats adherence-stats">
        <article><span>DUE TODAY</span><strong>${dueToday.filter(x=>!x.status).length}</strong><small>${dueSoon.length} due soon · ${overdueNow.length} overdue</small></article>
        <article><span>7-DAY ADHERENCE</span><strong>${adherence7d===null?'—':adherence7d+'%'}</strong><small>${completedExpected}/${expectedCount} expected doses completed</small></article>
        <article><span>LOW STOCK / EXPIRED</span><strong class="${inventoryAlerts.length?'inventory-alert-count':'online'}">${inventoryAlerts.length||'● Clear'}</strong><small>${inventoryAlerts.length?'Review inventory':'Inventory looks good'}</small></article>
      </section>

      ${!showArchived?`
      <section class="panel beta-analytics">
        <div class="panel-head">
          <div><span class="kicker">BETA SNAPSHOT</span><h3>Last 7 days</h3></div>
          <span class="beta-badge">v0.9 BETA</span>
        </div>
        <div class="adherence-trend">
          ${adherenceTrend.map(day=>`<div class="trend-day">
            <div class="trend-track"><span style="height:${day.percent===null?4:Math.max(4,day.percent)}%"></span></div>
            <b>${day.percent===null?'—':day.percent+'%'}</b>
            <small>${esc(day.label)}</small>
          </div>`).join('')}
        </div>
        <div class="beta-attention-grid">
          <div><span>NEXT ACTION</span><strong>${overdueNow.length?overdueNow.length+' overdue':dueSoon.length?dueSoon.length+' due soon':dueToday.filter(x=>!x.status).length?dueToday.filter(x=>!x.status).length+' remaining today':'Caught up'}</strong></div>
          <div><span>SUPPLY WATCH</span><strong>${runwayWarnings.length?runwayWarnings.length+' under 14 days':'No short runway'}</strong></div>
          <div><span>ACTIVE CYCLE</span><strong>${activeCycle?esc(activeCycle.name):'None'}</strong></div>
        </div>
      </section>`:''}

      ${!showArchived?`
      <section class="panel cycle-overview ${activeCycle?'':'cycle-empty'}">
        <div class="panel-head">
          <div><span class="kicker">CURRENT CYCLE</span><h3>${activeCycle?esc(activeCycle.name):'No active cycle'}</h3></div>
          <div class="cycle-overview-actions">
            ${activeCycle?`<button class="ghost compact" id="active-cycle-details">View details</button>`:''}
            <button class="ghost compact" id="open-cycles-secondary">${activeCycle?'Manage cycles':'Create cycle'}</button>
          </div>
        </div>
        ${activeCycle?`
          <div class="cycle-metrics">
            <div><span>PROGRESS</span><strong>${cycleProgress===null?'Ongoing':cycleProgress+'%'}</strong></div>
            <div><span>LOGGED ADHERENCE</span><strong>${cycleAdherence===null?'—':cycleAdherence+'%'}</strong></div>
            <div><span>SUBSTANCES</span><strong>${activeCycleItemIds.size}</strong></div>
            <div><span>DATES</span><strong>${esc(activeCycle.start_date)}${activeCycle.end_date?' → '+esc(activeCycle.end_date):' → ongoing'}</strong></div>
          </div>
          ${cycleProgress!==null?`<div class="cycle-progress-track"><span style="width:${cycleProgress}%"></span></div>`:''}
        `:`<p class="empty">Create a cycle to group substances together and track progress over time.</p>`}
      </section>`:''}

      <section class="layout">
        <article class="panel">
          <div class="panel-head"><div><span class="kicker">${showArchived?'ARCHIVE':'MY STACK'}</span><h3>${showArchived?'Archived substances':'Your substances'}</h3></div></div>
          <div class="rows">
            ${itemList.length?itemList.map(i=>`
              <div class="row item-card" data-id="${i.id}">
                <button class="item-main" data-action="log" data-id="${i.id}" ${showArchived?'disabled':''}>
                  <span><b>${esc(i.name)}</b><small>${esc(titleCase(i.category))}${i.form?' · '+esc(titleCase(i.form)):''}${i.route?' · '+esc(titleCase(i.route)):''}</small></span>
                  <span class="dose">${i.default_amount??'—'} ${esc(i.default_unit??'')}</span>
                </button>
                <div class="row-actions">
                  <button class="ghost compact" data-action="details" data-id="${i.id}">Details</button>
                  ${!showArchived?`<button class="ghost compact" data-action="schedule" data-id="${i.id}">Schedule</button>`:''}
                  <button class="ghost compact" data-action="edit" data-id="${i.id}">Edit</button>
                  <button class="ghost compact ${showArchived?'restore':'danger'}" data-action="${showArchived?'restore':'archive'}" data-id="${i.id}">${showArchived?'Restore':'Archive'}</button>
                </div>
              </div>`).join(''):`<p class="empty">${showArchived?'No archived items.':'Add your first tracked item to begin.'}</p>`}
          </div>
        </article>

        <article class="panel">
          <div class="panel-head"><div><span class="kicker">HISTORY</span><h3>Recent activity</h3></div><button class="ghost compact" id="open-history">View all</button></div>
          <div class="rows">
            ${recent.length?recent.map(l=>`
              <div class="row log-row">
                <span><b>${esc(l.tracked_items?.name??'Tracked item')}</b>
                  <small>${new Date(l.logged_at).toLocaleString()} · ${esc(titleCase(l.status))}${l.injection_site?' · '+esc(l.injection_site):''}</small>
                </span>
                <span>${l.amount??'—'} ${esc(l.unit??'')}</span>
              </div>`).join(''):'<p class="empty">No activity logged yet.</p>'}
          </div>
        </article>
      </section>

      ${!showArchived?`
      <section class="panel schedules-panel">
        <div class="panel-head"><div><span class="kicker">SCHEDULES</span><h3>Active schedules</h3></div><button class="ghost compact" id="add-schedule-secondary" ${itemList.length?'':'disabled'}>+ Add</button></div>
        <div class="rows">
          ${scheduleList.length?scheduleList.map(s=>`
            <div class="row schedule-row">
              <span><b>${esc(s.tracked_items?.name??'Tracked item')}</b><small>${esc(scheduleLabel(s))}${s.scheduled_time?' · '+esc(new Date('1970-01-01T'+s.scheduled_time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})):''}</small></span>
              <button class="ghost compact" data-schedule-edit="${s.id}">Edit</button>
            </div>`).join(''):'<p class="empty">No active schedules yet.</p>'}
        </div>
      </section>`:''}

      ${!showArchived?`
      <section class="panel inventory-preview">
        <div class="panel-head">
          <div><span class="kicker">INVENTORY</span><h3>Stock overview</h3></div>
          <button class="ghost compact" id="open-inventory-secondary">Manage inventory</button>
        </div>
        ${inventoryAlerts.length?`<div class="inventory-alerts">
          ${inventoryAlerts.slice(0,4).map(row=>{
            const low=row.low_threshold!==null && Number(row.quantity)<=Number(row.low_threshold)
            const expired=!!row.expiration_date && row.expiration_date<todayKey
            return `<div class="inventory-alert-row">
              <span><b>${esc(row.tracked_items?.name??'Tracked item')}</b><small>${low?'Low stock':''}${low&&expired?' · ':''}${expired?'Expired':''}</small></span>
              <strong>${esc(row.quantity)} ${esc(row.unit)}</strong>
            </div>`
          }).join('')}
        </div>`:`<p class="empty">No low-stock or expiration alerts.</p>`}
      </section>`:''}

      <dialog id="settings-modal" class="settings-modal">
        <section class="settings-shell">
          <div class="panel-head">
            <div><span class="kicker">SETTINGS & DATA</span><h3>PULSE Beta</h3><p class="muted">Account, data portability, install status, and beta information.</p></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div class="settings-grid">
            <article class="settings-card"><span>VERSION</span><strong>0.9.0 Beta</strong><small>Private beta candidate</small></article>
            <article class="settings-card"><span>ACCOUNT</span><strong>${esc(email)}</strong><small>Your PULSE data is scoped to your signed-in account.</small></article>
            <article class="settings-card"><span>NOTIFICATIONS</span><strong id="settings-push-status">Checking…</strong><small>Dose, overdue, and inventory reminders.</small></article>
          </div>
          <div class="settings-actions">
            <button class="primary" id="settings-export" type="button">Export my PULSE data</button>
            <button class="ghost" id="settings-reset-password" type="button">Send password reset email</button>
            <button class="ghost" id="settings-install" type="button">Install / Add PULSE to Home Screen</button>
            <button class="ghost danger" id="settings-delete-data" type="button">Delete all tracking data</button>
          </div>
          <section class="beta-disclosure">
            <span class="kicker">BETA NOTICE</span>
            <p>PULSE is a personal tracking and reminder tool. It records information you enter and summarizes schedules, adherence, cycles, and inventory. It does not prescribe, recommend, or determine dosing or medical treatment.</p>
            <p class="muted">During beta, verify important schedule and inventory information independently and report unexpected behavior before relying on it.</p>
          </section>
        </section>
      </dialog>

      <dialog id="substance-detail-modal" class="substance-detail-modal">
        <section class="substance-detail-shell">
          <div class="panel-head">
            <div><span class="kicker" id="substance-detail-kicker">SUBSTANCE</span><h3 id="substance-detail-title">Substance</h3></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div id="substance-detail-body"><p class="empty">Loading…</p></div>
        </section>
      </dialog>

      <dialog id="reminder-modal">
        <form id="reminder-form">
          <div class="panel-head"><div><span class="kicker">REMINDERS</span><h3>Dose & inventory alerts</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <p class="muted">Enable background push so PULSE can notify you about scheduled doses, overdue doses, and inventory alerts even when the app is closed. On iPhone/iPad, install PULSE to the Home Screen first.</p>
          <label class="toggle-row"><input id="reminder-dose-enabled" type="checkbox"><span>Dose reminders</span></label>
          <label>Remind me before a scheduled dose<select id="reminder-lead">
            <option value="0">At scheduled time</option><option value="15">15 minutes before</option>
            <option value="30">30 minutes before</option><option value="60">1 hour before</option>
            <option value="120">2 hours before</option>
          </select></label>
          <label class="toggle-row"><input id="reminder-overdue-enabled" type="checkbox"><span>Overdue dose alerts</span></label>
          <label class="toggle-row"><input id="reminder-low-stock-enabled" type="checkbox"><span>Low-stock / expired inventory alerts</span></label>
          <button class="ghost" id="enable-browser-notifications" type="button">Enable browser notifications</button>
          <button class="primary" type="submit">Save reminder settings</button>
        </form>
      </dialog>

      <dialog id="cycle-modal" class="cycle-modal">
        <section class="cycle-shell">
          <div class="panel-head">
            <div><span class="kicker">CYCLES</span><h3>Cycles & protocols</h3><p class="muted">Group substances into a cycle and track time-based progress.</p></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <button class="primary compact" id="cycle-add" type="button">+ New cycle</button>
          <div class="cycle-list">
            ${cycleList.length?cycleList.map(cycle=>{
              const members=cycleItemList.filter(ci=>ci.cycle_id===cycle.id)
              return `<article class="cycle-card ${cycle.status==='active'?'active':''}">
                <div><b>${esc(cycle.name)}</b><small>${esc(titleCase(cycle.status))} · ${esc(cycle.start_date)}${cycle.end_date?' → '+esc(cycle.end_date):' → ongoing'} · ${members.length} substance${members.length===1?'':'s'}</small></div>
                <div class="cycle-card-actions">
                  <button class="ghost compact" data-cycle-details="${cycle.id}">Details</button>
                  <button class="ghost compact" data-cycle-edit="${cycle.id}">Edit</button>
                </div>
              </article>`
            }).join(''):'<p class="empty">No cycles yet.</p>'}
          </div>
        </section>
      </dialog>

      <dialog id="cycle-detail-modal" class="cycle-detail-modal">
        <section class="cycle-detail-shell">
          <div class="panel-head">
            <div><span class="kicker">CYCLE PROGRESS</span><h3 id="cycle-detail-title">Cycle</h3></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div id="cycle-detail-body"><p class="empty">Loading…</p></div>
        </section>
      </dialog>

      <dialog id="cycle-edit-modal">
        <form id="cycle-form">
          <div class="panel-head"><div><span class="kicker">CYCLE</span><h3 id="cycle-title">New cycle</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="cycle-id" type="hidden">
          <label>Name<input id="cycle-name" required maxlength="120" placeholder="e.g. 12-week cycle"></label>
          <div class="split"><label>Start date<input id="cycle-start" type="date" required></label><label>End date<input id="cycle-end" type="date"></label></div>
          <label>Status<select id="cycle-status"><option value="planned">Planned</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option></select></label>
          <fieldset class="cycle-items-fieldset"><legend>Substances in this cycle</legend>
            <div class="cycle-item-picker">${allItemList.map(i=>`<label class="cycle-check"><input type="checkbox" value="${i.id}"><span>${esc(i.name)}</span></label>`).join('')}</div>
          </fieldset>
          <label>Notes<textarea id="cycle-notes" rows="3" placeholder="Optional notes"></textarea></label>
          <div class="cycle-form-actions"><button class="primary" type="submit">Save cycle</button><button class="ghost danger" id="cycle-delete" type="button" hidden>Delete cycle</button></div>
        </form>
      </dialog>

      <dialog id="item-modal">
        <form id="item-form">
          <div class="panel-head"><div><span class="kicker">TRACKER SETUP</span><h3 id="item-title">Add tracked item</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="item-id" type="hidden">
          <label>Name<input id="item-name" required maxlength="120" placeholder="e.g. Vitamin D"></label>
          <label>Category<select id="item-category">
            <option value="anabolic">Anabolic Steroid</option>
            <option value="hormone">Hormone</option>
            <option value="peptide">Peptide</option>
            <option value="glp">GLP</option>
            <option value="medication">Medication</option>
            <option value="vitamin">Vitamin</option>
            <option value="supplement">Supplement</option>
            <option value="injection" disabled>Legacy: Injection</option>
            <option value="other" disabled>Legacy: Other</option>
          </select></label>
          <label>Form<select id="item-form-type">
            <option value="injectable">Injectable</option>
            <option value="oral">Oral</option>
            <option value="suppository">Suppository</option>
            <option value="topical">Topical</option>
          </select></label>
          <div class="split"><label>Dose per administration<input id="item-amount" type="number" min="0" step="any"></label><label>Dose unit<select id="item-unit"><option value="">Select unit</option><option value="mg">mg</option><option value="mL">mL</option><option value="tablet">Tablet</option><option value="tbsp">TBSP</option><option value="tsp">TSP</option></select></label></div>
          <label>Route<select id="item-route">
            <option value="">Select route</option>
            <option value="intramuscular">Intramuscular</option>
            <option value="subcutaneous">Subcutaneous</option>
            <option value="powder">Powder</option>
            <option value="oral">Oral</option>
            <option value="topical">Topical</option>
          </select></label>
          <label>Notes<textarea id="item-notes" rows="3" placeholder="Optional private notes"></textarea></label>
          <button class="primary" type="submit">Save item</button>
        </form>
      </dialog>

      <dialog id="schedule-modal">
        <form id="schedule-form">
          <div class="panel-head"><div><span class="kicker">SCHEDULE</span><h3 id="schedule-title">Add schedule</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="schedule-id" type="hidden">
          <label>Tracked item<select id="schedule-item" required></select></label>
          <label>Frequency<select id="schedule-frequency">
            <option value="daily">Daily</option><option value="weekly">Selected weekdays</option>
            <option value="interval">Every X days</option><option value="as_needed">As needed</option>
          </select></label>
          <label>Time<input id="schedule-time" type="time"></label>
          <div id="weekday-fields" class="weekday-fields">
            ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i)=>`<label class="day-chip"><input type="checkbox" value="${i}"><span>${d}</span></label>`).join('')}
          </div>
          <label id="interval-field">Every how many days?<input id="schedule-interval" type="number" min="1" step="1" value="1"></label>
          <label>Start date<input id="schedule-start" type="date" required></label>
          <div class="schedule-form-actions">
            <button class="primary" type="submit">Save schedule</button>
            <button class="ghost danger" id="disable-schedule" type="button" hidden>Disable schedule</button>
          </div>
        </form>
      </dialog>

      <dialog id="log-modal">
        <form id="log-form">
          <div class="panel-head"><div><span class="kicker" id="log-kicker">QUICK LOG</span><h3 id="log-title">Log item</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="log-id" type="hidden"><input id="log-schedule-id" type="hidden"><input id="log-scheduled-for" type="hidden">
          <label>Tracked item<select id="log-item" required></select></label>
          <div class="split"><label>Amount<input id="log-amount" type="number" min="0" step="any"></label><label>Unit<input id="log-unit" placeholder="mg, mL, tablet"></label></div>
          <div id="category-fields"></div>
          <label>Date & time<input id="log-time" type="datetime-local" required></label>
          <label>Status<select id="log-status"><option value="completed">Completed</option><option value="skipped">Skipped</option></select></label>
          <label>Notes<textarea id="log-notes" rows="3" placeholder="Optional notes"></textarea></label>
          <div class="log-form-actions">
            <button class="primary" type="submit">Save log</button>
            <button class="ghost danger" id="delete-log" type="button" hidden>Delete log</button>
          </div>
        </form>
      </dialog>

      <dialog id="history-modal" class="history-modal">
        <section class="history-shell">
          <div class="panel-head history-head">
            <div><span class="kicker">HISTORY</span><h3>Full timeline</h3><p class="muted">Search, filter, edit, or remove logged activity.</p></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div class="history-filters">
            <label class="history-search">Search<input id="history-search" type="search" placeholder="Item, notes, route, site..."></label>
            <label>Item<select id="history-item"><option value="">All items</option></select></label>
            <label>Category<select id="history-category">
              <option value="">All categories</option>
              <option value="anabolic">Anabolic</option><option value="hormone">Hormone</option>
              <option value="peptide">Peptide</option><option value="glp">GLP</option>
              <option value="medication">Medication</option><option value="vitamin">Vitamin</option>
              <option value="supplement">Supplement</option><option value="injection">Legacy: Injection</option>
              <option value="other">Legacy: Other</option>
            </select></label>
            <label>Status<select id="history-status"><option value="">All statuses</option><option value="completed">Completed</option><option value="skipped">Skipped</option></select></label>
            <label>Injection site<select id="history-site"><option value="">All sites</option></select></label>
            <label>From<input id="history-from" type="date"></label>
            <label>To<input id="history-to" type="date"></label>
            <button class="ghost compact history-clear" id="history-clear" type="button">Clear filters</button>
          </div>
          <div class="history-summary" id="history-summary"></div>
          <div class="history-list" id="history-list"><p class="empty">Loading history…</p></div>
          <button class="ghost history-load-more" id="history-load-more" type="button" hidden>Load older activity</button>
        </section>
      </dialog>

      <dialog id="inventory-modal" class="inventory-modal">
        <section class="inventory-shell">
          <div class="panel-head inventory-head">
            <div><span class="kicker">INVENTORY</span><h3>Manage stock</h3><p class="muted">Track quantity, lot, expiration, and automatic deductions.</p></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div class="inventory-toolbar">
            <button class="primary compact" id="inventory-add" type="button">+ Add inventory</button>
            <span class="muted">${inventoryAlerts.length} active alert${inventoryAlerts.length===1?'':'s'}</span>
          </div>
          <div class="inventory-list" id="inventory-list">
            ${inventoryList.length?inventoryList.map(row=>{
              const low=row.low_threshold!==null && Number(row.quantity)<=Number(row.low_threshold)
              const expired=!!row.expiration_date && row.expiration_date<todayKey
              return `<article class="inventory-card ${low||expired?'inventory-warning':''}">
                <div>
                  <div class="inventory-card-title"><b>${esc(row.tracked_items?.name??'Tracked item')}</b>${low?'<span>LOW</span>':''}${expired?'<span>EXPIRED</span>':''}</div>
                  <strong>${esc(row.quantity)} ${esc(row.unit)} total${row.containers_on_hand!==null?' · '+esc(row.containers_on_hand)+' on hand':''}</strong>
                  ${row.strength_amount!==null && row.strength_unit && row.strength_per_amount!==null && row.strength_per_unit?`<div class="inventory-strength">${esc(row.strength_amount)} ${esc(row.strength_unit)} per ${esc(row.strength_per_amount)} ${esc(row.strength_per_unit)}</div>`:''}
                  <div class="inventory-details">
                    <span>${esc(row.tracked_items?.category==='anabolic'?'Anabolic Steroid':titleCase(row.tracked_items?.category??'other'))}</span>
                    ${row.tracked_items?.route?`<span>${esc(titleCase(row.tracked_items.route))}</span>`:''}
                    ${row.tracked_items?.default_amount!==null && row.tracked_items?.default_amount!==undefined?`<span>${esc(row.tracked_items.default_amount)} ${esc(row.tracked_items.default_unit??'')} / dose</span>`:''}
                    ${(()=>{
                      const weekly=weeklyPlanFor(row.tracked_item_id)
                      return weekly?`<span>${esc(weekly.exact?'':'≈ ')}${esc(weekly.total)} ${esc(weekly.unit)} / week · ${esc(weekly.exact?weekly.occurrences:weekly.occurrences.toFixed(1))} doses</span>`:''
                    })()}
                  </div>
                  <small>${row.lot_number?'Lot '+esc(row.lot_number)+' · ':''}${row.expiration_date?'Expires '+esc(row.expiration_date):'No expiration'}${row.auto_decrement?' · Auto −'+esc(row.decrement_amount??0)+' '+esc(row.unit)+' / completed log':''}</small>
                </div>
                <button class="ghost compact" data-inventory-edit="${row.id}">Edit</button>
              </article>`
            }).join(''):`<p class="empty">No inventory records yet.</p>`}
          </div>
        </section>
      </dialog>

      <dialog id="inventory-edit-modal">
        <form id="inventory-form">
          <div class="panel-head"><div><span class="kicker">INVENTORY</span><h3 id="inventory-title">Add inventory</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="inventory-id" type="hidden">
          <label>Tracked item<select id="inventory-item" required></select></label>
          <div class="split"><label>Total amount on hand<input id="inventory-quantity" type="number" min="0" step="any" required></label><label>Inventory unit<select id="inventory-unit" required><option value="">Select unit</option><option value="mg">mg</option><option value="mL">mL</option><option value="tablet">Tablet</option><option value="tbsp">TBSP</option><option value="tsp">TSP</option><option value="vial">Vial</option></select></label></div>
          <label>Containers / units on hand<input id="inventory-containers" type="number" min="0" step="any" placeholder="e.g. 3 vials"></label>
          <div class="split"><label>Strength amount<input id="inventory-strength-amount" type="number" min="0" step="any" placeholder="e.g. 250"></label><label>Strength unit<select id="inventory-strength-unit"><option value="">Select unit</option><option value="mg">mg</option><option value="mcg">mcg</option><option value="g">g</option><option value="mL">mL</option><option value="tablet">Tablet</option></select></label></div>
          <div class="split"><label>Per amount<input id="inventory-strength-per-amount" type="number" min="0" step="any" placeholder="e.g. 1"></label><label>Per unit<select id="inventory-strength-per-unit"><option value="">Select unit</option><option value="mL">mL</option><option value="tablet">Tablet</option><option value="tbsp">TBSP</option><option value="tsp">TSP</option><option value="vial">Vial</option></select></label></div>
          <div class="split"><label>Low stock threshold<input id="inventory-threshold" type="number" min="0" step="any"></label><label>Expiration date<input id="inventory-expiration" type="date"></label></div>
          <label>Lot number<input id="inventory-lot" maxlength="120" placeholder="Optional"></label>
          <label class="toggle-row"><input id="inventory-auto" type="checkbox"><span>Auto-decrement on completed logs</span></label>
          <label id="inventory-decrement-wrap">Deduct per completed log<input id="inventory-decrement" type="number" min="0" step="any" value="1"></label>
          <div class="inventory-form-actions">
            <button class="primary" type="submit">Save inventory</button>
            <button class="ghost danger" id="inventory-delete" type="button" hidden>Delete inventory</button>
          </div>
        </form>
      </dialog>
    </main>`

  document.querySelector('#signout')!.addEventListener('click',async()=>{await supabase.auth.signOut();renderAuth()})
  document.querySelector('#toggle-archive')!.addEventListener('click',()=>renderDashboard(userId,email,!showArchived))

  const fetchAllRows=async(table:string,select='*')=>{
    const rows:any[]=[]
    const pageSize=1000
    for(let offset=0;;offset+=pageSize){
      const {data,error}=await supabase.from(table).select(select).eq('user_id',userId).range(offset,offset+pageSize-1)
      if(error) throw error
      rows.push(...(data??[]))
      if((data??[]).length<pageSize) break
    }
    return rows
  }

  const openSettings=async()=>{
    const push=await hasBackgroundPush()
    document.querySelector<HTMLElement>('#settings-push-status')!.textContent=push?'Background push enabled':'Not enabled on this device'
    const installButton=document.querySelector<HTMLButtonElement>('#settings-install')!
    const standalone=window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone===true
    installButton.textContent=standalone?'PULSE is installed':'Install / Add PULSE to Home Screen'
    installButton.disabled=standalone
    settingsModal.showModal()
  }
  document.querySelector('#open-settings')!.addEventListener('click',openSettings)

  document.querySelector('#settings-export')!.addEventListener('click',async()=>{
    const button=document.querySelector<HTMLButtonElement>('#settings-export')!
    button.disabled=true
    button.textContent='Preparing export…'
    try{
      const [exportItems,exportSchedules,exportLogs,exportInventory,exportCycles,exportCycleItems,exportPrefs]=await Promise.all([
        fetchAllRows('tracked_items'),fetchAllRows('schedules'),fetchAllRows('logs'),
        fetchAllRows('inventory'),fetchAllRows('cycles'),fetchAllRows('cycle_items'),
        fetchAllRows('notification_preferences')
      ])
      const payload={
        exported_at:new Date().toISOString(),
        version:'0.9.0-beta',
        tracked_items:exportItems,
        schedules:exportSchedules,
        logs:exportLogs,
        inventory:exportInventory,
        cycles:exportCycles,
        cycle_items:exportCycleItems,
        notification_preferences:exportPrefs
      }
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})
      const url=URL.createObjectURL(blob)
      const anchor=document.createElement('a')
      anchor.href=url
      anchor.download=`pulse-export-${dateKey(new Date())}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      button.textContent='Export complete'
    }catch(error:any){
      button.disabled=false
      button.textContent='Export my PULSE data'
      alert(error?.message||'Unable to export PULSE data.')
    }
  })

  document.querySelector('#settings-reset-password')!.addEventListener('click',async()=>{
    const redirectTo=new URL(import.meta.env.BASE_URL,window.location.origin).toString()
    const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo})
    if(error) return alert(error.message)
    alert('Password reset email sent.')
  })

  document.querySelector('#settings-install')!.addEventListener('click',async()=>{
    if(deferredInstallPrompt){
      await deferredInstallPrompt.prompt()
      deferredInstallPrompt=null
      return
    }
    const isiOS=/iphone|ipad|ipod/i.test(navigator.userAgent)
    alert(isiOS?'On iPhone/iPad: open PULSE in Safari, tap Share, then choose Add to Home Screen.':'Use your browser menu and choose Install app or Add to Home screen.')
  })

  document.querySelector('#settings-delete-data')!.addEventListener('click',async()=>{
    const confirmation=prompt('This permanently deletes your PULSE tracking data but keeps your account. Type DELETE to continue.')
    if(confirmation!=='DELETE') return
    const tables=['push_subscriptions','cycle_items','cycles','logs','schedules','inventory','tracked_items','notification_preferences']
    for(const table of tables){
      const {error}=await supabase.from(table).delete().eq('user_id',userId)
      if(error) return alert(`Could not delete ${table}: ${error.message}`)
    }
    settingsModal.close()
    await renderDashboard(userId,email,false)
    alert('Your PULSE tracking data was deleted. Your login account remains active.')
  })

  const settingsModal=document.querySelector<HTMLDialogElement>('#settings-modal')!
  const substanceDetailModal=document.querySelector<HTMLDialogElement>('#substance-detail-modal')!
  const reminderModal=document.querySelector<HTMLDialogElement>('#reminder-modal')!
  const cycleModal=document.querySelector<HTMLDialogElement>('#cycle-modal')!
  const cycleDetailModal=document.querySelector<HTMLDialogElement>('#cycle-detail-modal')!
  const cycleEditModal=document.querySelector<HTMLDialogElement>('#cycle-edit-modal')!
  const itemModal=document.querySelector<HTMLDialogElement>('#item-modal')!
  const scheduleModal=document.querySelector<HTMLDialogElement>('#schedule-modal')!
  const logModal=document.querySelector<HTMLDialogElement>('#log-modal')!
  const historyModal=document.querySelector<HTMLDialogElement>('#history-modal')!
  const inventoryModal=document.querySelector<HTMLDialogElement>('#inventory-modal')!
  const inventoryEditModal=document.querySelector<HTMLDialogElement>('#inventory-edit-modal')!
  let historyLogs:Log[]=[]
  let historyOffset=0
  let historyHasMore=true
  const historyPageSize=100
  document.querySelectorAll<HTMLButtonElement>('.modal-close').forEach(btn=>btn.addEventListener('click',()=>{ const dialog=btn.closest('dialog') as HTMLDialogElement|null; dialog?.close() }))

  const openItem=(item?:Item)=>{
    document.querySelector<HTMLHeadingElement>('#item-title')!.textContent=item?'Edit tracked item':'Add tracked item'
    document.querySelector<HTMLInputElement>('#item-id')!.value=item?.id??''
    document.querySelector<HTMLInputElement>('#item-name')!.value=item?.name??''
    document.querySelector<HTMLSelectElement>('#item-category')!.value=item?.category??'peptide'
    document.querySelector<HTMLSelectElement>('#item-form-type')!.value=item?.form??'injectable'
    document.querySelector<HTMLInputElement>('#item-amount')!.value=item?.default_amount?.toString()??''
    document.querySelector<HTMLSelectElement>('#item-unit')!.value=item?.default_unit??''
    document.querySelector<HTMLSelectElement>('#item-route')!.value=item?.route??''
    document.querySelector<HTMLTextAreaElement>('#item-notes')!.value=item?.notes??''
    itemModal.showModal()
  }

  const updateScheduleFields=()=>{
    const frequency=document.querySelector<HTMLSelectElement>('#schedule-frequency')!.value
    document.querySelector<HTMLElement>('#weekday-fields')!.hidden=frequency!=='weekly'
    document.querySelector<HTMLElement>('#interval-field')!.hidden=frequency!=='interval'
  }

  const openSchedule=(item?:Item,schedule?:Schedule)=>{
    const select=document.querySelector<HTMLSelectElement>('#schedule-item')!
    const activeItems=showArchived?[]:itemList
    select.innerHTML=activeItems.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    const chosen=item?.id??schedule?.tracked_item_id??activeItems[0]?.id??''
    select.value=chosen
    document.querySelector<HTMLInputElement>('#schedule-id')!.value=schedule?.id??''
    document.querySelector<HTMLHeadingElement>('#schedule-title')!.textContent=schedule?'Edit schedule':'Add schedule'
    document.querySelector<HTMLSelectElement>('#schedule-frequency')!.value=schedule?.frequency??'daily'
    document.querySelector<HTMLInputElement>('#schedule-time')!.value=schedule?.scheduled_time?.slice(0,5)??''
    document.querySelector<HTMLInputElement>('#schedule-interval')!.value=String(schedule?.interval_days??1)
    document.querySelector<HTMLInputElement>('#schedule-start')!.value=schedule?.start_date??dateKey(new Date())
    const days=schedule?.days_of_week??[]
    document.querySelectorAll<HTMLInputElement>('#weekday-fields input[type="checkbox"]').forEach(cb=>cb.checked=days.includes(Number(cb.value)))
    document.querySelector<HTMLButtonElement>('#disable-schedule')!.hidden=!schedule
    updateScheduleFields()
    scheduleModal.showModal()
  }

  const fillLog=(item:Item,schedule?:Schedule,existing?:Log)=>{
    const select=document.querySelector<HTMLSelectElement>('#log-item')!
    const available=existing?allItemList:itemList
    select.innerHTML=available.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    select.value=item.id
    select.disabled=!!existing
    document.querySelector<HTMLInputElement>('#log-id')!.value=existing?.id??''
    document.querySelector<HTMLHeadingElement>('#log-title')!.textContent=existing?`Edit ${item.name}`:`Log ${item.name}`
    document.querySelector<HTMLElement>('#log-kicker')!.textContent=existing?'EDIT LOG':titleCase(item.category)
    document.querySelector<HTMLInputElement>('#log-amount')!.value=(existing?.amount??item.default_amount)?.toString()??''
    document.querySelector<HTMLInputElement>('#log-unit')!.value=existing?.unit??item.default_unit??''
    document.querySelector<HTMLInputElement>('#log-time')!.value=existing?localInputValue(new Date(existing.logged_at)):localInputValue()
    document.querySelector<HTMLSelectElement>('#log-status')!.value=existing?.status??'completed'
    document.querySelector<HTMLTextAreaElement>('#log-notes')!.value=existing?.notes??''
    document.querySelector<HTMLInputElement>('#log-schedule-id')!.value=existing?.schedule_id??schedule?.id??''
    document.querySelector<HTMLInputElement>('#log-scheduled-for')!.value=existing?.scheduled_for??(schedule?occurrenceDate(schedule,today).toISOString():'')
    if(schedule && !existing) document.querySelector<HTMLInputElement>('#log-time')!.value=localInputValue(occurrenceDate(schedule,today))
    document.querySelector<HTMLElement>('#category-fields')!.innerHTML=categoryFields(item)
    const route=document.querySelector<HTMLSelectElement>('#log-route')
    if(route && existing?.route) route.value=existing.route
    const site=document.querySelector<HTMLSelectElement>('#log-site')
    if(site && existing?.injection_site) site.value=existing.injection_site
    document.querySelector<HTMLButtonElement>('#delete-log')!.hidden=!existing
  }

  const openLog=(item:Item,schedule?:Schedule,existing?:Log)=>{ fillLog(item,schedule,existing); logModal.showModal() }

  const openSubstanceDetail=async(item:Item)=>{
    document.querySelector<HTMLElement>('#substance-detail-kicker')!.textContent=item.category==='anabolic'?'ANABOLIC STEROID':titleCase(item.category)
    document.querySelector<HTMLElement>('#substance-detail-title')!.textContent=item.name
    const body=document.querySelector<HTMLElement>('#substance-detail-body')!
    body.innerHTML='<p class="empty">Loading substance details…</p>'
    substanceDetailModal.showModal()

    const {data:detailLogs,error}=await supabase.from('logs')
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for')
      .eq('user_id',userId).eq('tracked_item_id',item.id)
      .order('logged_at',{ascending:false}).limit(50)
    if(error){
      body.innerHTML=`<div class="notice">${esc(error.message)}</div>`
      return
    }

    const itemSchedules=scheduleList.filter(s=>s.tracked_item_id===item.id && s.active)
    const stock=inventoryByItem.get(item.id)
    const weekly=weeklyPlanFor(item.id)
    const supply=supplyFor(item)
    const next=nextDoseFor(item.id)
    const adh7=adherenceForItem(item.id,7)
    const adh30=adherenceForItem(item.id,30)
    const logs=(detailLogs??[]) as Log[]
    const lastCompleted=logs.find(l=>l.status==='completed')??null
    const cycleMemberships=cycleItemList
      .filter(ci=>ci.tracked_item_id===item.id)
      .map(ci=>cycleList.find(cycle=>cycle.id===ci.cycle_id))
      .filter((cycle):cycle is Cycle=>!!cycle)
    const siteHistory=[...new Set(logs.map(l=>l.injection_site).filter((site):site is string=>!!site))].slice(0,8)
    const concentration=stock?.strength_amount!==null && stock?.strength_amount!==undefined && stock.strength_unit && stock.strength_per_amount!==null && stock.strength_per_unit
      ? `${stock.strength_amount} ${stock.strength_unit} per ${stock.strength_per_amount} ${stock.strength_per_unit}`
      : null

    body.innerHTML=`
      <div class="substance-detail-actions">
        <button class="primary compact" id="detail-log-dose">Log dose</button>
        <button class="ghost compact" id="detail-edit-item">Edit substance</button>
        <button class="ghost compact" id="detail-edit-schedule">${itemSchedules.length?'Edit schedule':'Add schedule'}</button>
        <button class="ghost compact" id="detail-edit-inventory">${stock?'Adjust inventory':'Add inventory'}</button>
      </div>

      <div class="detail-grid">
        <article class="detail-card"><span>DOSE</span><strong>${item.default_amount??'—'} ${esc(item.default_unit??'')}</strong><small>${item.route?esc(titleCase(item.route)):'No route set'}${item.form?' · '+esc(titleCase(item.form)):''}</small></article>
        <article class="detail-card"><span>WEEKLY TOTAL</span><strong>${weekly?`${weekly.exact?'':'≈ '}${Number(weekly.total.toFixed(2))} ${esc(weekly.unit)}`:'—'}</strong><small>${weekly?`${weekly.exact?weekly.occurrences:Number(weekly.occurrences.toFixed(1))} scheduled doses/week`:'No recurring schedule'}</small></article>
        <article class="detail-card"><span>NEXT DOSE</span><strong>${next?esc(next.when.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})):'—'}</strong><small>${next?(next.schedule.scheduled_time?esc(next.when.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})):'Any time'):'No upcoming scheduled dose'}</small></article>
        <article class="detail-card"><span>LAST DOSE</span><strong>${lastCompleted?esc(new Date(lastCompleted.logged_at).toLocaleDateString(undefined,{month:'short',day:'numeric'})):'—'}</strong><small>${lastCompleted?`${lastCompleted.amount??'—'} ${esc(lastCompleted.unit??'')}`:'No completed dose yet'}</small></article>
      </div>

      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">ADHERENCE</span><h4>Scheduled-dose performance</h4></div></div>
        <div class="detail-grid detail-grid-small">
          <article class="detail-card"><span>7 DAYS</span><strong>${adh7.percent===null?'—':adh7.percent+'%'}</strong><small>${adh7.completed}/${adh7.expected} expected doses completed</small></article>
          <article class="detail-card"><span>30 DAYS</span><strong>${adh30.percent===null?'—':adh30.percent+'%'}</strong><small>${adh30.completed}/${adh30.expected} expected doses completed</small></article>
        </div>
      </section>

      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">INVENTORY</span><h4>Supply intelligence</h4></div></div>
        ${stock?`
          <div class="detail-stock">
            <div><span>ON HAND</span><strong>${esc(stock.quantity)} ${esc(stock.unit)}</strong><small>${stock.containers_on_hand!==null?`${esc(stock.containers_on_hand)} container/unit(s) · `:''}${concentration?esc(concentration):'No concentration set'}</small></div>
            <div><span>EST. DOSES LEFT</span><strong>${supply?Math.floor(supply.doses):'—'}</strong><small>${supply?'Calculated from '+esc(supply.basis):'Units/concentration do not support a safe conversion'}</small></div>
            <div><span>EST. SUPPLY</span><strong>${supply?.daysRemaining!==null && supply?.daysRemaining!==undefined?Math.floor(supply.daysRemaining)+' days':'—'}</strong><small>${supply?.depletionDate?'Approx. through '+esc(supply.depletionDate.toLocaleDateString()):'Recurring schedule required'}</small></div>
            <div><span>LOW STOCK</span><strong>${stock.low_threshold!==null?esc(stock.low_threshold)+' '+esc(stock.unit):'Not set'}</strong><small>${stock.expiration_date?'Expires '+esc(stock.expiration_date):'No expiration set'}</small></div>
          </div>
        `:'<p class="empty">No inventory record for this substance.</p>'}
      </section>

      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">CYCLES</span><h4>Cycle membership</h4></div></div>
        ${cycleMemberships.length?`<div class="detail-chip-row">${cycleMemberships.map(cycle=>`<span>${esc(cycle.name)} · ${esc(titleCase(cycle.status))}</span>`).join('')}</div>`:'<p class="empty">Not assigned to a cycle.</p>'}
      </section>

      ${item.form==='injectable' || item.category==='injection'?`
      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">INJECTION HISTORY</span><h4>Recent sites used</h4></div></div>
        ${siteHistory.length?`<div class="detail-chip-row">${siteHistory.map(site=>`<span>${esc(site)}</span>`).join('')}</div>`:'<p class="empty">No injection sites logged yet.</p>'}
      </section>`:''}

      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">RECENT HISTORY</span><h4>Latest activity</h4></div></div>
        <div class="detail-history">
          ${logs.length?logs.slice(0,8).map(log=>`<div class="detail-history-row">
            <span><b>${esc(titleCase(log.status))}</b><small>${esc(new Date(log.logged_at).toLocaleString())}${log.injection_site?' · '+esc(log.injection_site):''}</small></span>
            <strong>${log.amount??'—'} ${esc(log.unit??'')}</strong>
          </div>`).join(''):'<p class="empty">No history yet.</p>'}
        </div>
      </section>
    `

    document.querySelector('#detail-log-dose')!.addEventListener('click',()=>{ substanceDetailModal.close(); openLog(item) })
    document.querySelector('#detail-edit-item')!.addEventListener('click',()=>{ substanceDetailModal.close(); openItem(item) })
    document.querySelector('#detail-edit-schedule')!.addEventListener('click',()=>{ substanceDetailModal.close(); openSchedule(item,itemSchedules[0]) })
    document.querySelector('#detail-edit-inventory')!.addEventListener('click',()=>{ substanceDetailModal.close(); openInventoryEditor(stock) })
  }

  const showBrowserNotification=(key:string,title:string,body:string)=>{
    if(!('Notification' in window) || Notification.permission!=='granted') return
    if(sessionStorage.getItem(key)) return
    sessionStorage.setItem(key,'1')
    new Notification(title,{body,icon:pulseLogoUrl})
  }

  const checkReminders=()=>{
    const now=Date.now()
    if(reminderPrefs.dose_reminders_enabled){
      dueToday.filter(x=>!x.status && x.schedule.scheduled_time && x.when.getTime()>=now && x.when.getTime()-now<=reminderPrefs.reminder_lead_minutes*60000)
        .forEach(x=>showBrowserNotification(
          'pulse-reminder-'+x.schedule.id+'-'+dateKey(today),
          'PULSE · Dose due soon',
          `${x.schedule.tracked_items?.name??'Scheduled dose'} is due ${x.schedule.scheduled_time?x.when.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'today'}.`
        ))
    }
    if(reminderPrefs.overdue_reminders_enabled){
      dueToday.filter(x=>!x.status && !!x.schedule.scheduled_time && x.when.getTime()<now)
        .forEach(x=>showBrowserNotification(
          'pulse-overdue-'+x.schedule.id+'-'+dateKey(today),
          'PULSE · Dose overdue',
          `${x.schedule.tracked_items?.name??'Scheduled dose'} is overdue.`
        ))
    }
    if(reminderPrefs.low_stock_notifications_enabled && inventoryAlerts.length){
      showBrowserNotification(
        'pulse-inventory-alert-'+dateKey(today),
        'PULSE · Inventory alert',
        `${inventoryAlerts.length} item${inventoryAlerts.length===1?'':'s'} need inventory attention.`
      )
    }
  }
  checkReminders()
  if(reminderTimer) window.clearInterval(reminderTimer)
  reminderTimer=window.setInterval(checkReminders,60000)

  const openReminders=async()=>{
    document.querySelector<HTMLInputElement>('#reminder-dose-enabled')!.checked=reminderPrefs.dose_reminders_enabled
    document.querySelector<HTMLSelectElement>('#reminder-lead')!.value=String(reminderPrefs.reminder_lead_minutes)
    document.querySelector<HTMLInputElement>('#reminder-overdue-enabled')!.checked=reminderPrefs.overdue_reminders_enabled
    document.querySelector<HTMLInputElement>('#reminder-low-stock-enabled')!.checked=reminderPrefs.low_stock_notifications_enabled
    const button=document.querySelector<HTMLButtonElement>('#enable-browser-notifications')!
    const subscribed=await hasBackgroundPush()
    button.textContent=!('Notification' in window)?'Notifications unavailable':subscribed?'Background push enabled':Notification.permission==='denied'?'Notifications blocked':'Enable background push'
    button.disabled=!('Notification' in window) || Notification.permission==='denied' || subscribed
    reminderModal.showModal()
  }
  document.querySelector('#open-reminders')!.addEventListener('click',openReminders)
  document.querySelector('#enable-browser-notifications')!.addEventListener('click',async()=>{
    const button=document.querySelector<HTMLButtonElement>('#enable-browser-notifications')!
    button.disabled=true
    button.textContent='Enabling background push…'
    try{
      await ensureBackgroundPush(userId)
      button.textContent='Background push enabled'
    }catch(error:any){
      button.disabled=false
      button.textContent='Enable background push'
      alert(error?.message||'Unable to enable background push.')
    }
  })
  document.querySelector('#reminder-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const payload={
      user_id:userId,
      dose_reminders_enabled:document.querySelector<HTMLInputElement>('#reminder-dose-enabled')!.checked,
      reminder_lead_minutes:Number(document.querySelector<HTMLSelectElement>('#reminder-lead')!.value),
      overdue_reminders_enabled:document.querySelector<HTMLInputElement>('#reminder-overdue-enabled')!.checked,
      low_stock_notifications_enabled:document.querySelector<HTMLInputElement>('#reminder-low-stock-enabled')!.checked,
      updated_at:new Date().toISOString()
    }
    const {error}=await supabase.from('notification_preferences').upsert(payload,{onConflict:'user_id'})
    if(error) return alert(error.message)
    reminderModal.close()
    renderDashboard(userId,email,showArchived)
  })

  const openCycleDetail=(cycle:Cycle)=>{
    document.querySelector<HTMLElement>('#cycle-detail-title')!.textContent=cycle.name
    const body=document.querySelector<HTMLElement>('#cycle-detail-body')!
    const memberIds=cycleItemList.filter(ci=>ci.cycle_id===cycle.id).map(ci=>ci.tracked_item_id)
    const members=memberIds.map(id=>allItemList.find(i=>i.id===id)).filter((i):i is Item=>!!i)
    const start=new Date(cycle.start_date+'T00:00:00')
    const end=cycle.end_date?new Date(cycle.end_date+'T23:59:59'):null
    const now=today
    const elapsedDays=Math.max(0,Math.floor((startOfDay(now).getTime()-startOfDay(start).getTime())/86400000)+1)
    const totalDays=end?Math.max(1,Math.floor((startOfDay(end).getTime()-startOfDay(start).getTime())/86400000)+1):null
    const daysRemaining=end?Math.max(0,Math.ceil((startOfDay(end).getTime()-startOfDay(now).getTime())/86400000)):null
    const progress=totalDays?Math.min(100,Math.max(0,Math.round(elapsedDays/totalDays*100))):null

    let expected=0
    let completed=0
    let skipped=0
    let missed=0
    const cycleEndForCalc=end && end<now?end:now
    for(const schedule of scheduleList.filter(s=>memberIds.includes(s.tracked_item_id) && s.active)){
      const scheduleStart=new Date(schedule.start_date+'T00:00:00')
      const from=startOfDay(scheduleStart>start?scheduleStart:start)
      for(let d=new Date(from);d<=cycleEndForCalc;d=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)){
        if(!scheduleDueOn(schedule,d)) continue
        const when=occurrenceDate(schedule,d)
        if(when>cycleEndForCalc) continue
        expected++
        const log=cycleLogList.find(l=>
          l.schedule_id===schedule.id &&
          !!l.scheduled_for &&
          dateKey(new Date(l.scheduled_for))===dateKey(when)
        )
        if(log?.status==='completed') completed++
        else if(log?.status==='skipped') skipped++
        else missed++
      }
    }
    const adherence=expected?Math.round(completed/expected*100):null

    const memberCards=members.map(item=>{
      const stock=inventoryByItem.get(item.id)
      const weekly=weeklyPlanFor(item.id)
      const next=nextDoseFor(item.id)
      const itemLogs=cycleLogList.filter(l=>l.tracked_item_id===item.id && new Date(l.logged_at)>=start && (!end || new Date(l.logged_at)<=end))
      const itemCompleted=itemLogs.filter(l=>l.status==='completed').length
      const itemSkipped=itemLogs.filter(l=>l.status==='skipped').length
      return `<article class="cycle-member-card">
        <div class="cycle-member-main">
          <div><b>${esc(item.name)}</b><small>${esc(item.category==='anabolic'?'Anabolic Steroid':titleCase(item.category))}${item.route?' · '+esc(titleCase(item.route)):''}</small></div>
          <div class="cycle-member-meta">
            <span>${item.default_amount??'—'} ${esc(item.default_unit??'')} / dose</span>
            ${weekly?`<span>${weekly.exact?'':'≈ '}${Number(weekly.total.toFixed(2))} ${esc(weekly.unit)} / week</span>`:''}
            ${stock?`<span>${esc(stock.quantity)} ${esc(stock.unit)} on hand</span>`:''}
            <span>${itemCompleted} completed · ${itemSkipped} skipped</span>
            ${next?`<span>Next ${esc(next.when.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</span>`:''}
          </div>
        </div>
        <button class="ghost compact" data-cycle-member-detail="${item.id}">Substance details</button>
      </article>`
    }).join('')

    body.innerHTML=`
      <div class="cycle-detail-actions">
        <button class="primary compact" id="cycle-detail-edit">Edit cycle</button>
      </div>
      <div class="cycle-detail-stats">
        <article><span>STATUS</span><strong>${esc(titleCase(cycle.status))}</strong><small>${esc(cycle.start_date)}${cycle.end_date?' → '+esc(cycle.end_date):' → ongoing'}</small></article>
        <article><span>PROGRESS</span><strong>${progress===null?'Ongoing':progress+'%'}</strong><small>${totalDays===null?elapsedDays+' days elapsed':elapsedDays+' / '+totalDays+' days'}</small></article>
        <article><span>DAYS REMAINING</span><strong>${daysRemaining===null?'—':daysRemaining}</strong><small>${cycle.end_date?'Through '+esc(cycle.end_date):'No end date set'}</small></article>
        <article><span>ADHERENCE</span><strong>${adherence===null?'—':adherence+'%'}</strong><small>${completed}/${expected} expected doses completed</small></article>
      </div>
      ${progress!==null?`<div class="cycle-progress-track cycle-detail-progress"><span style="width:${progress}%"></span></div>`:''}
      <div class="cycle-dose-summary">
        <span><b>${expected}</b> expected</span>
        <span><b>${completed}</b> completed</span>
        <span><b>${skipped}</b> skipped</span>
        <span><b>${missed}</b> missed</span>
      </div>
      <section class="detail-section">
        <div class="panel-head"><div><span class="kicker">SUBSTANCES</span><h4>${members.length} in this cycle</h4></div></div>
        <div class="cycle-member-list">${memberCards||'<p class="empty">No substances assigned to this cycle.</p>'}</div>
      </section>
      ${cycle.notes?`<section class="detail-section"><div class="panel-head"><div><span class="kicker">NOTES</span><h4>Cycle notes</h4></div></div><p class="cycle-notes">${esc(cycle.notes)}</p></section>`:''}
    `

    document.querySelector('#cycle-detail-edit')!.addEventListener('click',()=>{ cycleDetailModal.close(); openCycleEditor(cycle) })
    document.querySelectorAll<HTMLButtonElement>('[data-cycle-member-detail]').forEach(btn=>btn.addEventListener('click',()=>{
      const item=allItemList.find(i=>i.id===btn.dataset.cycleMemberDetail)
      if(item){ cycleDetailModal.close(); cycleModal.close(); openSubstanceDetail(item) }
    }))
  }

  const openCycleEditor=(cycle?:Cycle)=>{
    document.querySelector<HTMLInputElement>('#cycle-id')!.value=cycle?.id??''
    document.querySelector<HTMLHeadingElement>('#cycle-title')!.textContent=cycle?'Edit cycle':'New cycle'
    document.querySelector<HTMLInputElement>('#cycle-name')!.value=cycle?.name??''
    document.querySelector<HTMLInputElement>('#cycle-start')!.value=cycle?.start_date??dateKey(today)
    document.querySelector<HTMLInputElement>('#cycle-end')!.value=cycle?.end_date??''
    document.querySelector<HTMLSelectElement>('#cycle-status')!.value=cycle?.status??'planned'
    document.querySelector<HTMLTextAreaElement>('#cycle-notes')!.value=cycle?.notes??''
    const selected=new Set(cycleItemList.filter(ci=>ci.cycle_id===cycle?.id).map(ci=>ci.tracked_item_id))
    document.querySelectorAll<HTMLInputElement>('.cycle-item-picker input').forEach(cb=>cb.checked=selected.has(cb.value))
    document.querySelector<HTMLButtonElement>('#cycle-delete')!.hidden=!cycle
    cycleEditModal.showModal()
  }

  const openCycles=()=>cycleModal.showModal()
  document.querySelector('#open-cycles')!.addEventListener('click',openCycles)
  document.querySelector('#open-cycles-secondary')?.addEventListener('click',openCycles)
  document.querySelector('#active-cycle-details')?.addEventListener('click',()=>{ if(activeCycle) openCycleDetail(activeCycle) })
  document.querySelector('#cycle-add')!.addEventListener('click',()=>openCycleEditor())
  document.querySelectorAll<HTMLButtonElement>('[data-cycle-details]').forEach(btn=>btn.addEventListener('click',()=>{
    const cycle=cycleList.find(c=>c.id===btn.dataset.cycleDetails)
    if(cycle) openCycleDetail(cycle)
  }))
  document.querySelectorAll<HTMLButtonElement>('[data-cycle-edit]').forEach(btn=>btn.addEventListener('click',()=>{
    const cycle=cycleList.find(c=>c.id===btn.dataset.cycleEdit)
    if(cycle) openCycleEditor(cycle)
  }))

  document.querySelector('#cycle-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const id=document.querySelector<HTMLInputElement>('#cycle-id')!.value
    const name=document.querySelector<HTMLInputElement>('#cycle-name')!.value.trim()
    const start_date=document.querySelector<HTMLInputElement>('#cycle-start')!.value
    const end_date=document.querySelector<HTMLInputElement>('#cycle-end')!.value||null
    const status=document.querySelector<HTMLSelectElement>('#cycle-status')!.value
    const notes=document.querySelector<HTMLTextAreaElement>('#cycle-notes')!.value.trim()||null
    const selected=Array.from(document.querySelectorAll<HTMLInputElement>('.cycle-item-picker input:checked')).map(cb=>cb.value)
    const payload={name,start_date,end_date,status,notes,updated_at:new Date().toISOString()}
    let cycleId=id
    if(id){
      const {error}=await supabase.from('cycles').update(payload).eq('id',id).eq('user_id',userId)
      if(error) return alert(error.message)
    }else{
      const {data,error}=await supabase.from('cycles').insert({user_id:userId,...payload}).select('id').single()
      if(error) return alert(error.message)
      cycleId=data.id
    }
    const {error:deleteLinksError}=await supabase.from('cycle_items').delete().eq('cycle_id',cycleId).eq('user_id',userId)
    if(deleteLinksError) return alert(deleteLinksError.message)
    if(selected.length){
      const {error:linkError}=await supabase.from('cycle_items').insert(selected.map(tracked_item_id=>({user_id:userId,cycle_id:cycleId,tracked_item_id})))
      if(linkError) return alert(linkError.message)
    }
    cycleEditModal.close(); cycleModal.close(); renderDashboard(userId,email,showArchived)
  })

  document.querySelector('#cycle-delete')!.addEventListener('click',async()=>{
    const id=document.querySelector<HTMLInputElement>('#cycle-id')!.value
    if(!id || !confirm('Delete this cycle? Your dose history will remain.')) return
    const {error}=await supabase.from('cycles').delete().eq('id',id).eq('user_id',userId)
    if(error) return alert(error.message)
    cycleEditModal.close(); cycleModal.close(); renderDashboard(userId,email,showArchived)
  })

  const historyFilterValues=()=>({
    search:document.querySelector<HTMLInputElement>('#history-search')!.value.trim().toLowerCase(),
    item:document.querySelector<HTMLSelectElement>('#history-item')!.value,
    category:document.querySelector<HTMLSelectElement>('#history-category')!.value,
    status:document.querySelector<HTMLSelectElement>('#history-status')!.value,
    site:document.querySelector<HTMLSelectElement>('#history-site')!.value,
    from:document.querySelector<HTMLInputElement>('#history-from')!.value,
    to:document.querySelector<HTMLInputElement>('#history-to')!.value
  })

  const renderHistoryRows=()=>{
    const f=historyFilterValues()
    const filtered=historyLogs.filter(log=>{
      const item=log.tracked_items
      const haystack=[item?.name,log.notes,log.route,log.injection_site,log.unit].filter(Boolean).join(' ').toLowerCase()
      if(f.search && !haystack.includes(f.search)) return false
      if(f.item && log.tracked_item_id!==f.item) return false
      if(f.category && item?.category!==f.category) return false
      if(f.status && log.status!==f.status) return false
      if(f.site && log.injection_site!==f.site) return false
      const d=dateKey(new Date(log.logged_at))
      if(f.from && d<f.from) return false
      if(f.to && d>f.to) return false
      return true
    })
    document.querySelector<HTMLElement>('#history-summary')!.textContent=`${filtered.length} matching · ${historyLogs.length} loaded${historyHasMore?' · more available':''}`
    document.querySelector<HTMLElement>('#history-list')!.innerHTML=filtered.length?filtered.map(log=>`
      <article class="history-entry">
        <div class="history-entry-main">
          <div class="history-entry-title">
            <b>${esc(log.tracked_items?.name??'Tracked item')}</b>
            <span class="status-pill ${esc(log.status)}">${esc(titleCase(log.status))}</span>
          </div>
          <small>${new Date(log.logged_at).toLocaleString()} · ${esc(titleCase(log.tracked_items?.category??'other'))}${log.schedule_id?' · Scheduled':' · Manual'}</small>
          <div class="history-meta">
            ${log.amount!==null?`<span>${esc(log.amount)} ${esc(log.unit??'')}</span>`:''}
            ${log.route?`<span>${esc(titleCase(log.route))}</span>`:''}
            ${log.injection_site?`<span>${esc(log.injection_site)}</span>`:''}
          </div>
          ${log.notes?`<p>${esc(log.notes)}</p>`:''}
        </div>
        <button class="ghost compact" data-history-edit="${log.id}">Edit</button>
      </article>`).join(''):'<p class="empty">No logs match these filters.</p>'
    document.querySelectorAll<HTMLButtonElement>('[data-history-edit]').forEach(btn=>btn.addEventListener('click',()=>{
      const log=historyLogs.find(l=>l.id===btn.dataset.historyEdit)
      const item=allItemList.find(i=>i.id===log?.tracked_item_id)
      if(log && item) openLog(item,undefined,log)
    }))
  }

  const loadHistoryPage=async(reset=false)=>{
    const list=document.querySelector<HTMLElement>('#history-list')!
    const loadMore=document.querySelector<HTMLButtonElement>('#history-load-more')!
    if(reset){
      historyOffset=0
      historyHasMore=true
      historyLogs=[]
      list.innerHTML='<p class="empty">Loading history…</p>'
    }
    if(!historyHasMore) return
    loadMore.disabled=true
    const {data,error}=await supabase.from('logs')
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category,form)')
      .eq('user_id',userId).order('logged_at',{ascending:false})
      .range(historyOffset,historyOffset+historyPageSize-1)
    if(error){
      list.innerHTML=`<div class="notice">${esc(error.message)}</div>`
      loadMore.disabled=false
      return
    }
    const page=(data??[]) as unknown as Log[]
    historyLogs.push(...page)
    historyOffset+=page.length
    historyHasMore=page.length===historyPageSize
    loadMore.hidden=!historyHasMore
    loadMore.disabled=false
    const sites=[...new Set(historyLogs.map(l=>l.injection_site).filter((v):v is string=>!!v))].sort()
    const siteSelect=document.querySelector<HTMLSelectElement>('#history-site')!
    const selected=siteSelect.value
    siteSelect.innerHTML='<option value="">All sites</option>'+sites.map(s=>`<option>${esc(s)}</option>`).join('')
    siteSelect.value=selected
    renderHistoryRows()
  }

  const refreshHistory=()=>loadHistoryPage(true)

  const openHistory=async()=>{
    document.querySelector<HTMLSelectElement>('#history-item')!.innerHTML='<option value="">All items</option>'+allItemList.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    historyModal.showModal()
    await refreshHistory()
  }

  document.querySelector('#open-history')!.addEventListener('click',openHistory)
  document.querySelector('#history-load-more')!.addEventListener('click',()=>loadHistoryPage(false))
  document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#history-search,#history-item,#history-category,#history-status,#history-site,#history-from,#history-to').forEach(el=>el.addEventListener(el.id==='history-search'?'input':'change',renderHistoryRows))
  document.querySelector('#history-clear')!.addEventListener('click',()=>{
    ;['history-search','history-item','history-category','history-status','history-site','history-from','history-to'].forEach(id=>{
      const el=document.querySelector<HTMLInputElement|HTMLSelectElement>('#'+id)!
      el.value=''
    })
    renderHistoryRows()
  })

  const updateInventoryDecrementVisibility=()=>{
    const enabled=document.querySelector<HTMLInputElement>('#inventory-auto')!.checked
    document.querySelector<HTMLElement>('#inventory-decrement-wrap')!.hidden=!enabled
  }

  const openInventoryEditor=(row?:Inventory)=>{
    const select=document.querySelector<HTMLSelectElement>('#inventory-item')!
    select.innerHTML=allItemList.map(i=>`<option value="${i.id}">${esc(i.name)}${i.active?'':' (archived)'}</option>`).join('')
    select.value=row?.tracked_item_id??allItemList[0]?.id??''
    select.disabled=!!row
    document.querySelector<HTMLInputElement>('#inventory-id')!.value=row?.id??''
    document.querySelector<HTMLHeadingElement>('#inventory-title')!.textContent=row?'Edit inventory':'Add inventory'
    document.querySelector<HTMLInputElement>('#inventory-quantity')!.value=String(row?.quantity??0)
    document.querySelector<HTMLSelectElement>('#inventory-unit')!.value=row?.unit??''
    document.querySelector<HTMLInputElement>('#inventory-threshold')!.value=row?.low_threshold?.toString()??''
    document.querySelector<HTMLInputElement>('#inventory-containers')!.value=row?.containers_on_hand?.toString()??''
    document.querySelector<HTMLInputElement>('#inventory-strength-amount')!.value=row?.strength_amount?.toString()??''
    document.querySelector<HTMLSelectElement>('#inventory-strength-unit')!.value=row?.strength_unit??''
    document.querySelector<HTMLInputElement>('#inventory-strength-per-amount')!.value=row?.strength_per_amount?.toString()??''
    document.querySelector<HTMLSelectElement>('#inventory-strength-per-unit')!.value=row?.strength_per_unit??''
    document.querySelector<HTMLInputElement>('#inventory-lot')!.value=row?.lot_number??''
    document.querySelector<HTMLInputElement>('#inventory-expiration')!.value=row?.expiration_date??''
    document.querySelector<HTMLInputElement>('#inventory-auto')!.checked=row?.auto_decrement??false
    document.querySelector<HTMLInputElement>('#inventory-decrement')!.value=String(row?.decrement_amount??1)
    document.querySelector<HTMLButtonElement>('#inventory-delete')!.hidden=!row
    updateInventoryDecrementVisibility()
    inventoryEditModal.showModal()
  }

  const openInventory=()=>inventoryModal.showModal()
  document.querySelector('#open-inventory')!.addEventListener('click',openInventory)
  document.querySelector('#open-inventory-secondary')?.addEventListener('click',openInventory)
  document.querySelector('#inventory-add')!.addEventListener('click',()=>openInventoryEditor())
  document.querySelector('#inventory-auto')!.addEventListener('change',updateInventoryDecrementVisibility)
  document.querySelectorAll<HTMLButtonElement>('[data-inventory-edit]').forEach(btn=>btn.addEventListener('click',()=>{
    const row=inventoryList.find(i=>i.id===btn.dataset.inventoryEdit)
    if(row) openInventoryEditor(row)
  }))

  document.querySelector('#inventory-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const id=document.querySelector<HTMLInputElement>('#inventory-id')!.value
    const tracked_item_id=document.querySelector<HTMLSelectElement>('#inventory-item')!.value
    const quantity=Number(document.querySelector<HTMLInputElement>('#inventory-quantity')!.value||0)
    const unit=document.querySelector<HTMLSelectElement>('#inventory-unit')!.value
    const thresholdRaw=document.querySelector<HTMLInputElement>('#inventory-threshold')!.value
    const low_threshold=thresholdRaw===''?null:Number(thresholdRaw)
    const containersRaw=document.querySelector<HTMLInputElement>('#inventory-containers')!.value
    const containers_on_hand=containersRaw===''?null:Number(containersRaw)
    const strengthAmountRaw=document.querySelector<HTMLInputElement>('#inventory-strength-amount')!.value
    const strength_amount=strengthAmountRaw===''?null:Number(strengthAmountRaw)
    const strength_unit=document.querySelector<HTMLSelectElement>('#inventory-strength-unit')!.value||null
    const strengthPerAmountRaw=document.querySelector<HTMLInputElement>('#inventory-strength-per-amount')!.value
    const strength_per_amount=strengthPerAmountRaw===''?null:Number(strengthPerAmountRaw)
    const strength_per_unit=document.querySelector<HTMLSelectElement>('#inventory-strength-per-unit')!.value||null
    const lot_number=document.querySelector<HTMLInputElement>('#inventory-lot')!.value.trim()||null
    const expiration_date=document.querySelector<HTMLInputElement>('#inventory-expiration')!.value||null
    const auto_decrement=document.querySelector<HTMLInputElement>('#inventory-auto')!.checked
    const decrementRaw=document.querySelector<HTMLInputElement>('#inventory-decrement')!.value
    const decrement_amount=auto_decrement?Number(decrementRaw||0):null
    const payload={quantity,unit,low_threshold,lot_number,expiration_date,auto_decrement,decrement_amount,containers_on_hand,strength_amount,strength_unit,strength_per_amount,strength_per_unit,updated_at:new Date().toISOString()}
    const result=id
      ? await supabase.from('inventory').update(payload).eq('id',id).eq('user_id',userId)
      : await supabase.from('inventory').insert({user_id:userId,tracked_item_id,...payload})
    if(result.error) return alert(result.error.message)
    inventoryEditModal.close()
    inventoryModal.close()
    renderDashboard(userId,email,showArchived)
  })

  document.querySelector('#inventory-delete')!.addEventListener('click',async()=>{
    const id=document.querySelector<HTMLInputElement>('#inventory-id')!.value
    if(!id || !confirm('Delete this inventory record?')) return
    const {error}=await supabase.from('inventory').delete().eq('id',id).eq('user_id',userId)
    if(error) return alert(error.message)
    inventoryEditModal.close()
    inventoryModal.close()
    renderDashboard(userId,email,showArchived)
  })

    document.querySelector('#add-item')!.addEventListener('click',()=>openItem())
  document.querySelector('#quick-log')?.addEventListener('click',()=>{ if(itemList[0]) openLog(itemList[0]) })
  document.querySelector('#add-schedule')?.addEventListener('click',()=>openSchedule())
  document.querySelector('#add-schedule-secondary')?.addEventListener('click',()=>openSchedule())
  document.querySelector('#schedule-frequency')!.addEventListener('change',updateScheduleFields)
  document.querySelectorAll<HTMLButtonElement>('[data-schedule-edit]').forEach(btn=>btn.addEventListener('click',()=>{
    const schedule=scheduleList.find(s=>s.id===btn.dataset.scheduleEdit)
    const item=itemList.find(i=>i.id===schedule?.tracked_item_id)
    if(schedule && item) openSchedule(item,schedule)
  }))

  document.querySelector('#log-item')!.addEventListener('change',e=>{
    const id=(e.target as HTMLSelectElement).value
    const item=itemList.find(i=>i.id===id)
    if(item) fillLog(item)
  })

  document.querySelector('#schedule-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const id=document.querySelector<HTMLInputElement>('#schedule-id')!.value
    const tracked_item_id=document.querySelector<HTMLSelectElement>('#schedule-item')!.value
    const frequency=document.querySelector<HTMLSelectElement>('#schedule-frequency')!.value as Schedule['frequency']
    const scheduled_time=document.querySelector<HTMLInputElement>('#schedule-time')!.value||null
    const start_date=document.querySelector<HTMLInputElement>('#schedule-start')!.value
    const days=Array.from(document.querySelectorAll<HTMLInputElement>('#weekday-fields input:checked')).map(cb=>Number(cb.value))
    const intervalRaw=document.querySelector<HTMLInputElement>('#schedule-interval')!.value
    if(frequency==='weekly' && !days.length) return alert('Choose at least one weekday.')
    const payload={
      tracked_item_id,frequency,scheduled_time,start_date,
      days_of_week:frequency==='weekly'?days:null,
      interval_days:frequency==='interval'?Number(intervalRaw||1):null,
      updated_at:new Date().toISOString()
    }
    const result=id
      ? await supabase.from('schedules').update(payload).eq('id',id).eq('user_id',userId)
      : await supabase.from('schedules').insert({user_id:userId,...payload})
    if(result.error) return alert(result.error.message)
    scheduleModal.close()
    renderDashboard(userId,email,false)
  })

  document.querySelector('#disable-schedule')!.addEventListener('click',async()=>{
    const id=document.querySelector<HTMLInputElement>('#schedule-id')!.value
    if(!id) return
    const {error}=await supabase.from('schedules').update({active:false,updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',userId)
    if(error) return alert(error.message)
    scheduleModal.close()
    renderDashboard(userId,email,false)
  })

  document.querySelector('#item-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const id=document.querySelector<HTMLInputElement>('#item-id')!.value
    const name=document.querySelector<HTMLInputElement>('#item-name')!.value.trim()
    const category=document.querySelector<HTMLSelectElement>('#item-category')!.value as Category
    const form=document.querySelector<HTMLSelectElement>('#item-form-type')!.value as Form
    const amountRaw=document.querySelector<HTMLInputElement>('#item-amount')!.value
    const default_unit=document.querySelector<HTMLSelectElement>('#item-unit')!.value||null
    const route=document.querySelector<HTMLSelectElement>('#item-route')!.value||null
    const notes=document.querySelector<HTMLTextAreaElement>('#item-notes')!.value.trim()||null
    const payload={name,category,form,default_amount:amountRaw?Number(amountRaw):null,default_unit,route,notes,updated_at:new Date().toISOString()}
    const result=id
      ? await supabase.from('tracked_items').update(payload).eq('id',id).eq('user_id',userId)
      : await supabase.from('tracked_items').insert({user_id:userId,...payload})
    if(result.error) return alert(result.error.message)
    itemModal.close()
    renderDashboard(userId,email,id ? showArchived : false)
  })

  document.querySelector('#log-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const logId=document.querySelector<HTMLInputElement>('#log-id')!.value
    const tracked_item_id=document.querySelector<HTMLSelectElement>('#log-item')!.value
    const item=(logId?allItemList:itemList).find(i=>i.id===tracked_item_id)
    if(!item) return
    const amountRaw=document.querySelector<HTMLInputElement>('#log-amount')!.value
    const amount=amountRaw?Number(amountRaw):null
    const unit=document.querySelector<HTMLInputElement>('#log-unit')!.value.trim()||null
    const status=document.querySelector<HTMLSelectElement>('#log-status')!.value
    const when=document.querySelector<HTMLInputElement>('#log-time')!.value
    const injection_site=item.form==='injectable' || item.category==='injection'
      ? (document.querySelector<HTMLSelectElement>('#log-site')?.value||null) : null
    if(status==='completed' && (item.form==='injectable' || item.category==='injection') && !injection_site){
      return alert('Choose an injection site before confirming this completed dose.')
    }
    const route=document.querySelector<HTMLSelectElement>('#log-route')?.value||null
    const notes=document.querySelector<HTMLTextAreaElement>('#log-notes')!.value.trim()||null
    const schedule_id=document.querySelector<HTMLInputElement>('#log-schedule-id')!.value||null
    const scheduled_for=document.querySelector<HTMLInputElement>('#log-scheduled-for')!.value||null
    const payload={amount,unit,status,route,schedule_id,scheduled_for,logged_at:new Date(when).toISOString(),injection_site,notes}
    const result=logId
      ? await supabase.from('logs').update(payload).eq('id',logId).eq('user_id',userId)
      : await supabase.from('logs').insert({user_id:userId,tracked_item_id,...payload})
    if(result.error) return alert(result.error.message)
    if(!logId && status==='completed'){
      const stock=inventoryByItem.get(tracked_item_id)
      if(stock?.auto_decrement && stock.decrement_amount && Number(stock.decrement_amount)>0){
        const {error:inventoryDeductError}=await supabase.rpc('decrement_inventory',{
          p_inventory_id:stock.id,
          p_amount:Number(stock.decrement_amount)
        })
        if(inventoryDeductError) return alert('Log saved, but inventory could not be updated: '+inventoryDeductError.message)
      }
    }
    logModal.close()
    if(logId && historyModal.open) return refreshHistory()
    renderDashboard(userId,email,showArchived)
  })

  document.querySelector('#delete-log')!.addEventListener('click',async()=>{
    const logId=document.querySelector<HTMLInputElement>('#log-id')!.value
    if(!logId || !confirm('Delete this log? This cannot be undone.')) return
    const {error}=await supabase.from('logs').delete().eq('id',logId).eq('user_id',userId)
    if(error) return alert(error.message)
    logModal.close()
    if(historyModal.open) return refreshHistory()
    renderDashboard(userId,email,showArchived)
  })

  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(btn=>btn.addEventListener('click',async()=>{
    const item=itemList.find(i=>i.id===btn.dataset.id); if(!item) return
    const action=btn.dataset.action
    if(action==='log') return openLog(item)
    if(action==='details') return openSubstanceDetail(item)
    if(action==='schedule') return openSchedule(item)
    if(action==='edit') return openItem(item)
    if(action==='archive' || action==='restore'){
      const active=action==='restore'
      const {error}=await supabase.from('tracked_items').update({active,updated_at:new Date().toISOString()}).eq('id',item.id).eq('user_id',userId)
      if(error) return alert(error.message)
      if(!active){
        const {error:scheduleDisableError}=await supabase.from('schedules').update({active:false,updated_at:new Date().toISOString()}).eq('tracked_item_id',item.id).eq('user_id',userId)
        if(scheduleDisableError) return alert(scheduleDisableError.message)
      }
      renderDashboard(userId,email,showArchived)
    }
  }))

  document.querySelectorAll<HTMLButtonElement>('[data-today-action]').forEach(btn=>btn.addEventListener('click',async()=>{
    const schedule=scheduleList.find(s=>s.id===btn.dataset.scheduleId)
    if(!schedule) return
    const item=itemList.find(i=>i.id===schedule.tracked_item_id)
    if(!item) return
    const action=btn.dataset.todayAction
    if(action==='edit') return openSchedule(item,schedule)
    if(action==='complete') return openLog(item,schedule)
    if(action==='skip'){
      const scheduled_for=occurrenceDate(schedule,today).toISOString()
      const {error}=await supabase.from('logs').insert({
        user_id:userId,tracked_item_id:item.id,schedule_id:schedule.id,scheduled_for,
        logged_at:new Date().toISOString(),status:'skipped',amount:null,unit:item.default_unit
      })
      if(error) return alert(error.message)
      renderDashboard(userId,email,false)
    }
  }))
}

supabase.auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY') return renderPasswordReset()
  if(!session) renderAuth()
})
boot()
