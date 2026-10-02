// Builds reviewable dashboard artifacts; does not deploy or read credentials.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildAccountSource } from './build-account-source.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const { source, edge } = buildAccountSource()
writeFileSync('/tmp/pos-employee-device-account-cloud.ts',edge)
const rows=JSON.parse(readFileSync('/tmp/pos-employee-device-canonical-ledger.json','utf8'))
if(rows.length!==8 || rows[7].version!=='20261001000800') throw Error('Run the employee-device migration compatibility smoke first')
const literal = (value,index) => { let tag='pos_device_'+index+'_'+hash(value).slice(0,12); while(value.includes('$'+tag+'$')) tag+='_x';return '$'+tag+'$'+value+'$'+tag+'$' }
const prior=rows.slice(0,7)
const guard=`do $history_guard$ begin if (select count(*) from supabase_migrations.schema_migrations)<>7\n${prior.map((r,i)=>`or not exists(select 1 from supabase_migrations.schema_migrations where version='${r.version}' and name='${r.name}' and statements=array[${r.statements.map((v,j)=>literal(v,i+'_'+j)).join(',')}]::text[])`).join('\n')}\nthen raise exception 'Expected exact 0001-0007 ledger; no changes applied.'; end if; end $history_guard$;\n`
const migration=readFileSync('supabase/migrations/20261001000800_employee_device_notifications.sql','utf8')
const row=rows[7]
const sql='begin;\n'+guard+'\n'+migration+`\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${row.version}','${row.name}',array[${row.statements.map(literal).join(',')}]::text[]);\ncommit;\n`
writeFileSync('/tmp/pos-employee-device-migration-with-history.sql',sql)
const metadata={edge:{path:'/tmp/pos-employee-device-account-cloud.ts',bytes:Buffer.byteLength(edge),sha256:hash(edge)},migration:{path:'/tmp/pos-employee-device-migration-with-history.sql',bytes:Buffer.byteLength(sql),sha256:hash(sql)},sources:source.map(s=>({path:s.path,sha256:hash(s.text)})),canonicalStatements:row.statements.length}
writeFileSync('/tmp/pos-employee-device-release.json',JSON.stringify(metadata,null,2)+'\n')
console.log(JSON.stringify(metadata,null,2))
