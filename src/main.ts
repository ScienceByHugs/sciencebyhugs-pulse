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
  injection_site:string|null; notes:string|null; tracked_items?: { name:string; category:string } | null
}

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const titleCase=(v:string)=>v.charAt(0).toUpperCase()+v.slice(1)
const localInputValue=(d=new Date())=>{
  const pad=(n:number)=>String(n).padStart(2,'0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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
    const {error}=await supabase.auth.signUp({email:email(),password:pass()})
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
  const [{data:items,error:itemError},{data:logs,error:logError}] = await Promise.all([
    supabase.from('tracked_items')
      .select('id,name,category,default_amount,default_unit,route,notes,active')
      .eq('user_id',userId).eq('active',!showArchived).order('created_at',{ascending:false}),
    supabase.from('logs')
      .select('id,logged_at,amount,unit,status,injection_site,notes,tracked_items(name,category)')
      .eq('user_id',userId).order('logged_at',{ascending:false}).limit(8)
  ])
  if(itemError || logError) {
    app!.innerHTML=`<main class="app-shell"><div class="notice">Unable to load PULSE: ${esc(itemError?.message??logError?.message)}</div></main>`
    return
  }

  const itemList=(items??[]) as Item[]
  const recent=(logs??[]) as unknown as Log[]

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

      <section class="stats">
        <article><span>${showArchived?'ARCHIVED':'ACTIVE'} ITEMS</span><strong>${itemList.length}</strong></article>
        <article><span>RECENT LOGS</span><strong>${recent.length}</strong></article>
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

      <dialog id="log-modal">
        <form id="log-form">
          <div class="panel-head"><div><span class="kicker" id="log-kicker">QUICK LOG</span><h3 id="log-title">Log item</h3></div><button class="ghost compact modal-close" type="button">Close</button></div>
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

  const fillLog=(item:Item)=>{
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
    document.querySelector<HTMLElement>('#category-fields')!.innerHTML=categoryFields(item)
  }

  const openLog=(item:Item)=>{ fillLog(item); logModal.showModal() }

  document.querySelector('#add-item')!.addEventListener('click',()=>openItem())
  document.querySelector('#quick-log')?.addEventListener('click',()=>{ if(itemList[0]) openLog(itemList[0]) })

  document.querySelector('#log-item')!.addEventListener('change',e=>{
    const id=(e.target as HTMLSelectElement).value
    const item=itemList.find(i=>i.id===id)
    if(item) fillLog(item)
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
    renderDashboard(userId,email,showArchived)
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
    const {error}=await supabase.from('logs').insert({
      user_id:userId,tracked_item_id,amount,unit,status,route,
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
    if(action==='edit') return openItem(item)
    if(action==='archive' || action==='restore'){
      const active=action==='restore'
      const {error}=await supabase.from('tracked_items').update({active,updated_at:new Date().toISOString()}).eq('id',item.id).eq('user_id',userId)
      if(error) return alert(error.message)
      renderDashboard(userId,email,showArchived)
    }
  }))
}

supabase.auth.onAuthStateChange((_event,session)=>{ if(!session) renderAuth() })
boot()
