import { avatarMarkup, bindAvatars } from './avatar'
import { calculateReconstitution } from './reconstitution'
import { bindPushPanel, pushEnabled, disablePush, pushPrompt } from './push'
import { accountScreen, bindAccount } from './account'
import './styles.css'
import './brand.css'
import { doseInStockUnits, packageState, displayStock, stockNumber } from './inventory'
import { supabase } from './supabase'

const pulseLogoUrl = `${import.meta.env.BASE_URL}brand/pulse.svg`
const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root not found')
let dashboardView:'today'|'stack'|'cycles'|'inventory'|'history'|'tools'|'account'='today'
let deferredInstallPrompt:any=null
window.addEventListener('beforeinstallprompt',(event:any)=>{
  event.preventDefault()
  deferredInstallPrompt=event
})

type Category = 'anabolic'|'hormone'|'peptide'|'glp'|'medication'|'vitamin'|'supplement'|'injection'|'other'
type Form = 'injectable'|'oral'|'suppository'|'topical'
type Item = {
  id:string; name:string; category:Category; custom_category:string|null; form:Form|null; default_amount:number|null; default_unit:string|null;
  route:string|null; notes:string|null; active:boolean
}
type Log = {
  id:string; tracked_item_id:string; logged_at:string; amount:number|null; unit:string|null; status:string;
  route:string|null; injection_site:string|null; notes:string|null; schedule_id:string|null; scheduled_for:string|null;
  tracked_items?: { name:string; category:string; custom_category?:string|null; form?:Form|null } | null
}
type Schedule = {
  id:string; tracked_item_id:string; frequency:'daily'|'weekly'|'interval'|'as_needed'|'custom';
  scheduled_time:string|null; days_of_week:number[]|null; interval_days:number|null; start_date:string; end_date:string|null;
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
  containers_on_hand:number|null; package_amount:number|null; package_type:string|null; managed_schedule_id:string|null; updated_at:string;
  tracked_items?: { name:string; active?:boolean; category?:string; custom_category?:string|null; route?:string|null; default_amount?:number|null; default_unit?:string|null; form?:Form|null } | null
}

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const titleCase=(v:string)=>v.charAt(0).toUpperCase()+v.slice(1)
const categoryLabel=(item:{category?:string;custom_category?:string|null})=>item.category==='other'?(item.custom_category||'Other'):item.category==='glp'?'GLP':titleCase(item.category||'other')
const nexusUrl='https://nexus.sciencebyhugs.com'
const categoryOptions='<option value="peptide">Peptide</option><option value="glp">GLP</option><option value="anabolic">Anabolic</option><option value="vitamin">Vitamin</option><option value="supplement">Supplement</option><option value="other">Other / custom category</option><option value="hormone">Hormone</option><option value="medication">Medication</option><option value="injection">Legacy: Injection</option>'
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
  if(startOfDay(d)<startOfDay(start) || (s.end_date && dateKey(d)>s.end_date) || !s.active || s.frequency==='as_needed') return false
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
  const url=new URL(location.href),view=url.searchParams.get('view')
  if(view && ['today','stack','cycles','inventory','history','tools','account'].includes(view)){sessionStorage.setItem('pulse-dashboard-view',view);url.searchParams.delete('view');history.replaceState(null,'',url)}
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

async function hasBackgroundPush(){ return pushEnabled().catch(()=>false) }

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
  const savedView=sessionStorage.getItem('pulse-dashboard-view')
  if(savedView && ['today','stack','cycles','inventory','history','tools','account'].includes(savedView)) dashboardView=savedView as typeof dashboardView
  const today=new Date()
  const [{data:items,error:itemError},{data:allItems,error:allItemError},{data:logs,error:logError},{data:schedules,error:scheduleError},{data:todayLogs,error:todayLogError},{data:inventory,error:inventoryError},{data:cycles,error:cycleError},{data:cycleItems,error:cycleItemError},{data:cycleLogs,error:cycleLogError},{data:notificationPrefs,error:notificationPrefsError}] = await Promise.all([
    supabase.from('tracked_items')
      .select('id,name,category,custom_category,form,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).eq('active',!showArchived).order('created_at',{ascending:false}),
    supabase.from('tracked_items')
      .select('id,name,category,custom_category,form,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).order('name',{ascending:true}),
    supabase.from('logs')
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category,custom_category,form)')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(8),
    supabase.from('schedules')
      .select('id,tracked_item_id,frequency,scheduled_time,days_of_week,interval_days,start_date,end_date,active,tracked_items!inner(name,active)')
      .eq('user_id',userId).eq('active',true).eq('tracked_items.active',true).order('scheduled_time',{ascending:true}),
    supabase.from('logs')
      .select('id,schedule_id,scheduled_for,status')
      .eq('user_id',userId).not('schedule_id','is',null)
      .gte('scheduled_for',startOfDay(today).toISOString()).lt('scheduled_for',endOfDay(today).toISOString()),
    supabase.from('inventory')
      .select('id,tracked_item_id,quantity,unit,low_threshold,lot_number,expiration_date,auto_decrement,decrement_amount,strength_amount,strength_unit,strength_per_amount,strength_per_unit,containers_on_hand,package_amount,package_type,managed_schedule_id,updated_at,tracked_items(name,active,category,custom_category,route,default_amount,default_unit,form)')
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
  const stockState=(row:Inventory)=>packageState(row,row.tracked_items?.default_amount,row.tracked_items?.default_unit)
  const lowInventory=inventoryList.filter(row=>(row.low_threshold!==null && Number(row.quantity)<=Number(row.low_threshold)) || stockState(row)?.out)
  const changeInventory=inventoryList.filter(row=>stockState(row)?.changeSoon || stockState(row)?.lastDoseInPackage)
  const expiredInventory=inventoryList.filter(row=>!!row.expiration_date && row.expiration_date<todayKey)
  const inventoryAlerts=[...new Map([...lowInventory,...expiredInventory,...changeInventory].map(row=>[row.id,row])).values()]
  const weeklyPlanFor=(itemId:string)=>{
    const item=allItemList.find(i=>i.id===itemId)
    if(!item?.default_amount || !item.default_unit) return null
    const itemSchedules=scheduleList.filter(s=>s.tracked_item_id===itemId && s.active && (!s.end_date || s.end_date>=todayKey))
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
    for(const schedule of scheduleList.filter(s=>s.tracked_item_id===itemId && s.active && (!s.end_date || s.end_date>=todayKey))){
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
    if(stock.package_amount){
      try{availableDoses=Number(stock.quantity)/doseInStockUnits(Number(item.default_amount),item.default_unit,stock);basis='package dose'}catch{return null}
    }else if(stock.auto_decrement && stock.decrement_amount && Number(stock.decrement_amount)>0){
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
    ${pushPrompt()}
    <main class="app-shell" data-view="${dashboardView}">
      <header class="pulse-header">
        <div class="pulse-header-brand">
          <img class="pulse-brand-lockup" src="${pulseLogoUrl}" alt="Pulse — Science By Hugs">
          <div class="pulse-system-state"><span class="system-dot"></span><span>TRACKING SYSTEM ONLINE</span></div>
        </div>
        <button class="ghost account-button ${dashboardView==='account'?'active':''}" id="open-account" type="button" aria-label="Account" aria-pressed="${dashboardView==='account'}" title="Account">${avatarMarkup()}<span>Account</span></button>
      </header>

      <nav class="pulse-nav" aria-label="PULSE sections">
        <button class="${dashboardView==='today'?'active':''}" data-view-nav="today" aria-label="Today">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 13h4l2-7 4 12 2-5h4"/></svg></span><span class="nav-label">Today</span>
        </button>
        <button class="${dashboardView==='stack'?'active':''}" data-view-nav="stack" aria-label="Stack">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 7 12 11l7.5-4L12 3Z"/><path d="m4.5 12 7.5 4 7.5-4M4.5 17l7.5 4 7.5-4"/></svg></span><span class="nav-label">Stack</span>
        </button>
        <button class="${dashboardView==='cycles'?'active':''}" data-view-nav="cycles" aria-label="Cycles">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></span><span class="nav-label">Cycles</span>
        </button>
        <button class="${dashboardView==='inventory'?'active':''}" data-view-nav="inventory" aria-label="Inventory">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg></span><span class="nav-label">Inventory</span>
        </button>
        <button class="${dashboardView==='history'?'active':''}" data-view-nav="history" aria-label="History">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6M12 7v5l3 2"/></svg></span><span class="nav-label">History</span>
        </button>
        <button class="${dashboardView==='tools'?'active':''}" data-view-nav="tools" aria-label="Tools">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m14.7 6.3 3-3 3 3-3 3"/><path d="m4 20 9.5-9.5"/><path d="M5 4h6v6H5z"/></svg></span><span class="nav-label">Tools</span>
        </button>
      </nav>

      <section class="welcome pulse-hero view-section view-today">
        <div class="pulse-hero-copy">
          <span class="kicker">PERSONAL PROTOCOL TELEMETRY</span>
          <h2>Stay on schedule.</h2>
          <p class="muted">${esc(email)}</p>
        </div>
        <div class="pulse-hero-signal" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
      </section>

      <section class="quick-actions view-section view-today">
        <button class="primary" id="quick-log" ${itemList.length && !showArchived?'':'disabled'}>+ Log dose</button>
        <button class="ghost" id="add-item">+ Add substance</button>
        <button class="ghost" id="open-reminders">Reminders</button>
        <button class="ghost" id="open-settings">Settings</button>
      </section>

      ${!showArchived?`
      <section class="today-panel panel view-section view-today">
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

      ${inventoryAlerts.length?`<section class="panel inventory-attention view-section view-today"><span class="kicker">SUPPLY CHECK</span>${inventoryAlerts.slice(0,3).map(row=>{const state=stockState(row);return `<p><b>${esc(row.tracked_items?.name)}</b> · ${state?.out?'Not enough stock for another dose':state?.low?'At your reorder threshold':row.expiration_date && row.expiration_date<todayKey?'Expired':state?.changeSoon?'Change '+esc(row.package_type||'package')+' for your next dose':'One full dose left in the current '+esc(row.package_type||'package')}</p>`}).join('')}<button class="ghost compact" data-view-nav="inventory">Review inventory & reorder</button></section>`:''}
      <section class="stats v2-stats adherence-stats view-section view-today">
        <article class="metric-card metric-due"><span>DUE TODAY</span><strong>${dueToday.filter(x=>!x.status).length}</strong><small>${dueSoon.length} due soon · ${overdueNow.length} overdue</small></article>
        <article class="metric-card metric-adherence"><span>7-DAY ADHERENCE</span><strong>${adherence7d===null?'—':adherence7d+'%'}</strong><small>${completedExpected}/${expectedCount} expected doses completed</small></article>
        <article class="metric-card metric-inventory"><span>INVENTORY ALERTS</span><strong class="${inventoryAlerts.length?'inventory-alert-count':'online'}">${inventoryAlerts.length||'● Clear'}</strong><small>${inventoryAlerts.length?'Review inventory':'Inventory looks good'}</small></article>
      </section>

      ${!showArchived?`
      <section class="panel beta-analytics view-section view-today">
        <div class="panel-head">
          <div><span class="kicker">BETA SNAPSHOT</span><h3>Last 7 days</h3></div>
          <span class="beta-badge"><i></i> PRIVATE BETA · v0.9</span>
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
      <section class="panel cycle-overview view-section view-cycles ${activeCycle?'':'cycle-empty'}">
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
      </section>
      <section class="panel view-section view-cycles cycle-tab-list">
        <div class="panel-head">
          <div><span class="kicker">CYCLES</span><h3>All cycles</h3></div>
          <button class="primary compact" id="cycle-tab-create">+ New cycle</button>
        </div>
        <div class="cycle-list">
          ${cycleList.length?cycleList.map(cycle=>{
            const count=cycleItemList.filter(ci=>ci.cycle_id===cycle.id).length
            return `<article class="cycle-card ${cycle.status==='active'?'active':''}">
              <div><b>${esc(cycle.name)}</b><small>${esc(titleCase(cycle.status))} · ${esc(cycle.start_date)}${cycle.end_date?' → '+esc(cycle.end_date):' → ongoing'} · ${count} substance${count===1?'':'s'}</small></div>
              <div class="cycle-card-actions">
                <button class="ghost compact" data-cycle-details="${cycle.id}">Details</button>
                <button class="ghost compact" data-cycle-edit="${cycle.id}">Edit</button>
              </div>
            </article>`
          }).join(''):'<p class="empty">No cycles yet.</p>'}
        </div>
      </section>`:''}

      <section class="layout view-layout">
        <article class="panel view-section view-stack">
          <div class="panel-head">
            <div><span class="kicker">${showArchived?'ARCHIVE':'MY STACK'}</span><h3>${showArchived?'Archived substances':'Your substances'}</h3></div>
            <div class="tab-head-actions">
              <button class="primary compact" id="stack-add-item" type="button">+ Substance</button>
              <button class="ghost compact" id="toggle-archive">${showArchived?'View active':'Archived'}</button>
            </div>
          </div>
          <div class="rows">
            ${itemList.length?itemList.map(i=>`
              <div class="row item-card" data-id="${i.id}">
                <button class="item-main" data-action="log" data-id="${i.id}" ${showArchived?'disabled':''}>
                  <span><b>${esc(i.name)}</b><small>${esc(categoryLabel(i))}${i.form?' · '+esc(titleCase(i.form)):''}${i.route?' · '+esc(titleCase(i.route)):''}</small></span>
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

        <article class="panel view-section view-history">
          <div class="panel-head"><div><span class="kicker">HISTORY</span><h3>Recent activity</h3><p class="muted compact-copy">Your latest logged doses and skipped events.</p></div><button class="primary compact" id="open-history">Full timeline</button></div>
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
      <section class="panel schedules-panel view-section view-stack">
        <div class="panel-head"><div><span class="kicker">SCHEDULES</span><h3>Active schedules</h3><p class="muted compact-copy">When PULSE expects each recurring item.</p></div><button class="ghost compact" id="add-schedule-secondary" ${itemList.length?'':'disabled'}>+ Add</button></div>
        <div class="rows">
          ${scheduleList.length?scheduleList.map(s=>`
            <div class="row schedule-row">
              <span><b>${esc(s.tracked_items?.name??'Tracked item')}</b><small>${esc(scheduleLabel(s))}${s.scheduled_time?' · '+esc(new Date('1970-01-01T'+s.scheduled_time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})):''}</small></span>
              <button class="ghost compact" data-schedule-edit="${s.id}">Edit</button>
            </div>`).join(''):'<p class="empty">No active schedules yet.</p>'}
        </div>
      </section>`:''}

      ${!showArchived?`
      <section class="panel inventory-preview view-section view-inventory">
        <div class="panel-head"><div><span class="kicker">INVENTORY</span><h3>Stock & supply</h3><p class="muted compact-copy">${inventoryAlerts.length?inventoryAlerts.length+' items need attention':'Package stock, doses, and schedules in one place.'}</p></div><button class="primary compact" id="inventory-tab-add">+ Add item</button></div>
        <div class="inventory-tab-grid">
          ${inventoryList.length?inventoryList.map(row=>{
            const state=stockState(row),low=!!state?.low || !!state?.out || (row.low_threshold!==null && Number(row.quantity)<=Number(row.low_threshold)),expired=!!row.expiration_date && row.expiration_date<todayKey
            const item=allItemList.find(i=>i.id===row.tracked_item_id),schedule=scheduleList.find(i=>i.id===row.managed_schedule_id),supply=item?supplyFor(item):null,packageName=row.package_type||'package'
            return `<article class="inventory-tile ${low||expired||state?.changeSoon?'attention':''}">
              <div class="inventory-tile-head"><span><b>${esc(row.tracked_items?.name??'Tracked item')}</b><small>${esc(categoryLabel(row.tracked_items??{}))}</small></span>${low||expired?`<span class="attention-tag">${expired?'Expired':state?.out?'Out of stock':'Reorder soon'}</span>`:''}</div>
              <strong>${displayStock(Number(row.quantity))} ${esc(row.unit)} <small>remaining</small></strong>
              ${state?`<div class="package-summary"><span>${state.count} ${esc(packageName)}${state.count===1?'':'s'} on hand</span><span>${displayStock(Number(row.package_amount))} ${esc(row.unit)} / ${esc(packageName)}</span></div><div class="package-meter" role="meter" aria-label="Estimated amount in current package" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(state.percent)}"><span style="width:${state.percent}%"></span></div><small>Current ${esc(packageName)}: ${displayStock(state.current)} ${esc(row.unit)} · ${state.sealed} full unopened</small>${state.changeSoon?`<p class="package-alert">Change ${esc(packageName)} for your next dose. ${displayStock(state.current)} ${esc(row.unit)} remains in this one.</p>`:state.lastDoseInPackage?`<p class="package-alert">${state.sealed?`Your current ${esc(packageName)} has one full dose left. Have the next one ready.`:'This package has less than two doses left.'}</p>`:''}`:'<p class="muted compact-copy">Finish package setup to track each vial, bottle, or pack.</p>'}
              <div class="inventory-tile-meta"><span>${state?.doses!==null && state?.doses!==undefined?state.doses+' doses left':supply?Math.floor(supply.doses)+' doses est.':'Dose estimate —'}</span><span>${item?.default_amount?displayStock(Number(item.default_amount))+' '+esc(item.default_unit)+' / dose':'No dose set'}</span>${schedule?`<span>${esc(scheduleLabel(schedule))} · ${esc(schedule.scheduled_time?.slice(0,5))}</span>`:''}</div>
              ${schedule?`<small>${esc(schedule.start_date)}${schedule.end_date?' → '+esc(schedule.end_date):' · no stop date'}</small>`:''}
              <div class="inventory-card-actions"><button class="ghost compact" data-inventory-edit="${row.id}">Edit / restock</button>${item?.active?`<button class="ghost compact" data-inventory-log="${item.id}" ${state?.out?'disabled':''}>Log dose</button>`:''}</div>
              ${low||expired?`<a class="nexus-reorder" href="${nexusUrl}" target="_blank" rel="noopener noreferrer">Explore NEXUS research catalog <span aria-hidden="true">↗</span></a>`:''}
            </article>`
          }).join(''):'<div class="inventory-empty"><h4>Start with your first package</h4><p class="muted">Add an item, its full package strength, your stock, and your dose. PULSE keeps the totals in sync as you log.</p><button class="primary" id="inventory-empty-add">+ Add your first item</button></div>'}
        </div>
      </section>
`:''}


      <div class="view-section view-tools tool-switch" role="group" aria-label="Calculator">
        <button type="button" class="ghost active" data-tool="split" aria-pressed="true">Split dose</button>
        <button type="button" class="ghost" data-tool="reconstitution" aria-pressed="false">Reconstitution</button>
      </div>
      <section class="panel view-section view-tools reconstitution-screen" hidden>
        <div class="panel-head"><div><span class="kicker">TOOLS</span><h3>Peptide Reconstitution Calculator</h3><p class="muted compact-copy">Convert a vial amount and liquid volume into concentration and a target measurement.</p></div></div>
        <div class="calculator-layout">
          <form id="recon-form" class="calculator-form">
            <fieldset class="calc-fieldset"><legend>1 · Total peptide in vial</legend>
              <label>Vial amount (mg)<input id="recon-vial" type="number" inputmode="decimal" min="0" step="any" placeholder="Enter vial amount"></label>
              <div class="recon-presets" aria-label="mg presets"><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="1">1 mg</button><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="5">5 mg</button><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="10">10 mg</button><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="15">15 mg</button><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="20">20 mg</button><button type="button" class="ghost compact" data-recon-target="recon-vial" data-recon-value="50">50 mg</button></div>
            </fieldset>
            <fieldset class="calc-fieldset"><legend>2 · Liquid volume</legend>
              <label>Reconstituted volume (mL)<input id="recon-volume" type="number" inputmode="decimal" min="0" step="any" placeholder="Enter liquid volume"></label>
              <div class="recon-presets" aria-label="mL presets"><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="0.5">0.5 mL</button><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="1">1 mL</button><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="1.5">1.5 mL</button><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="2">2 mL</button><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="2.5">2.5 mL</button><button type="button" class="ghost compact" data-recon-target="recon-volume" data-recon-value="3">3 mL</button></div>
              <small>Use the final solution volume. If your instructions treat added diluent as the final volume, enter that value.</small>
            </fieldset>
            <fieldset class="calc-fieldset"><legend>3 · Target amount</legend>
              <div class="split"><label>Amount<input id="recon-dose" type="number" inputmode="decimal" min="0" step="any" placeholder="Enter established amount"></label>
              <label>Unit<select id="recon-unit"><option value="mg">mg</option><option value="mcg">mcg</option></select></label></div>
            </fieldset>
            <label>U-100 syringe size<select id="recon-capacity"><option value="1">1 mL · 100 units</option><option value="0.5">0.5 mL · 50 units</option><option value="0.3">0.3 mL · 30 units</option></select></label>
            <button class="ghost" type="reset">Clear calculator</button>
          </form>
          <aside class="calculator-results" aria-live="polite">
            <span class="kicker">RESULT</span>
            <div class="calc-primary-result"><small>Volume for your target amount</small><strong id="recon-draw">—</strong></div>
            <div class="calc-result-grid">
              <div><span>U-100 MEASUREMENT</span><strong id="recon-units">—</strong></div>
              <div><span>CONCENTRATION</span><strong id="recon-concentration">—</strong></div>
              <div><span>TARGET AMOUNT</span><strong id="recon-target">—</strong></div>
              <div><span>FULL AMOUNTS PER VIAL</span><strong id="recon-count">—</strong></div>
            </div>
            <div id="recon-scale-wrap" hidden><div class="recon-scale" role="img" aria-label="U-100 measurement scale"><div id="recon-fill"></div></div><div class="recon-scale-labels"><span>0</span><span id="recon-scale-end">100 units</span></div><small>Illustrative scale; syringe markings vary. Values are approximate and are not rounded to a syringe graduation.</small></div>
            <div id="recon-validation" class="calc-validation">Enter all three values to calculate.</div>
            <div class="calc-disclaimer"><b>Calculation tool only.</b> Enter an already established amount and follow the supplied reconstitution instructions. U-100 markings represent volume: 100 units = 1 mL, not peptide potency. This calculator does not select a dose or mixing instructions.</div>
          </aside>
        </div>
      </section>
      <section class="panel view-section view-tools calculator-screen">
        <div class="panel-head">
          <div>
            <span class="kicker">TOOLS</span>
            <h3>Split Dose Calculator</h3>
            <p class="muted compact-copy">Divide a user-entered weekly amount across a schedule and optionally convert it to volume or U-100 syringe units.</p>
          </div>
          <span class="calc-badge">ARITHMETIC ONLY</span>
        </div>

        <div class="calculator-layout">
          <form id="split-dose-form" class="calculator-form">
            <label>Tracked substance <span class="label-note">optional</span>
              <select id="calc-item">
                <option value="">Custom / not saved</option>
                ${allItemList.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('')}
              </select>
            </label>

            <div class="split">
              <label>Total weekly amount
                <input id="calc-weekly-dose" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 100" required>
              </label>
              <label>Amount unit
                <select id="calc-dose-unit">
                  <option value="mg">mg</option>
                  <option value="mcg">mcg</option>
                  <option value="IU">IU</option>
                  <option value="mL">mL</option>
                </select>
              </label>
            </div>

            <fieldset class="calc-fieldset">
              <legend>Split schedule</legend>
              <div class="calc-mode-switch">
                <label><input type="radio" name="calc-mode" value="times" checked><span>Times per week</span></label>
                <label><input type="radio" name="calc-mode" value="interval"><span>Every X days</span></label>
              </div>
              <div id="calc-times-wrap">
                <label>Times per week
                  <input id="calc-times" type="number" inputmode="numeric" min="1" max="14" step="1" value="2">
                </label>
              </div>
              <div id="calc-interval-wrap" hidden>
                <label>Every how many days?
                  <input id="calc-interval-days" type="number" inputmode="decimal" min="0.25" max="365" step="any" value="3">
                </label>
              </div>
            </fieldset>

            <fieldset class="calc-fieldset">
              <legend>Volume calculation <span class="label-note">optional</span></legend>
              <label>Concentration method
                <select id="calc-concentration-mode">
                  <option value="none">Do not calculate volume</option>
                  <option value="direct">Known concentration</option>
                  <option value="reconstituted">Vial + diluent</option>
                </select>
              </label>

              <div id="calc-direct-fields" hidden>
                <div class="split">
                  <label>Amount per mL
                    <input id="calc-concentration" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 200">
                  </label>
                  <label>Concentration unit
                    <select id="calc-concentration-unit">
                      <option value="mg">mg/mL</option>
                      <option value="mcg">mcg/mL</option>
                      <option value="IU">IU/mL</option>
                    </select>
                  </label>
                </div>
              </div>

              <div id="calc-reconstitution-fields" hidden>
                <div class="split">
                  <label>Vial amount
                    <input id="calc-vial-amount" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 5">
                  </label>
                  <label>Vial unit
                    <select id="calc-vial-unit">
                      <option value="mg">mg</option>
                      <option value="mcg">mcg</option>
                      <option value="IU">IU</option>
                    </select>
                  </label>
                </div>
                <label>Diluent added (mL)
                  <input id="calc-diluent" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 2">
                </label>
              </div>

              <p id="calc-inventory-note" class="calc-inventory-note" hidden></p>
            </fieldset>
          </form>

          <aside class="calculator-results" aria-live="polite">
            <span class="kicker">RESULT</span>
            <div class="calc-primary-result">
              <small>Amount per dose</small>
              <strong id="calc-dose-result">—</strong>
            </div>
            <div class="calc-result-grid">
              <div><span>AVERAGE FREQUENCY</span><strong id="calc-frequency-result">—</strong></div>
              <div><span>VOLUME PER DOSE</span><strong id="calc-volume-result">—</strong></div>
              <div><span>U-100 SYRINGE</span><strong id="calc-units-result">—</strong></div>
              <div><span>CONCENTRATION</span><strong id="calc-concentration-result">—</strong></div>
            </div>
            <div id="calc-validation" class="calc-validation">Enter a weekly amount to calculate.</div>
            <div class="calc-disclaimer">
              <b>Calculation tool only.</b> PULSE does not determine whether a dose, frequency, route, or concentration is appropriate. Use only values from your prescribed or otherwise established plan and independently verify important calculations.
            </div>
          </aside>
        </div>
      </section>

      ${accountScreen(email)}

      <dialog id="settings-modal" class="settings-modal">
        <section class="settings-shell">
          <div class="panel-head">
            <div><span class="kicker">SETTINGS & DATA</span><h3>PULSE Beta</h3><p class="muted">Account, data portability, install status, and beta information.</p></div>
            <button class="ghost compact modal-close" type="button">Close</button>
          </div>
          <div class="settings-grid">
            <article class="settings-card"><span>VERSION</span><strong>0.9.0 Beta 2</strong><small>Private beta candidate</small></article>
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
          <label class="toggle-row"><input id="reminder-low-stock-enabled" type="checkbox"><span>Low stock, package changes & expired stock alerts</span></label>
          <button class="ghost" id="reminder-account" type="button">Manage push notifications in Account</button>
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
          <label>Category<select id="item-category">${categoryOptions}</select></label>
          <label id="item-custom-wrap" hidden>Your category<input id="item-custom-category" maxlength="80"></label>
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
          <div class="split"><label>Start date<input id="schedule-start" type="date" required></label><label>Stop date (optional)<input id="schedule-end" type="date"></label></div>
          <div class="schedule-form-actions">
            <button class="primary" type="submit">Save schedule</button>
            <button class="ghost danger" id="disable-schedule" type="button" hidden>Disable schedule</button>
          </div>
        </form>
      </dialog>

      <dialog id="log-modal">
        <form id="log-form">
          <div class="panel-head"><div><span class="kicker" id="log-kicker">QUICK LOG</span><h3 id="log-title">Log item</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="log-id" type="hidden"><input id="log-entry-key" type="hidden"><input id="log-schedule-id" type="hidden"><input id="log-scheduled-for" type="hidden">
          <label>Tracked item<select id="log-item" required></select></label>
          <div class="split"><label>Amount<input id="log-amount" type="number" min="0" step="any"></label><label>Unit<input id="log-unit" placeholder="mg, mL, tablet"></label></div>
          <div id="category-fields"></div>
          <p class="notice" id="log-stock-note" hidden></p><label>Date & time<input id="log-time" type="datetime-local" required></label>
          <label>Status<select id="log-status"><option value="completed">Completed</option><option value="skipped">Skipped</option></select></label>
          <label>Notes<textarea id="log-notes" rows="3" placeholder="Optional notes"></textarea></label>
          <div class="log-form-actions">
            <button class="primary" id="log-save" type="submit">Save log</button>
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
                    <span>${esc(row.tracked_items?.category==='anabolic'?'Anabolic Steroid':categoryLabel(row.tracked_items??{}))}</span>
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

      <dialog id="inventory-edit-modal" class="package-editor">
        <form id="inventory-form">
          <div class="panel-head"><div><span class="kicker">PACKAGE SETUP</span><h3 id="inventory-title">Add inventory</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="inventory-id" type="hidden"><input id="inventory-schedule-id" type="hidden">
          <fieldset class="inventory-step"><legend>1 · Item</legend>
            <label>Use an existing item or create a new one<select id="inventory-item"></select></label>
            <label>Item name<input id="inventory-name" maxlength="120" required placeholder="Name on the package"></label>
            <label>Category<select id="inventory-category">${categoryOptions}</select></label>
            <label id="inventory-custom-wrap" hidden>Your category<input id="inventory-custom-category" maxlength="80" placeholder="Type your category"></label>
            <label>Form<select id="inventory-form-type"><option value="injectable">Injectable</option><option value="oral">Oral</option><option value="topical">Topical</option><option value="suppository">Suppository</option></select></label>
          </fieldset>
          <fieldset class="inventory-step"><legend>2 · Package & stock</legend>
            <label>Package type<select id="inventory-package-type"><option value="vial">Vial</option><option value="bottle">Bottle</option><option value="pack">Pack</option></select></label>
            <div class="split"><label>Amount in one full package<input id="inventory-package-amount" type="number" min="0.00000001" max="1000000000" step="any" required></label><label>Package unit<select id="inventory-unit"><option value="mg">mg</option><option value="mL">mL</option></select></label></div>
            <small>Enter the total amount in the entire vial, bottle, or pack—not the amount per tablet or per mL.</small>
            <div class="split"><label>How many packages do you have?<input id="inventory-containers" type="number" min="0" max="1000000" step="1" required></label><label>Amount left in the current package<input id="inventory-current" type="number" min="0" step="any" required></label></div>
            <small id="inventory-stock-preview"></small>
            <label>Reorder at this many full-package equivalents or less<input id="inventory-threshold" type="number" min="0" step="any" value="1" required></label>
          </fieldset>
          <fieldset class="inventory-step"><legend>3 · Your dose</legend>
            <div class="split"><label>Dose amount<input id="inventory-dose" type="number" min="0.00000001" step="any" required></label><label>Dose unit<select id="inventory-dose-unit"><option value="mg">mg</option><option value="mL">mL</option></select></label></div>
            <label id="inventory-conversion-wrap" hidden><span id="inventory-conversion-label">Total volume in each package (mL)</span><input id="inventory-conversion" type="number" min="0.00000001" step="any"></label>
            <small id="inventory-conversion-note" hidden>PULSE needs both total mg and total mL to convert between mass and volume.</small>
            <p class="muted compact-copy">Completed logs deduct the amount you actually enter. Skipped logs do not use stock. Packages are tracked in sequence; logs automatically move to the next package as stock is used.</p>
          </fieldset>
          <fieldset class="inventory-step"><legend>4 · Days & dates</legend>
            <label class="toggle-row"><input id="inventory-schedule-enabled" type="checkbox" checked><span>Schedule this item</span></label>
            <div id="inventory-schedule-fields"><div class="weekday-fields">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i)=>`<label class="day-chip"><input type="checkbox" value="${i}"><span>${d}</span></label>`).join('')}</div><label>Reminder time<input id="inventory-time" type="time"></label><div class="split"><label>Start date<input id="inventory-start" type="date"></label><label>Stop date (optional)<input id="inventory-end" type="date"></label></div></div>
          </fieldset>
          <details class="inventory-step"><summary>Lot & expiration (optional)</summary><label>Lot number<input id="inventory-lot" maxlength="120"></label><label>Expiration date<input id="inventory-expiration" type="date"></label></details>
          <p class="notice" id="inventory-form-error" role="alert" hidden></p>
          <div class="inventory-form-actions"><button class="primary" id="inventory-save" type="submit">Save item & inventory</button><button class="ghost danger" id="inventory-delete" type="button" hidden>Delete inventory</button></div>
        </form>
      </dialog>

    </main>`

  void bindAvatars()
  void bindAccount(email)
  const openAccount=()=>{
    void bindAvatars('', true)
    dashboardView='account'
    sessionStorage.setItem('pulse-dashboard-view','account')
    const shell=document.querySelector<HTMLElement>('.app-shell')!
    shell.dataset.view='account'
    document.querySelectorAll('[data-view-nav]').forEach(btn=>btn.classList.remove('active'))
    document.querySelector('#open-account')!.classList.add('active')
    document.querySelector('#open-account')!.setAttribute('aria-pressed','true')
    window.scrollTo({top:0,behavior:'instant'})
    document.querySelector<HTMLElement>('#account-title')!.focus({preventScroll:true})
  }
  document.querySelector('#open-account')!.addEventListener('click',openAccount)
  document.querySelector('#signout')!.addEventListener('click',async()=>{
    const button=document.querySelector<HTMLButtonElement>('#signout')!
    button.disabled=true
    try{
      await disablePush()
      const {error}=await supabase.auth.signOut()
      if(error) throw error
      sessionStorage.removeItem('pulse-dashboard-view')
      dashboardView='today'
      renderAuth()
    }catch(error:any){
      document.querySelector('#account-signout-status')!.textContent=error?.message||'Could not sign out. Try again.'
      button.disabled=false
    }
  })
  document.querySelectorAll<HTMLButtonElement>('[data-view-nav]').forEach(btn=>btn.addEventListener('click',()=>{
    dashboardView=(btn.dataset.viewNav||'today') as typeof dashboardView
    sessionStorage.setItem('pulse-dashboard-view',dashboardView)
    renderDashboard(userId,email,showArchived)
  }))
  document.querySelector('#toggle-archive')!.addEventListener('click',()=>{dashboardView='stack';sessionStorage.setItem('pulse-dashboard-view','stack');renderDashboard(userId,email,!showArchived)})

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
  document.querySelector('#account-settings')!.addEventListener('click',openSettings)

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
        version:'0.9.0-beta.2',
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
    const tables=['push_subscriptions','push_delivery_log','cycle_items','cycles','logs','schedules','inventory','tracked_items','notification_preferences']
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

  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button=>button.addEventListener('click',()=>{
    const recon=button.dataset.tool==='reconstitution'
    document.querySelector<HTMLElement>('.reconstitution-screen')!.hidden=!recon
    document.querySelector<HTMLElement>('.calculator-screen')!.hidden=recon
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(tab=>{
      const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active))
    })
  }))
  const reconInput=(id:string)=>document.querySelector<HTMLInputElement|HTMLSelectElement>('#'+id)!
  const updateReconstitution=()=>{
    const validation=document.querySelector<HTMLElement>('#recon-validation')!
    const scale=document.querySelector<HTMLElement>('#recon-scale-wrap')!
    for(const id of ['draw','units','concentration','target','count'])document.querySelector<HTMLElement>('#recon-'+id)!.textContent='—'
    scale.hidden=true;validation.classList.remove('warning')
    if(['recon-vial','recon-volume','recon-dose'].some(id=>!reconInput(id).value)){validation.textContent='Enter all three values to calculate.';return}
    try{
      const unit=reconInput('recon-unit').value,capacity=Number(reconInput('recon-capacity').value)
      const result=calculateReconstitution(Number(reconInput('recon-vial').value),Number(reconInput('recon-volume').value),Number(reconInput('recon-dose').value),unit,capacity)
      const precise=(n:number)=>Number(n.toPrecision(8)).toString()
      document.querySelector<HTMLElement>('#recon-draw')!.textContent='≈ '+precise(result.drawMl)+' mL'
      document.querySelector<HTMLElement>('#recon-units')!.textContent='≈ '+precise(result.units)+' units'
      document.querySelector<HTMLElement>('#recon-concentration')!.textContent='≈ '+precise(result.concentration)+' mg/mL'
      document.querySelector<HTMLElement>('#recon-target')!.textContent=reconInput('recon-dose').value+' '+unit
      document.querySelector<HTMLElement>('#recon-count')!.textContent=String(Math.floor(result.doses+Number.EPSILON*Math.max(1,result.doses)*4))
      validation.textContent=result.exceedsSyringe?'Calculated volume exceeds the selected syringe capacity. Choose a size that fits the calculated volume.':'Calculated from your entries. Full amounts per vial exclude handling losses.'
      validation.classList.toggle('warning',result.exceedsSyringe)
      if(!result.exceedsSyringe){
        scale.hidden=false
        document.querySelector<HTMLElement>('#recon-fill')!.style.width=(result.drawMl/capacity*100)+'%'
        document.querySelector<HTMLElement>('#recon-scale-end')!.textContent=(capacity*100)+' units'
        document.querySelector<HTMLElement>('.recon-scale')!.setAttribute('aria-label',precise(result.units)+' of '+(capacity*100)+' U-100 units')
      }
    }catch(error){validation.textContent=(error as Error).message}
  }
  document.querySelector('#recon-form')!.addEventListener('submit',e=>e.preventDefault())
  document.querySelector('#recon-form')!.addEventListener('input',updateReconstitution)
  document.querySelector('#recon-form')!.addEventListener('change',updateReconstitution)
  document.querySelector('#recon-form')!.addEventListener('reset',()=>setTimeout(updateReconstitution,0))
  document.querySelectorAll<HTMLButtonElement>('[data-recon-target]').forEach(button=>button.addEventListener('click',()=>{
    reconInput(button.dataset.reconTarget!).value=button.dataset.reconValue!;updateReconstitution()
  }))

  const calcItem=document.querySelector<HTMLSelectElement>('#calc-item')
  const calcWeekly=document.querySelector<HTMLInputElement>('#calc-weekly-dose')
  const calcDoseUnit=document.querySelector<HTMLSelectElement>('#calc-dose-unit')
  const calcTimes=document.querySelector<HTMLInputElement>('#calc-times')
  const calcInterval=document.querySelector<HTMLInputElement>('#calc-interval-days')
  const calcConcentrationMode=document.querySelector<HTMLSelectElement>('#calc-concentration-mode')
  const calcConcentration=document.querySelector<HTMLInputElement>('#calc-concentration')
  const calcConcentrationUnit=document.querySelector<HTMLSelectElement>('#calc-concentration-unit')
  const calcVialAmount=document.querySelector<HTMLInputElement>('#calc-vial-amount')
  const calcVialUnit=document.querySelector<HTMLSelectElement>('#calc-vial-unit')
  const calcDiluent=document.querySelector<HTMLInputElement>('#calc-diluent')

  const formatCalc=(value:number,digits=3)=>{
    if(!Number.isFinite(value)) return '—'
    return Number(value.toFixed(digits)).toString()
  }

  const updateCalculatorVisibility=()=>{
    const scheduleMode=document.querySelector<HTMLInputElement>('input[name="calc-mode"]:checked')?.value??'times'
    const timesWrap=document.querySelector<HTMLElement>('#calc-times-wrap')
    const intervalWrap=document.querySelector<HTMLElement>('#calc-interval-wrap')
    if(timesWrap) timesWrap.hidden=scheduleMode!=='times'
    if(intervalWrap) intervalWrap.hidden=scheduleMode!=='interval'

    const concentrationMode=calcConcentrationMode?.value??'none'
    const direct=document.querySelector<HTMLElement>('#calc-direct-fields')
    const recon=document.querySelector<HTMLElement>('#calc-reconstitution-fields')
    if(direct) direct.hidden=concentrationMode!=='direct'
    if(recon) recon.hidden=concentrationMode!=='reconstituted'
  }

  const runSplitDoseCalculator=()=>{
    if(!calcWeekly || !calcDoseUnit) return
    updateCalculatorVisibility()
    const validation=document.querySelector<HTMLElement>('#calc-validation')!
    const weekly=Number(calcWeekly.value)
    const unit=calcDoseUnit.value
    const mode=document.querySelector<HTMLInputElement>('input[name="calc-mode"]:checked')?.value??'times'

    if(!(weekly>0)){
      document.querySelector<HTMLElement>('#calc-dose-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-frequency-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-volume-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-units-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent='—'
      validation.textContent='Enter a weekly amount greater than zero.'
      validation.classList.remove('valid')
      return
    }

    let dosesPerWeek=0
    let scheduleText=''
    if(mode==='times'){
      const times=Number(calcTimes?.value)
      if(!(times>0)){
        validation.textContent='Times per week must be greater than zero.'
        validation.classList.remove('valid')
        return
      }
      dosesPerWeek=times
      scheduleText=`${formatCalc(times,2)}× / week`
    }else{
      const days=Number(calcInterval?.value)
      if(!(days>0)){
        validation.textContent='Day interval must be greater than zero.'
        validation.classList.remove('valid')
        return
      }
      dosesPerWeek=7/days
      scheduleText=`every ${formatCalc(days,2)} day${days===1?'':'s'} · ≈ ${formatCalc(dosesPerWeek,2)}× / week`
    }

    const perDose=weekly/dosesPerWeek
    document.querySelector<HTMLElement>('#calc-dose-result')!.textContent=`${formatCalc(perDose)} ${unit}`
    document.querySelector<HTMLElement>('#calc-frequency-result')!.textContent=scheduleText

    const concentrationMode=calcConcentrationMode?.value??'none'
    let concentration:number|null=null
    let concentrationUnit:string|null=null

    if(concentrationMode==='direct'){
      concentration=Number(calcConcentration?.value)
      concentrationUnit=calcConcentrationUnit?.value??unit
      if(!(concentration>0)){
        document.querySelector<HTMLElement>('#calc-volume-result')!.textContent='—'
        document.querySelector<HTMLElement>('#calc-units-result')!.textContent='—'
        document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent='Enter concentration'
        validation.textContent='Split amount calculated. Enter a concentration greater than zero for volume.'
        validation.classList.add('valid')
        return
      }
    }else if(concentrationMode==='reconstituted'){
      const vial=Number(calcVialAmount?.value)
      const diluent=Number(calcDiluent?.value)
      concentrationUnit=calcVialUnit?.value??unit
      if(!(vial>0) || !(diluent>0)){
        document.querySelector<HTMLElement>('#calc-volume-result')!.textContent='—'
        document.querySelector<HTMLElement>('#calc-units-result')!.textContent='—'
        document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent='Enter vial + mL'
        validation.textContent='Split amount calculated. Enter vial amount and diluent for volume.'
        validation.classList.add('valid')
        return
      }
      concentration=vial/diluent
    }

    if(concentrationMode==='none'){
      document.querySelector<HTMLElement>('#calc-volume-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-units-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent='Not used'
      validation.textContent='Split amount calculated.'
      validation.classList.add('valid')
      return
    }

    if(concentrationUnit!==unit){
      document.querySelector<HTMLElement>('#calc-volume-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-units-result')!.textContent='—'
      document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent=`${formatCalc(concentration!)} ${concentrationUnit}/mL`
      validation.textContent=`Cannot convert ${unit} to ${concentrationUnit} automatically. Match the amount and concentration units.`
      validation.classList.remove('valid')
      return
    }

    const volume=perDose/concentration!
    const syringeUnits=volume*100
    document.querySelector<HTMLElement>('#calc-volume-result')!.textContent=`${formatCalc(volume,4)} mL`
    document.querySelector<HTMLElement>('#calc-units-result')!.textContent=`${formatCalc(syringeUnits,2)} units`
    document.querySelector<HTMLElement>('#calc-concentration-result')!.textContent=`${formatCalc(concentration!)} ${concentrationUnit}/mL`
    validation.textContent='Calculation complete. U-100 assumes 100 syringe units = 1 mL.'
    validation.classList.add('valid')
  }

  const loadCalculatorItem=()=>{
    if(!calcItem) return
    const item=allItemList.find(row=>row.id===calcItem.value)
    const note=document.querySelector<HTMLElement>('#calc-inventory-note')
    if(note){ note.hidden=true; note.textContent='' }
    if(!item) return runSplitDoseCalculator()

    if(item.default_unit && ['mg','mcg','IU','mL'].includes(item.default_unit) && calcDoseUnit){
      calcDoseUnit.value=item.default_unit
    }

    const stock=inventoryByItem.get(item.id)
    if(
      stock && stock.strength_amount!==null && stock.strength_per_amount!==null &&
      stock.strength_unit && stock.strength_per_unit?.toLowerCase()==='ml' &&
      Number(stock.strength_per_amount)>0 &&
      ['mg','mcg','IU'].includes(stock.strength_unit)
    ){
      const concentration=Number(stock.strength_amount)/Number(stock.strength_per_amount)
      if(calcConcentrationMode) calcConcentrationMode.value='direct'
      if(calcConcentration) calcConcentration.value=String(concentration)
      if(calcConcentrationUnit) calcConcentrationUnit.value=stock.strength_unit
      if(note){
        note.hidden=false
        note.textContent=`Loaded Inventory concentration: ${formatCalc(concentration)} ${stock.strength_unit}/mL.`
      }
    }
    runSplitDoseCalculator()
  }

  document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#split-dose-form input,#split-dose-form select').forEach(control=>{
    control.addEventListener(control.type==='radio'?'change':'input',runSplitDoseCalculator)
    if(control.tagName==='SELECT') control.addEventListener('change',runSplitDoseCalculator)
  })
  calcItem?.addEventListener('change',loadCalculatorItem)

  let historyLogs:Log[]=[]
  let historyOffset=0
  let historyHasMore=true
  const historyPageSize=100
  document.querySelectorAll<HTMLButtonElement>('.modal-close').forEach(btn=>btn.addEventListener('click',()=>{ const dialog=btn.closest('dialog') as HTMLDialogElement|null; dialog?.close() }))

  const updateItemCustomCategory=()=>{document.querySelector<HTMLElement>('#item-custom-wrap')!.hidden=document.querySelector<HTMLSelectElement>('#item-category')!.value!=='other'}
  document.querySelector('#item-category')!.addEventListener('change',updateItemCustomCategory)
  document.querySelector('#history-category option[value="other"]')!.textContent='Other / custom categories'
  const openItem=(item?:Item)=>{
    document.querySelector<HTMLHeadingElement>('#item-title')!.textContent=item?'Edit tracked item':'Add tracked item'
    document.querySelector<HTMLInputElement>('#item-id')!.value=item?.id??''
    document.querySelector<HTMLInputElement>('#item-name')!.value=item?.name??''
    document.querySelector<HTMLSelectElement>('#item-category')!.value=item?.category??'peptide'
    document.querySelector<HTMLInputElement>('#item-custom-category')!.value=item?.custom_category??''
    updateItemCustomCategory()
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
    document.querySelector<HTMLInputElement>('#schedule-end')!.value=schedule?.end_date??''
    const days=schedule?.days_of_week??[]
    document.querySelectorAll<HTMLInputElement>('#weekday-fields input[type="checkbox"]').forEach(cb=>cb.checked=days.includes(Number(cb.value)))
    document.querySelector<HTMLButtonElement>('#disable-schedule')!.hidden=!schedule
    updateScheduleFields()
    scheduleModal.showModal()
  }

  const updateLogStockPreview=()=>{
    const note=document.querySelector<HTMLElement>('#log-stock-note')!,stock=inventoryByItem.get(document.querySelector<HTMLSelectElement>('#log-item')!.value)
    note.hidden=!stock?.package_amount;if(!stock?.package_amount)return
    if(document.querySelector<HTMLSelectElement>('#log-status')!.value==='skipped'){note.textContent='Skipped logs do not deduct stock.';return}
    const amount=Number(document.querySelector<HTMLInputElement>('#log-amount')!.value),unit=document.querySelector<HTMLInputElement>('#log-unit')!.value.trim()
    try{
      const deduction=doseInStockUnits(amount,unit,stock),state=packageState(stock,amount,unit)!,edited=!!document.querySelector<HTMLInputElement>('#log-id')!.value
      note.textContent=edited?`This edit reconciles your original stock deduction with ${displayStock(deduction)} ${stock.unit}.`:`This log deducts ${displayStock(deduction)} ${stock.unit} from stock.${deduction>Number(stock.quantity)?' Not enough stock; restock before logging.':deduction>state.current?' The dose reaches the next '+stock.package_type+'. Change packages as needed.':state.lastDoseInPackage?' Have your next '+stock.package_type+' ready.':''}`
    }catch(error){note.textContent=(error as Error).message}
  }
  document.querySelectorAll('#log-amount,#log-unit,#log-status').forEach(field=>field.addEventListener('input',updateLogStockPreview))
  const fillLog=(item:Item,schedule?:Schedule,existing?:Log)=>{
    const select=document.querySelector<HTMLSelectElement>('#log-item')!
    const available=existing?allItemList:itemList
    select.innerHTML=available.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    select.value=item.id
    select.disabled=!!existing
    document.querySelector<HTMLInputElement>('#log-id')!.value=existing?.id??''
    document.querySelector<HTMLInputElement>('#log-entry-key')!.value=existing?.id??crypto.randomUUID()
    document.querySelector<HTMLHeadingElement>('#log-title')!.textContent=existing?`Edit ${item.name}`:`Log ${item.name}`
    document.querySelector<HTMLElement>('#log-kicker')!.textContent=existing?'EDIT LOG':categoryLabel(item)
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
    updateLogStockPreview()
  }

  const openLog=(item:Item,schedule?:Schedule,existing?:Log)=>{ fillLog(item,schedule,existing); logModal.showModal() }

  const openSubstanceDetail=async(item:Item)=>{
    document.querySelector<HTMLElement>('#substance-detail-kicker')!.textContent=item.category==='anabolic'?'ANABOLIC STEROID':categoryLabel(item)
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
    document.querySelector('#detail-edit-inventory')!.addEventListener('click',()=>{ substanceDetailModal.close(); openInventoryEditor(stock,item) })
  }

  void bindPushPanel(userId)
  const openReminders=()=>{
    document.querySelector<HTMLInputElement>('#reminder-dose-enabled')!.checked=reminderPrefs.dose_reminders_enabled
    document.querySelector<HTMLSelectElement>('#reminder-lead')!.value=String(reminderPrefs.reminder_lead_minutes)
    document.querySelector<HTMLInputElement>('#reminder-overdue-enabled')!.checked=reminderPrefs.overdue_reminders_enabled
    document.querySelector<HTMLInputElement>('#reminder-low-stock-enabled')!.checked=reminderPrefs.low_stock_notifications_enabled
    reminderModal.showModal()
  }
  document.querySelector('#open-reminders')!.addEventListener('click',openReminders)
  document.querySelector('#account-reminders')!.addEventListener('click',openReminders)
  document.querySelector('#reminder-account')!.addEventListener('click',()=>{reminderModal.close();openAccount();document.querySelector('#account-notifications-title')!.scrollIntoView({block:'start'})})
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
          <div><b>${esc(item.name)}</b><small>${esc(item.category==='anabolic'?'Anabolic Steroid':categoryLabel(item))}${item.route?' · '+esc(titleCase(item.route)):''}</small></div>
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
  document.querySelector('#open-cycles-secondary')?.addEventListener('click',openCycles)
  document.querySelector('#cycle-tab-create')?.addEventListener('click',()=>openCycleEditor())
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
          <small>${new Date(log.logged_at).toLocaleString()} · ${esc(categoryLabel(log.tracked_items??{}))}${log.schedule_id?' · Scheduled':' · Manual'}</small>
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
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category,custom_category,form)')
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

  const inventoryInput=(id:string)=>document.querySelector<HTMLInputElement>('#inventory-'+id)!
  const inventorySelect=(id:string)=>document.querySelector<HTMLSelectElement>('#inventory-'+id)!
  let editingStock:Inventory|undefined
  let baselineCount='',baselineCurrent='',baselineCapacity='',baselineUnit=''
  const showInventoryError=(message:string)=>{const node=document.querySelector<HTMLElement>('#inventory-form-error')!;node.textContent=message;node.hidden=!message}
  const updateInventoryFields=()=>{
    document.querySelector<HTMLElement>('#inventory-custom-wrap')!.hidden=inventorySelect('category').value!=='other'
    const conversion=inventorySelect('unit').value!==inventorySelect('dose-unit').value
    document.querySelector<HTMLElement>('#inventory-conversion-wrap')!.hidden=!conversion
    document.querySelector<HTMLElement>('#inventory-conversion-note')!.hidden=!conversion
    inventoryInput('conversion').required=conversion
    document.querySelector<HTMLElement>('#inventory-conversion-label')!.textContent=inventorySelect('unit').value==='mg'?'Total volume in each package (mL)':'Total compound in each package (mg)'
    const scheduled=inventoryInput('schedule-enabled').checked
    document.querySelector<HTMLElement>('#inventory-schedule-fields')!.hidden=!scheduled
    inventoryInput('time').required=scheduled;inventoryInput('start').required=scheduled
    inventoryInput('end').min=inventoryInput('start').value
    const capacity=Number(inventoryInput('package-amount').value),count=Number(inventoryInput('containers').value),current=Number(inventoryInput('current').value)
    inventoryInput('current').max=String(capacity||0)
    const total=count>0?stockNumber((count-1)*capacity+current):0
    document.querySelector<HTMLElement>('#inventory-stock-preview')!.textContent=capacity>0?`Total on hand: ${displayStock(total)} ${inventorySelect('unit').value}. All other packages are counted as full.`:'Set the amount in a full package first.'
  }
  const fillInventoryItem=(item?:Item,row?:Inventory)=>{
    editingStock=row
    inventoryInput('id').value=row?.id??'';inventoryInput('name').value=item?.name??''
    inventorySelect('category').value=item?.category??'peptide';inventoryInput('custom-category').value=item?.custom_category??''
    inventorySelect('form-type').value=item?.form??'injectable';inventorySelect('package-type').value=row?.package_type??'vial'
    inventoryInput('package-amount').value=row?.package_amount?.toString()??''
    inventorySelect('unit').value=['mg','mL'].includes(row?.unit??'')?row!.unit:'mg'
    const state=row?stockState(row):null
    inventoryInput('containers').value=String(state?.count??row?.containers_on_hand??1)
    inventoryInput('current').value=state?String(state.current):''
    inventoryInput('threshold').value=row?.package_amount && row.low_threshold!==null?String(stockNumber(Number(row.low_threshold)/Number(row.package_amount))):'1'
    inventoryInput('dose').value=item?.default_amount?.toString()??''
    inventorySelect('dose-unit').value=['mg','mL'].includes(item?.default_unit??'')?item!.default_unit!:'mg'
    inventoryInput('conversion').value=''
    if(row?.package_amount && row.strength_amount && row.strength_per_amount && row.strength_unit==='mg' && row.strength_per_unit==='mL')inventoryInput('conversion').value=String(stockNumber(inventorySelect('unit').value==='mg'?Number(row.package_amount)*Number(row.strength_per_amount)/Number(row.strength_amount):Number(row.package_amount)*Number(row.strength_amount)/Number(row.strength_per_amount)))
    const schedule=scheduleList.find(i=>i.id===row?.managed_schedule_id)??scheduleList.find(i=>i.tracked_item_id===item?.id)
    inventoryInput('schedule-id').value=schedule?.id??'';inventoryInput('schedule-enabled').checked=!!schedule||!row
    inventoryInput('time').value=schedule?.scheduled_time?.slice(0,5)??'';inventoryInput('start').value=schedule?.start_date??todayKey;inventoryInput('end').value=schedule?.end_date??''
    const days=schedule?.frequency==='daily'?[0,1,2,3,4,5,6]:schedule?.days_of_week??[0,1,2,3,4,5,6]
    document.querySelectorAll<HTMLInputElement>('#inventory-schedule-fields input[type="checkbox"]').forEach(cb=>cb.checked=days.includes(Number(cb.value)))
    inventoryInput('lot').value=row?.lot_number??'';inventoryInput('expiration').value=row?.expiration_date??''
    baselineCount=inventoryInput('containers').value;baselineCurrent=inventoryInput('current').value;baselineCapacity=inventoryInput('package-amount').value;baselineUnit=inventorySelect('unit').value
    document.querySelector<HTMLHeadingElement>('#inventory-title')!.textContent=row?'Edit item & stock':'Add item & inventory'
    document.querySelector<HTMLButtonElement>('#inventory-delete')!.hidden=!row
    showInventoryError('');updateInventoryFields()
  }
  const openInventoryEditor=(row?:Inventory,item?:Item)=>{
    const select=inventorySelect('item')
    select.innerHTML='<option value="">Create a new item</option>'+allItemList.filter(i=>i.active||i.id===row?.tracked_item_id).map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    select.value=row?.tracked_item_id??item?.id??'';select.disabled=!!row
    fillInventoryItem(item??allItemList.find(i=>i.id===row?.tracked_item_id),row);inventoryEditModal.showModal()
  }
  inventorySelect('item').addEventListener('change',()=>{const id=inventorySelect('item').value;fillInventoryItem(allItemList.find(i=>i.id===id),inventoryByItem.get(id))})
  document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#inventory-form input,#inventory-form select').forEach(field=>field.addEventListener('input',updateInventoryFields))
  inventoryInput('package-amount').addEventListener('input',()=>{if(!editingStock || Number(baselineCurrent)===Number(baselineCapacity))inventoryInput('current').value=inventoryInput('package-amount').value;updateInventoryFields()})
  inventoryInput('containers').addEventListener('input',()=>{if(Number(inventoryInput('containers').value)===0)inventoryInput('current').value='0';else if(Number(inventoryInput('current').value)===0)inventoryInput('current').value=inventoryInput('package-amount').value;updateInventoryFields()})
  const openInventory=()=>{dashboardView='inventory';sessionStorage.setItem('pulse-dashboard-view','inventory');renderDashboard(userId,email,showArchived)}
  document.querySelector('#open-inventory-secondary')?.addEventListener('click',openInventory)
  document.querySelector('#inventory-tab-add')?.addEventListener('click',()=>openInventoryEditor())
  document.querySelector('#inventory-empty-add')?.addEventListener('click',()=>openInventoryEditor())
  document.querySelector('#inventory-add')!.addEventListener('click',()=>openInventoryEditor())
  document.querySelectorAll<HTMLButtonElement>('[data-inventory-edit]').forEach(btn=>btn.addEventListener('click',()=>{const row=inventoryList.find(i=>i.id===btn.dataset.inventoryEdit);if(row)openInventoryEditor(row)}))
  document.querySelectorAll<HTMLButtonElement>('[data-inventory-log]').forEach(btn=>btn.addEventListener('click',()=>{const item=itemList.find(i=>i.id===btn.dataset.inventoryLog);if(item)openLog(item)}))
  document.querySelector('#inventory-form')!.addEventListener('submit',async e=>{
    e.preventDefault();const button=document.querySelector<HTMLButtonElement>('#inventory-save')!;if(button.disabled)return;showInventoryError('')
    const name=inventoryInput('name').value.trim(),category=inventorySelect('category').value,custom_category=category==='other'?(inventoryInput('custom-category').value.trim()||null):null
    const capacity=Number(inventoryInput('package-amount').value),unit=inventorySelect('unit').value,count=Number(inventoryInput('containers').value),current=Number(inventoryInput('current').value),default_amount=Number(inventoryInput('dose').value),default_unit=inventorySelect('dose-unit').value,threshold=Number(inventoryInput('threshold').value)
    if(!name || !Number.isFinite(capacity) || capacity<=0 || !Number.isInteger(count) || count<0 || !Number.isFinite(current) || current<0 || current>capacity || !Number.isFinite(default_amount) || default_amount<=0 || !Number.isFinite(threshold) || threshold<0)return showInventoryError('Check the name, package amount, whole package count, dose, and threshold.')
    if(count>0 && current===0)return showInventoryError('For an empty current package, count only the remaining full packages and enter the full amount as the current package.')
    const quantity=count>0?stockNumber((count-1)*capacity+current):0
    let strength_amount:number|null=null,strength_per_amount:number|null=null
    if(editingStock?.strength_unit==='mg' && editingStock.strength_per_unit==='mL'){strength_amount=Number(editingStock.strength_amount)||null;strength_per_amount=Number(editingStock.strength_per_amount)||null}
    if(unit!==default_unit){const conversion=Number(inventoryInput('conversion').value);if(!Number.isFinite(conversion)||conversion<=0)return showInventoryError('Enter the total mg and mL in each package to convert units.');strength_amount=unit==='mg'?capacity:conversion;strength_per_amount=unit==='mL'?capacity:conversion}
    const enabled=inventoryInput('schedule-enabled').checked,days=Array.from(document.querySelectorAll<HTMLInputElement>('#inventory-schedule-fields input:checked')).map(cb=>Number(cb.value)),start_date=inventoryInput('start').value,end_date=inventoryInput('end').value||null,scheduled_time=inventoryInput('time').value
    if(enabled && (!days.length || !start_date || !scheduled_time))return showInventoryError('Choose your days, time, and start date.')
    if(enabled && end_date && end_date<start_date)return showInventoryError('Stop date must be on or after the start date.')
    const unchanged=!!editingStock?.package_amount && baselineCount===inventoryInput('containers').value && baselineCurrent===inventoryInput('current').value && baselineCapacity===inventoryInput('package-amount').value && baselineUnit===unit
    button.disabled=true
    try{
      const {error}=await supabase.rpc('pulse_save_inventory',{
        p_item_id:inventorySelect('item').value||null,p_inventory_id:editingStock?.id??null,
        p_item:{name,category,custom_category,form:inventorySelect('form-type').value,default_amount,default_unit},
        p_stock:{quantity:unchanged?null:quantity,expected_updated_at:editingStock?.updated_at??null,unit,package_amount:capacity,package_type:inventorySelect('package-type').value,low_threshold:stockNumber(threshold*capacity),strength_amount,strength_unit:strength_amount?'mg':null,strength_per_amount,strength_per_unit:strength_per_amount?'mL':null,lot_number:inventoryInput('lot').value.trim()||null,expiration_date:inventoryInput('expiration').value||null},
        p_schedule:{id:inventoryInput('schedule-id').value||null,enabled,days_of_week:days,scheduled_time,start_date,end_date}
      })
      if(error)return showInventoryError(error.message)
      inventoryEditModal.close();inventoryModal.close();await renderDashboard(userId,email,showArchived)
    }catch(error){showInventoryError(error instanceof Error?error.message:'Unable to save inventory. Try again.')}finally{button.disabled=false}
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
  document.querySelector('#stack-add-item')?.addEventListener('click',()=>openItem())
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
    const end_date=document.querySelector<HTMLInputElement>('#schedule-end')!.value||null
    if(end_date && end_date<start_date)return alert('Stop date must be on or after the start date.')
    const days=Array.from(document.querySelectorAll<HTMLInputElement>('#weekday-fields input:checked')).map(cb=>Number(cb.value))
    const intervalRaw=document.querySelector<HTMLInputElement>('#schedule-interval')!.value
    if(frequency==='weekly' && !days.length) return alert('Choose at least one weekday.')
    const payload={
      tracked_item_id,frequency,scheduled_time,start_date,end_date,
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
    const custom_category=category==='other'?(document.querySelector<HTMLInputElement>('#item-custom-category')!.value.trim()||null):null
    const payload={name,category,custom_category,form,default_amount:amountRaw?Number(amountRaw):null,default_unit,route,notes,updated_at:new Date().toISOString()}
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
    const saveButton=document.querySelector<HTMLButtonElement>('#log-save')!
    if(saveButton.disabled)return
    if(status==='completed' && inventoryByItem.get(tracked_item_id)?.package_amount){
      try{doseInStockUnits(Number(amount),unit||'',inventoryByItem.get(tracked_item_id)!)}catch(error){return alert((error as Error).message)}
    }
    saveButton.disabled=true
    const result=logId
      ? await supabase.from('logs').update(payload).eq('id',logId).eq('user_id',userId)
      : await supabase.from('logs').insert({id:document.querySelector<HTMLInputElement>('#log-entry-key')!.value,user_id:userId,tracked_item_id,...payload})
    saveButton.disabled=false
    if(result.error) return alert(result.error.message)
    const previousStock=inventoryByItem.get(tracked_item_id)
    const messages:string[]=[]
    if(previousStock?.package_amount){
      const {data:updatedStock}=await supabase.from('inventory').select('quantity,unit,low_threshold,package_amount,package_type,strength_amount,strength_unit,strength_per_amount,strength_per_unit').eq('id',previousStock.id).eq('user_id',userId).maybeSingle()
      if(updatedStock){
        const before=packageState(previousStock,item.default_amount,item.default_unit)
        const after=packageState(updatedStock,item.default_amount,item.default_unit)
        if(!logId && status==='completed' && before && after && after.count<before.count && after.count>0)messages.push(`You finished a ${previousStock.package_type}. Start the next ${previousStock.package_type}; ${after.count} remain.`)
        if(after?.changeSoon)messages.push(`Change ${previousStock.package_type} for the next dose.`)
        if(after?.low || after?.out)messages.push('Stock is running low. Your inventory now has a NEXUS research catalog link.')
      }
    }
    if(messages.length)alert(messages.join('\n'))
    logModal.close()
    renderDashboard(userId,email,showArchived)
  })

  document.querySelector('#delete-log')!.addEventListener('click',async()=>{
    const logId=document.querySelector<HTMLInputElement>('#log-id')!.value
    if(!logId || !confirm('Delete this log? This cannot be undone.')) return
    const {error}=await supabase.from('logs').delete().eq('id',logId).eq('user_id',userId)
    if(error) return alert(error.message)
    logModal.close()
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

