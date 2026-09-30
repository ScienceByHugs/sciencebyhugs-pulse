import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source=fs.readFileSync(new URL('../src/account.ts',import.meta.url),'utf8')
  .replace(/^import .*$/gm,'').replaceAll('import.meta.env.BASE_URL',"'/'")
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
async function setup({signInError=null,updateError=null}={}){
  const nodes=new Map()
  const node=selector=>{
    if(!nodes.has(selector)) nodes.set(selector,{value:'',textContent:'',disabled:false,listeners:{},addEventListener(event,fn){this.listeners[event]=fn},querySelector(){return node(selector+' button')},reset(){this.wasReset=true}})
    return nodes.get(selector)
  }
  const calls=[]
  const context={exports:{},Error,URL,document:{querySelector:node},window:{location:{origin:'https://pulse.sciencebyhugs.com'}},pushPanel:()=>'<section class="push-panel"></section>',supabase:{auth:{
    async getSession(){return {data:{session:{user:{user_metadata:{display_name:'Anthony'}}}}}},
    async updateUser(value){calls.push(['update',value]);return {error:updateError}},
    async signInWithPassword(value){calls.push(['signIn',value]);return {error:signInError}},
    async resetPasswordForEmail(...args){calls.push(['reset',...args]);return {error:null}},
  }}}
  vm.runInNewContext(code,context)
  await context.exports.bindAccount('test@example.com')
  return {node,calls,screen:context.exports.accountScreen,submit:selector=>node(selector).listeners.submit({preventDefault(){}})}
}

test('profile loads and saves only display metadata, with trimmed name',async()=>{
  const s=await setup()
  assert.equal(s.node('#account-name').value,'Anthony')
  s.node('#account-name').value='  New name  '
  await s.submit('#account-profile-form')
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls)),[['update',{data:{display_name:'New name'}}]])
  assert.equal(s.node('#account-profile-status').textContent,'Profile saved.')
  assert.equal(s.node('#account-profile-form button').disabled,false)
})
test('password mismatch and failed current password prevent updates',async()=>{
  const s=await setup({signInError:new Error('Invalid login credentials')})
  s.node('#account-new-password').value='new-password'
  s.node('#account-confirm-password').value='different'
  await s.submit('#account-password-form')
  assert.equal(s.calls.length,0)
  s.node('#account-confirm-password').value='new-password'
  s.node('#account-current-password').value='incorrect'
  await s.submit('#account-password-form')
  assert.equal(s.calls.length,1)
  assert.equal(s.calls[0][0],'signIn')
  assert.equal(s.node('#account-password-status').textContent,'Invalid login credentials')
  assert.equal(s.node('#account-password-form button').disabled,false)
})
test('password change authenticates first and clears fields only after success',async()=>{
  const s=await setup()
  s.node('#account-current-password').value='old-password'
  s.node('#account-new-password').value='new-password'
  s.node('#account-confirm-password').value='new-password'
  await s.submit('#account-password-form')
  assert.deepEqual(s.calls.map(c=>c[0]),['signIn','update'])
  assert.equal(s.node('#account-password-form').wasReset,true)
  assert.equal(s.node('#account-password-status').textContent,'Password updated.')
})
test('profile errors remain retryable and markup escapes email',async()=>{
  const s=await setup({updateError:new Error('Try again')})
  await s.submit('#account-profile-form')
  assert.equal(s.node('#account-profile-status').textContent,'Try again')
  assert.equal(s.node('#account-profile-form button').disabled,false)
  assert.ok(s.screen('\"><script>alert(1)</script>').includes('&quot;&gt;&lt;script&gt;'))
  assert.equal(s.screen('test@example.com').match(/class="push-panel"/g).length,1)
})
test('password recovery returns to the deployed app origin',async()=>{
  const s=await setup()
  await s.node('#account-reset-password').listeners.click()
  assert.equal(s.calls[0][1],'test@example.com')
  assert.equal(s.calls[0][2].redirectTo,'https://pulse.sciencebyhugs.com/')
})
