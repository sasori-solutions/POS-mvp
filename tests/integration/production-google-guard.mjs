/** Run against loopback account with ALLOW_TEST_PASSWORD_AUTH=false (production gate).
 * Adds a synthetic linked Google identity locally and obtains real password/magiclink JWTs.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
const config=JSON.parse(execFileSync('./node_modules/.bin/supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(config.API_URL).hostname),'Loopback required')
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
let userId
try {
  const credentials={email:`guard-${randomUUID()}@example.test`,password:`local-only-${randomUUID()}-Aa9!`}
  const created=await admin.auth.admin.createUser({...credentials,email_confirm:true})
  assert.equal(created.error,null);userId=created.data.user.id;assert.match(userId,/^[a-f0-9-]{36}$/i)
  const identityId=randomUUID()
  execFileSync('docker',['exec','-i','supabase_db_pos-mexico-pwa','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-c',`insert into auth.identities(id,user_id,provider_id,provider,identity_data,created_at,updated_at,last_sign_in_at) values('${identityId}'::uuid,'${userId}'::uuid,'${identityId}','google',jsonb_build_object('sub','${identityId}','email','${credentials.email}','email_verified',true),now(),now(),now());`],{stdio:['ignore','pipe','pipe']})
  const client=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
  const password=await client.auth.signInWithPassword(credentials);assert.equal(password.error,null)
  const linked=await admin.auth.getUser(password.data.session.access_token);assert(linked.data.user.identities.some(identity=>identity.provider==='google'))
  const generated=await admin.auth.admin.generateLink({type:'magiclink',email:credentials.email});assert.equal(generated.error,null)
  const magic=await client.auth.verifyOtp({type:'magiclink',token_hash:generated.data.properties.hashed_token});assert.equal(magic.error,null)
  for(const session of [password.data.session,magic.data.session]) {
    const claims=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString('utf8'))
    assert(claims.amr.some(entry=>['password','magiclink','otp'].includes(entry.method)))
    for(const payload of [{action:'status'},{action:'reset_pin',businessId:randomUUID(),pin:'024680',recoveryCode:'a'.repeat(64),operationId:randomUUID()}]) {
      const response=await fetch(`${config.API_URL}/functions/v1/account`,{method:'POST',headers:{apikey:config.ANON_KEY,authorization:`Bearer ${session.access_token}`,'content-type':'application/json'},body:JSON.stringify(payload)})
      assert.equal(response.status,403,'Production mode must reject non-Google authentication')
      assert.equal((await response.json()).error.code,'GOOGLE_REQUIRED')
    }
  }
  console.log('PASS production Google gate on real loopback Auth: linked-Google password and magiclink JWTs cannot read account or reset PIN.')
} finally {
  if(userId) { const result=await admin.auth.admin.deleteUser(userId);if(result.error)throw new Error('Synthetic guard account cleanup failed') }
}
