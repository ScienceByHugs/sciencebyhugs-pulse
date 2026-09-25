import './styles.css'
import { supabase } from './supabase'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root not found')

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
type Inventory = {
  id:string; tracked_item_id:string; quantity:number; unit:string; low_threshold:number|null;
  lot_number:string|null; expiration_date:string|null; auto_decrement:boolean; decrement_amount:number|null;
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
      <section class="brand-panel"><div class="eyebrow">SCIENCE BY HUGs</div><h1>PULSE</h1><p>Track. Measure. Evolve.</p><div class="pulse-line"></div></section>
      <section class="auth-card">
        <span class="kicker">PRIVATE TRACKING</span><h2>Welcome to PULSE</h2>
        <p class="muted">Sign in or create your PULSE account.</p>
        ${message ? `<div class="notice">${esc(message)}</div>` : ''}
        <form id="auth-form">
          <label>Email<input id="email" type="email" required autocomplete="email"></label>
          <label>Password<input id="password" type="password" minlength="8" required autocomplete="current-password"></label>
          <button class="primary" type="submit">Sign in</button>
          <button class="ghost" id="signup" type="button">Create account</button>
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
  const [{data:items,error:itemError},{data:allItems,error:allItemError},{data:logs,error:logError},{data:schedules,error:scheduleError},{data:todayLogs,error:todayLogError},{data:inventory,error:inventoryError}] = await Promise.all([
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
      .select('id,tracked_item_id,quantity,unit,low_threshold,lot_number,expiration_date,auto_decrement,decrement_amount,tracked_items(name,active,category,route,default_amount,default_unit,form)')
      .eq('user_id',userId).order('updated_at',{ascending:false})
  ])
  if(itemError || allItemError || logError || scheduleError || todayLogError || inventoryError) {
    const problem=itemError?.message??allItemError?.message??logError?.message??scheduleError?.message??todayLogError?.message??inventoryError?.message
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

  app!.innerHTML=`
    <main class="app-shell">
      <header>
        <div><div class="eyebrow">SCIENCE BY HUGs</div><div class="wordmark">PULSE</div></div>
        <button class="ghost compact" id="signout">Sign out</button>
      </header>

      <section class="welcome"><span class="kicker">TRACKER</span><h2>Good to see you.</h2><p class="muted">${esc(email)}</p></section>

      <section class="quick-actions">
        <button class="primary" id="quick-log" ${itemList.length && !showArchived?'':'disabled'}>+ Quick log</button>
        <button class="ghost" id="add-item">+ New tracked item</button>
        <button class="ghost" id="open-inventory">Inventory${inventoryAlerts.length?` · ${inventoryAlerts.length}`:''}</button>
        <button class="ghost" id="toggle-archive">${showArchived?'View active':'View archived'}</button>
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
          <span><b>${dueToday.filter(x=>x.overdue).length}</b> overdue</span>
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

      <section class="stats">
        <article><span>${showArchived?'ARCHIVED':'ACTIVE'} ITEMS</span><strong>${itemList.length}</strong></article>
        <article><span>ACTIVE SCHEDULES</span><strong>${scheduleList.length}</strong></article>
        <article><span>INVENTORY ALERTS</span><strong class="${inventoryAlerts.length?'inventory-alert-count':'online'}">${inventoryAlerts.length||'● Clear'}</strong></article>
      </section>

      <section class="layout">
        <article class="panel">
          <div class="panel-head"><div><span class="kicker">${showArchived?'ARCHIVE':'TRACK'}</span><h3>${showArchived?'Archived items':'Your items'}</h3></div></div>
          <div class="rows">
            ${itemList.length?itemList.map(i=>`
              <div class="row item-card" data-id="${i.id}">
                <button class="item-main" data-action="log" data-id="${i.id}" ${showArchived?'disabled':''}>
                  <span><b>${esc(i.name)}</b><small>${esc(titleCase(i.category))}${i.form?' · '+esc(titleCase(i.form)):''}${i.route?' · '+esc(titleCase(i.route)):''}</small></span>
                  <span class="dose">${i.default_amount??'—'} ${esc(i.default_unit??'')}</span>
                </button>
                <div class="row-actions">
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
                  <strong>${esc(row.quantity)} ${esc(row.unit)} total</strong>
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

  const itemModal=document.querySelector<HTMLDialogElement>('#item-modal')!
  const scheduleModal=document.querySelector<HTMLDialogElement>('#schedule-modal')!
  const logModal=document.querySelector<HTMLDialogElement>('#log-modal')!
  const historyModal=document.querySelector<HTMLDialogElement>('#history-modal')!
  const inventoryModal=document.querySelector<HTMLDialogElement>('#inventory-modal')!
  const inventoryEditModal=document.querySelector<HTMLDialogElement>('#inventory-edit-modal')!
  let historyLogs:Log[]=[]
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
    document.querySelector<HTMLElement>('#history-summary')!.textContent=`${filtered.length} of ${historyLogs.length} logs`
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

  const refreshHistory=async()=>{
    document.querySelector<HTMLElement>('#history-list')!.innerHTML='<p class="empty">Loading history…</p>'
    const {data,error}=await supabase.from('logs')
      .select('id,tracked_item_id,logged_at,amount,unit,status,route,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category,form)')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(1000)
    if(error){
      document.querySelector<HTMLElement>('#history-list')!.innerHTML=`<div class="notice">${esc(error.message)}</div>`
      return
    }
    historyLogs=(data??[]) as unknown as Log[]
    const sites=[...new Set(historyLogs.map(l=>l.injection_site).filter((v):v is string=>!!v))].sort()
    const siteSelect=document.querySelector<HTMLSelectElement>('#history-site')!
    const selected=siteSelect.value
    siteSelect.innerHTML='<option value="">All sites</option>'+sites.map(s=>`<option>${esc(s)}</option>`).join('')
    siteSelect.value=selected
    renderHistoryRows()
  }

  const openHistory=async()=>{
    document.querySelector<HTMLSelectElement>('#history-item')!.innerHTML='<option value="">All items</option>'+allItemList.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    historyModal.showModal()
    await refreshHistory()
  }

  document.querySelector('#open-history')!.addEventListener('click',openHistory)
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
    const lot_number=document.querySelector<HTMLInputElement>('#inventory-lot')!.value.trim()||null
    const expiration_date=document.querySelector<HTMLInputElement>('#inventory-expiration')!.value||null
    const auto_decrement=document.querySelector<HTMLInputElement>('#inventory-auto')!.checked
    const decrementRaw=document.querySelector<HTMLInputElement>('#inventory-decrement')!.value
    const decrement_amount=auto_decrement?Number(decrementRaw||0):null
    const payload={quantity,unit,low_threshold,lot_number,expiration_date,auto_decrement,decrement_amount,updated_at:new Date().toISOString()}
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
        const nextQuantity=Math.max(0,Number(stock.quantity)-Number(stock.decrement_amount))
        const {error:inventoryDeductError}=await supabase.from('inventory')
          .update({quantity:nextQuantity,updated_at:new Date().toISOString()})
          .eq('id',stock.id).eq('user_id',userId)
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

supabase.auth.onAuthStateChange((_event,session)=>{ if(!session) renderAuth() })
boot()
