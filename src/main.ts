import './styles.css'
import { supabase } from './supabase'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root not found')

type Category = 'injection'|'medication'|'supplement'|'other'
type Item = {
  id:string; name:string; category:Category; default_amount:number|null; default_unit:string|null;
  route:string|null; notes:string|null; active:boolean
}
type Log = {
  id:string; logged_at:string; amount:number|null; unit:string|null; status:string;
  injection_site:string|null; notes:string|null; schedule_id:string|null; scheduled_for:string|null;
  tracked_items?: { name:string; category:string } | null
}
type Schedule = {
  id:string; tracked_item_id:string; frequency:'daily'|'weekly'|'interval'|'as_needed'|'custom';
  scheduled_time:string|null; days_of_week:number[]|null; interval_days:number|null; start_date:string;
  active:boolean; tracked_items?: { name:string; active?:boolean } | null
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

function categoryFields(item:Item){
  if(item.category==='injection'){
    return `
      <label>Route<input id="log-route" value="${esc(item.route??'')}" placeholder="e.g. Subcutaneous"></label>
      <label>Injection site<select id="log-site">
        <option value="">Select site</option><option>Abdomen</option><option>Left thigh</option><option>Right thigh</option>
        <option>Left arm</option><option>Right arm</option><option>Other</option>
      </select></label>`
  }
  if(item.category==='medication') return `<label>Route<input id="log-route" value="${esc(item.route??'')}" placeholder="e.g. Oral"></label>`
  if(item.category==='supplement') return `<label>Form / route<input id="log-route" value="${esc(item.route??'')}" placeholder="e.g. Capsule"></label>`
  return `<label>Method / route<input id="log-route" value="${esc(item.route??'')}" placeholder="Optional"></label>`
}

async function renderDashboard(userId:string,email:string,showArchived=false) {
  const today=new Date()
  const [{data:items,error:itemError},{data:logs,error:logError},{data:schedules,error:scheduleError},{data:todayLogs,error:todayLogError}] = await Promise.all([
    supabase.from('tracked_items')
      .select('id,name,category,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).eq('active',!showArchived).order('created_at',{ascending:false}),
    supabase.from('logs')
      .select('id,logged_at,amount,unit,status,injection_site,notes,schedule_id,scheduled_for,tracked_items(name,category)')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(8),
    supabase.from('schedules')
      .select('id,tracked_item_id,frequency,scheduled_time,days_of_week,interval_days,start_date,active,tracked_items!inner(name,active)')
      .eq('user_id',userId).eq('active',true).eq('tracked_items.active',true).order('scheduled_time',{ascending:true}),
    supabase.from('logs')
      .select('id,schedule_id,scheduled_for,status')
      .eq('user_id',userId).not('schedule_id','is',null)
      .gte('scheduled_for',startOfDay(today).toISOString()).lt('scheduled_for',endOfDay(today).toISOString())
  ])
  if(itemError || logError || scheduleError || todayLogError) {
    const problem=itemError?.message??logError?.message??scheduleError?.message??todayLogError?.message
    app!.innerHTML=`<main class="app-shell"><div class="notice">Unable to load PULSE: ${esc(problem)}</div></main>`
    return
  }

  const itemList=(items??[]) as Item[]
  const recent=(logs??[]) as unknown as Log[]
  const scheduleList=(schedules??[]) as unknown as Schedule[]
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
        <article><span>STATUS</span><strong class="online">● Ready</strong></article>
      </section>

      <section class="layout">
        <article class="panel">
          <div class="panel-head"><div><span class="kicker">${showArchived?'ARCHIVE':'TRACK'}</span><h3>${showArchived?'Archived items':'Your items'}</h3></div></div>
          <div class="rows">
            ${itemList.length?itemList.map(i=>`
              <div class="row item-card" data-id="${i.id}">
                <button class="item-main" data-action="log" data-id="${i.id}" ${showArchived?'disabled':''}>
                  <span><b>${esc(i.name)}</b><small>${esc(titleCase(i.category))}${i.route?' · '+esc(i.route):''}</small></span>
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
          <div class="panel-head"><div><span class="kicker">HISTORY</span><h3>Recent activity</h3></div></div>
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

      <dialog id="item-modal">
        <form id="item-form">
          <div class="panel-head"><div><span class="kicker">TRACKER SETUP</span><h3 id="item-title">Add tracked item</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
          <input id="item-id" type="hidden">
          <label>Name<input id="item-name" required maxlength="120" placeholder="e.g. Vitamin D"></label>
          <label>Category<select id="item-category">
            <option value="injection">Injection</option><option value="medication">Medication</option>
            <option value="supplement">Supplement</option><option value="other">Other</option>
          </select></label>
          <div class="split"><label>Default amount<input id="item-amount" type="number" min="0" step="any"></label><label>Unit<input id="item-unit" placeholder="mg, mL, tablet"></label></div>
          <label>Default route / form<input id="item-route" placeholder="e.g. Subcutaneous, oral, capsule"></label>
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
          <input id="log-schedule-id" type="hidden"><input id="log-scheduled-for" type="hidden">
          <label>Tracked item<select id="log-item" required></select></label>
          <div class="split"><label>Amount<input id="log-amount" type="number" min="0" step="any"></label><label>Unit<input id="log-unit" placeholder="mg, mL, tablet"></label></div>
          <div id="category-fields"></div>
          <label>Date & time<input id="log-time" type="datetime-local" required></label>
          <label>Status<select id="log-status"><option value="completed">Completed</option><option value="skipped">Skipped</option></select></label>
          <label>Notes<textarea id="log-notes" rows="3" placeholder="Optional notes"></textarea></label>
          <button class="primary" type="submit">Save log</button>
        </form>
      </dialog>
    </main>`

  document.querySelector('#signout')!.addEventListener('click',async()=>{await supabase.auth.signOut();renderAuth()})
  document.querySelector('#toggle-archive')!.addEventListener('click',()=>renderDashboard(userId,email,!showArchived))

  const itemModal=document.querySelector<HTMLDialogElement>('#item-modal')!
  const scheduleModal=document.querySelector<HTMLDialogElement>('#schedule-modal')!
  const logModal=document.querySelector<HTMLDialogElement>('#log-modal')!
  document.querySelectorAll<HTMLButtonElement>('.modal-close').forEach(btn=>btn.addEventListener('click',()=>{ const dialog=btn.closest('dialog') as HTMLDialogElement|null; dialog?.close() }))

  const openItem=(item?:Item)=>{
    document.querySelector<HTMLHeadingElement>('#item-title')!.textContent=item?'Edit tracked item':'Add tracked item'
    document.querySelector<HTMLInputElement>('#item-id')!.value=item?.id??''
    document.querySelector<HTMLInputElement>('#item-name')!.value=item?.name??''
    document.querySelector<HTMLSelectElement>('#item-category')!.value=item?.category??'injection'
    document.querySelector<HTMLInputElement>('#item-amount')!.value=item?.default_amount?.toString()??''
    document.querySelector<HTMLInputElement>('#item-unit')!.value=item?.default_unit??''
    document.querySelector<HTMLInputElement>('#item-route')!.value=item?.route??''
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

  const fillLog=(item:Item,schedule?:Schedule)=>{
    const select=document.querySelector<HTMLSelectElement>('#log-item')!
    select.innerHTML=itemList.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')
    select.value=item.id
    document.querySelector<HTMLHeadingElement>('#log-title')!.textContent=`Log ${item.name}`
    document.querySelector<HTMLElement>('#log-kicker')!.textContent=titleCase(item.category)
    document.querySelector<HTMLInputElement>('#log-amount')!.value=item.default_amount?.toString()??''
    document.querySelector<HTMLInputElement>('#log-unit')!.value=item.default_unit??''
    document.querySelector<HTMLInputElement>('#log-time')!.value=localInputValue()
    document.querySelector<HTMLSelectElement>('#log-status')!.value='completed'
    document.querySelector<HTMLTextAreaElement>('#log-notes')!.value=''
    document.querySelector<HTMLInputElement>('#log-schedule-id')!.value=schedule?.id??''
    document.querySelector<HTMLInputElement>('#log-scheduled-for')!.value=schedule?occurrenceDate(schedule,today).toISOString():''
    if(schedule) document.querySelector<HTMLInputElement>('#log-time')!.value=localInputValue(occurrenceDate(schedule,today))
    document.querySelector<HTMLElement>('#category-fields')!.innerHTML=categoryFields(item)
  }

  const openLog=(item:Item,schedule?:Schedule)=>{ fillLog(item,schedule); logModal.showModal() }

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
    const amountRaw=document.querySelector<HTMLInputElement>('#item-amount')!.value
    const default_unit=document.querySelector<HTMLInputElement>('#item-unit')!.value.trim()||null
    const route=document.querySelector<HTMLInputElement>('#item-route')!.value.trim()||null
    const notes=document.querySelector<HTMLTextAreaElement>('#item-notes')!.value.trim()||null
    const payload={name,category,default_amount:amountRaw?Number(amountRaw):null,default_unit,route,notes,updated_at:new Date().toISOString()}
    const result=id
      ? await supabase.from('tracked_items').update(payload).eq('id',id).eq('user_id',userId)
      : await supabase.from('tracked_items').insert({user_id:userId,...payload})
    if(result.error) return alert(result.error.message)
    itemModal.close()
    renderDashboard(userId,email,id ? showArchived : false)
  })

  document.querySelector('#log-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const tracked_item_id=document.querySelector<HTMLSelectElement>('#log-item')!.value
    const item=itemList.find(i=>i.id===tracked_item_id)
    if(!item) return
    const amountRaw=document.querySelector<HTMLInputElement>('#log-amount')!.value
    const amount=amountRaw?Number(amountRaw):null
    const unit=document.querySelector<HTMLInputElement>('#log-unit')!.value.trim()||null
    const status=document.querySelector<HTMLSelectElement>('#log-status')!.value
    const when=document.querySelector<HTMLInputElement>('#log-time')!.value
    const injection_site=item.category==='injection'
      ? (document.querySelector<HTMLSelectElement>('#log-site')?.value||null) : null
    const route=document.querySelector<HTMLInputElement>('#log-route')?.value.trim()||null
    const noteText=document.querySelector<HTMLTextAreaElement>('#log-notes')!.value.trim()
    const notes=noteText||null
    const schedule_id=document.querySelector<HTMLInputElement>('#log-schedule-id')!.value||null
    const scheduled_for=document.querySelector<HTMLInputElement>('#log-scheduled-for')!.value||null
    const {error}=await supabase.from('logs').insert({
      user_id:userId,tracked_item_id,amount,unit,status,route,schedule_id,scheduled_for,
      logged_at:new Date(when).toISOString(),injection_site,notes
    })
    if(error) return alert(error.message)
    logModal.close()
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
