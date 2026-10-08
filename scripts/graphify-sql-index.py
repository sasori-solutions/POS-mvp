"""Add auditable lexical SQL declarations; no claims about deployed/current schema."""
import argparse,json,re
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,default=Path.cwd())
parser.add_argument('--detect',type=Path,default=Path('graphify-out/.graphify_detect.json'))
parser.add_argument('--ast',type=Path,default=Path('graphify-out/.graphify_ast.json'))
args=parser.parse_args()
root=args.root.resolve()
d=json.loads(args.detect.read_text(encoding='utf-8'))
ast=json.loads(args.ast.read_text(encoding='utf-8'))
nodes={n['id']:n for n in ast['nodes']}; edges=list(ast['edges'])
normalize=lambda s:re.sub(r'[^a-z0-9]','_',s.lower())
def file_id(path):
    return normalize((path.parent.name+'_' if path.parent!=Path('.') else '')+path.stem)
def edge(a,b,rel,path,line):
    edges.append({'source':a,'target':b,'relation':rel,'confidence':'EXTRACTED','confidence_score':1.0,'source_file':path.as_posix(),'source_location':f'L{line}','weight':1.0,'_origin':'sql_lexical'})
pattern=re.compile(r'^[ \t]*CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*\.[a-z_][\w]*)',re.I|re.M)
declarations=[]
for abs_file in d['files']['code']:
    path=Path(abs_file).resolve().relative_to(root); fid=file_id(path)
    if fid not in nodes and not any(n.get('source_file')==path.as_posix() for n in nodes.values()):
        nodes[fid]={'id':fid,'label':path.name,'file_type':'code','source_file':path.as_posix(),'source_location':'L1','_origin':'file_inventory'}
    if path.suffix!='.sql': continue
    text=Path(abs_file).read_text(encoding='utf-8')
    for match in pattern.finditer(text):
        kind,name=match.group(1).lower(),match.group(2).lower()
        line=text.count('\n',0,match.start())+1
        nid='sql_'+kind+'_'+normalize(name)
        # Each name represents declarations throughout history, not a live overload signature.
        nodes[nid]={'id':nid,'label':name,'file_type':'code','source_file':path.as_posix(),'source_location':f'L{line}','_origin':'sql_lexical','entity_kind':'sql_'+kind+'_name','status':'declared_in_migration_history'}
        declarations.append((path,nid,line,name))
        edge(fid,nid,'declares',path,line)
declared_pairs={(path.as_posix(),name) for path,_,_,name in declarations}
known={n['label']:n['id'] for n in nodes.values() if n.get('_origin')=='sql_lexical'}
references=0
for abs_file in d['files']['code']:
    path=Path(abs_file).resolve().relative_to(root)
    if path.suffix!='.sql': continue
    fid=file_id(path); text=Path(abs_file).read_text(encoding='utf-8'); seen=set()
    for match in re.finditer(r'\b(?:app_private|public)\.[a-z_][\w]*\b',text,re.I):
        name=match.group().lower()
        if name not in known or name in seen or (path.as_posix(),name) in declared_pairs: continue
        # A name occurrence is lexical evidence only, including quoted/dynamic SQL.
        seen.add(name); references+=1
        edge(fid,known[name],'mentions_sql_name',path,text.count('\n',0,match.start())+1)
# Explicit Edge RPC names bridge languages as name matches, never as call edges.
rpc_matches=0
for abs_file in d['files']['code']:
    path=Path(abs_file).resolve().relative_to(root)
    if path.suffix not in {'.ts','.js','.mjs'} or 'supabase/functions' not in path.as_posix(): continue
    text=Path(abs_file).read_text(encoding='utf-8'); seen=set()
    for match in re.finditer(r"['\"]([a-z_][\w]*)['\"]",text):
        target=known.get('public.'+match.group(1))
        if not target or target in seen: continue
        seen.add(target); rpc_matches+=1
        edges.append({'source':file_id(path),'target':target,'relation':'matches_rpc_name',
                      'confidence':'INFERRED','confidence_score':0.95,
                      'source_file':path.as_posix(),'source_location':f'L{text.count(chr(10),0,match.start())+1}',
                      'weight':1.0,'_origin':'rpc_literal_match'})
print('Edge/SQL RPC name matches:',rpc_matches)
args.ast.write_text(json.dumps({'nodes':list(nodes.values()),'edges':edges,'input_tokens':0,'output_tokens':0},ensure_ascii=False),encoding='utf-8')
print('SQL supplement:',len(declarations),'declarations,',references,'name references')
print('Structural combined:',len(nodes),'nodes,',len(edges),'edges')
