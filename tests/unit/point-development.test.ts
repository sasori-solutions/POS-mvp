import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,dirname,join,resolve} from 'node:path'
import {expect,test} from 'vitest'
// @ts-expect-error The local HTTP simulator is Node tooling outside the frontend project.
import {startSimulator} from '../provider/simulator.mjs'
import {configuration} from '../../supabase/functions/point/service'
import {createPayload,MercadoPagoPoint,record,verifyOrder} from '../../supabase/functions/point/provider'
import {randomSecret} from '../../supabase/functions/point/crypto'

test('the local authorization callback accepts only loopback and keeps the OAuth state',async()=>{
  const sim=await startSimulator()
  try {
    const query=new URLSearchParams({client_id:'sim-client',redirect_uri:'http://127.0.0.1:5173/point/callback',state:'a'.repeat(43),code_challenge:'b'.repeat(43),code_challenge_method:'S256'})
    const response=await fetch(`${sim.url}/authorization?${query}`,{redirect:'manual'})
    expect(response.status).toBe(302)
    const callback=new URL(response.headers.get('location')!)
    expect(callback.searchParams.get('state')).toBe('a'.repeat(43))
    expect(callback.searchParams.get('code')).toBe('sim-code')
    query.set('redirect_uri','https://external.example/point/callback')
    expect((await fetch(`${sim.url}/authorization?${query}`,{redirect:'manual'})).status).toBe(400)
  } finally { await sim.close() }
})

test('the browser simulator authorization override fails closed outside local sandbox',()=>{
  const values:Record<string,string>={MP_CLIENT_ID:'sim-client',MP_CLIENT_SECRET:'sim-secret',MP_REDIRECT_URI:'http://127.0.0.1:5173/point/callback',MP_ENVIRONMENT:'sandbox',SUPABASE_URL:'http://kong:8000',MP_ALLOW_LOCAL_SIMULATOR:'true',MP_API_BASE_URL:'http://host.docker.internal:8187',MP_OAUTH_AUTHORIZATION_URL:'http://127.0.0.1:8187/authorization',MP_TOKEN_KEYS:'{"ci":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"}',MP_TOKEN_ACTIVE_KEY:'ci'}
  expect(configuration(name=>values[name]).authorizationUrl).toBe(values.MP_OAUTH_AUTHORIZATION_URL)
  for(const changes of [{MP_ENVIRONMENT:'live'},{SUPABASE_URL:'https://shared.supabase.co'},{MP_ALLOW_LOCAL_SIMULATOR:'false'},{MP_OAUTH_AUTHORIZATION_URL:'https://external.example/authorization'}]) {
    expect(()=>configuration(name=>({...values,...changes})[name])).toThrow('POINT_CONFIGURATION_REQUIRED')
  }
})

test('restarting the development HTTP provider preserves orders and their idempotency keys',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pos-point-dev-'))
  if(dirname(resolve(directory))!==resolve(tmpdir()) || !basename(directory).startsWith('pos-point-dev-')) throw new Error('Unsafe temporary fixture path')
  const stateFile=join(directory,'simulator.json')
  const expected={amountCents:1001,currency:'MXN',receiverId:'900001',environment:'sandbox' as const,externalReference:'sasori_development_attempt',terminalId:'NEWLAND_N950__SERIAL-1'}
  let sim=await startSimulator({stateFile,realtime:true})
  const adapter=()=>new MercadoPagoPoint({clientId:'sim-client',clientSecret:'sim-secret',redirectUri:'http://127.0.0.1:5173/point/callback',baseUrl:sim.url,allowLocalSimulator:true})
  try {
    const token=await adapter().exchange('sim-code',randomSecret(),'sandbox')
    const first=await adapter().create(token,createPayload(expected),'same-development-attempt')
    await sim.close()
    sim=await startSimulator({stateFile,realtime:true})
    const replay=await adapter().create(token,createPayload(expected),'same-development-attempt')
    expect(replay.id).toBe(first.id)
    expect(sim.state.creates).toBe(1)
    const payment=record((record(replay.transactions).payments as unknown[])[0])
    const proof=await adapter().request(token,`/v1/payments/${payment.reference_id}`)
    expect(verifyOrder(replay,expected,token,proof).verified).toBe(true)
  } finally {
    await sim.close()
    await rm(directory,{recursive:true,force:true})
  }
})
