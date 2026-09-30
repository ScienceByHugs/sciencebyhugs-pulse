import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../supabase/functions/pulse-push/index.ts', import.meta.url), 'utf8').replace(/^import .*$/mg, '')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

for (const legacy of [true, false]) {
  test(`push worker starts with ${legacy ? 'stable service JWT' : 'modern key fallback'}`, () => {
    const env = { SUPABASE_URL: 'https://project.test', SUPABASE_DB_URL: 'postgres://example', SUPABASE_SECRET_KEYS: '{"default":"modern-secret"}', ...(legacy ? { SUPABASE_SERVICE_ROLE_KEY: 'stable-service-jwt' } : {}) }
    let credential, handler
    runInNewContext(js, {
      exports: {},
      Deno: { env: { get: name => env[name] }, serve: fn => { handler = fn } },
      createClient: (url, key) => { credential = key; return {} },
      postgres: () => ({}),
    })
    assert.equal(credential, legacy ? 'stable-service-jwt' : 'modern-secret')
    assert.equal(typeof handler, 'function')
  })
}
