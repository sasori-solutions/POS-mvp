// Builds reviewable dashboard artifacts; does not deploy or read credentials.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildAccountSource } from './build-account-source.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const { source, edge } = buildAccountSource()
writeFileSync('/tmp/pos-pin-email-account-cloud.ts',edge)
const rows=JSON.parse(readFileSync('/tmp/pos-pin-email-canonical-ledger.json','utf8'))
if(rows.length!==7 || rows[6].version!=='20261001000700') throw Error('Run the email migration compatibility smoke first')
const literal = (value,index) => { let tag='pos_email_'+index+'_'+hash(value).slice(0,12); while(value.includes('$'+tag+'$')) tag+='_x';return '$'+tag+'$'+value+'$'+tag+'$' }
const prior=rows.slice(0,6)
const guard=`do $history_guard$ begin if (select count(*) from supabase_migrations.schema_migrations)<>6\n${prior.map((r,i)=>`or not exists(select 1 from supabase_migrations.schema_migrations where version='${r.version}' and name='${r.name}' and statements=array[${r.statements.map((v,j)=>literal(v,i+'_'+j)).join(',')}]::text[])`).join('\n')}\nthen raise exception 'Expected exact 0001-0006 ledger; no changes applied.'; end if; end $history_guard$;\n`
const migration=readFileSync('supabase/migrations/20261001000700_pin_recovery_email.sql','utf8')
const row=rows[6]
const sql='begin;\n'+guard+'\n'+migration+`\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${row.version}','${row.name}',array[${row.statements.map(literal).join(',')}]::text[]);\ncommit;\n`
writeFileSync('/tmp/pos-pin-email-migration-with-history.sql',sql)
const metadata={edge:{path:'/tmp/pos-pin-email-account-cloud.ts',bytes:Buffer.byteLength(edge),sha256:hash(edge)},migration:{path:'/tmp/pos-pin-email-migration-with-history.sql',bytes:Buffer.byteLength(sql),sha256:hash(sql)},sources:source.map(s=>({path:s.path,sha256:hash(s.text)})),canonicalStatements:row.statements.length}
writeFileSync('/tmp/pos-pin-email-release.json',JSON.stringify(metadata,null,2)+'\n')
console.log(JSON.stringify(metadata,null,2))
