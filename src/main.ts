import './styles.css'
import { supabase } from './supabase'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root not found')

type Item = { id:string; name:string; category:string; default_amount:number|null; default_unit:string|null; active:boolean }
type Log = { id:string; logged_at:string; amount:number|null; unit:string|null; status:string; tracked_items?: { name:string } | null }

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))

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
  const email=()=> (document.querySelector<HTMLInputElement>('#email')!.value.trim())
  const pass=()=> document.querySelector<HTMLInputElement>('#password')!.value
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

async function renderDashboard(userId:string,email:string) {
  const [{data:items},{data:logs}] = await Promise.all([
    supabase.from('tracked_items').select('id,name,category,default_amount,default_unit,active').eq('user_id',userId).eq('active',true).order('created_at',{ascending:false}),
    supabase.from('logs').select('id,logged_at,amount,unit,status,tracked_items(name)').eq('user_id',userId).order('logged_at',{ascending:false}).limit(8)
  ])
  const itemList=(items??[]) as Item[]
  const recent=(logs??[]) as unknown as Log[]
  app!.innerHTML=`
    <main class="app-shell">
      <header><div><div class="eyebrow">SCIENCE BY HUGs</div><div class="wordmark">PULSE</div></div><button class="ghost compact" id="signout">Sign out</button></header>
      <section class="welcome"><span class="kicker">LIVE DASHBOARD</span><h2>Good to see you.</h2><p class="muted">${esc(email)}</p></section>
      <section class="stats">
        <article><span>ACTIVE ITEMS</span><strong>${itemList.length}</strong></article>
        <article><span>RECENT LOGS</span><strong>${recent.length}</strong></article>
        <article><span>STATUS</span><strong class="online">● Ready</strong></article>
      </section>
      <section class="layout">
        <article class="panel"><div class="panel-head"><div><span class="kicker">TRACK</span><h3>Your items</h3></div><button class="primary compact" id="add-item">+ Add</button></div>
          <div class="rows">${itemList.length?itemList.map(i=>`<button class="row item-row" data-id="${i.id}"><span><b>${esc(i.name)}</b><small>${esc(i.category)}</small></span><span>${i.default_amount??''} ${esc(i.default_unit??'')}</span></button>`).join(''):'<p class="empty">Add your first tracked item to begin.</p>'}</div>
        </article>
        <article class="panel"><div class="panel-head"><div><span class="kicker">HISTORY</span><h3>Recent activity</h3></div></div>
          <div class="rows">${recent.length?recent.map(l=>`<div class="row"><span><b>${esc(l.tracked_items?.name??'Tracked item')}</b><small>${new Date(l.logged_at).toLocaleString()}</small></span><span>${l.amount??''} ${esc(l.unit??'')}</span></div>`).join(''):'<p class="empty">No activity logged yet.</p>'}</div>
        </article>
      </section>
      <dialog id="modal"><form id="item-form" method="dialog"><div class="panel-head"><h3>Add tracked item</h3><button class="ghost compact" value="cancel">Close</button></div>
        <label>Name<input id="item-name" required placeholder="e.g. Vitamin D"></label>
        <label>Category<select id="item-category"><option value="injection">Injection</option><option value="medication">Medication</option><option value="supplement">Supplement</option><option value="other">Other</option></select></label>
        <div class="split"><label>Default amount<input id="item-amount" type="number" min="0" step="any"></label><label>Unit<input id="item-unit" placeholder="mg, mL, tablet"></label></div>
        <button class="primary" type="submit">Save item</button>
      </form></dialog>
    </main>`
  document.querySelector('#signout')!.addEventListener('click',async()=>{await supabase.auth.signOut();renderAuth()})
  const modal=document.querySelector<HTMLDialogElement>('#modal')!
  document.querySelector('#add-item')!.addEventListener('click',()=>modal.showModal())
  document.querySelector('#item-form')!.addEventListener('submit',async e=>{
    e.preventDefault()
    const name=document.querySelector<HTMLInputElement>('#item-name')!.value.trim()
    const category=document.querySelector<HTMLSelectElement>('#item-category')!.value
    const amountRaw=document.querySelector<HTMLInputElement>('#item-amount')!.value
    const unit=document.querySelector<HTMLInputElement>('#item-unit')!.value.trim()
    const {error}=await supabase.from('tracked_items').insert({user_id:userId,name,category,default_amount:amountRaw?Number(amountRaw):null,default_unit:unit||null})
    if(error) return alert(error.message)
    modal.close(); renderDashboard(userId,email)
  })
  document.querySelectorAll<HTMLButtonElement>('.item-row').forEach(btn=>btn.addEventListener('click',async()=>{
    const item=itemList.find(i=>i.id===btn.dataset.id); if(!item) return
    const raw=prompt(`Log ${item.name} amount`,String(item.default_amount??''))
    if(raw===null) return
    const amount=raw.trim()===''?null:Number(raw)
    if(amount!==null && Number.isNaN(amount)) return alert('Enter a valid amount.')
    const {error}=await supabase.from('logs').insert({user_id:userId,tracked_item_id:item.id,amount,unit:item.default_unit,status:'completed'})
    if(error) return alert(error.message)
    renderDashboard(userId,email)
  }))
}

supabase.auth.onAuthStateChange((_event,session)=>{ if(!session) renderAuth() })
boot()
