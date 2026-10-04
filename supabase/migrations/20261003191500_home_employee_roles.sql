-- Include each connected employee's role in the owner-only context projection.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.account_context(uuid,uuid,uuid,text)'::regprocedure) into definition;
  if position('jsonb_build_object(''id'',online.id,''name'',online.name,''lastSeenAt'',online.last_seen_at)' in definition)=0
    or position('select e.id,e.name,max(activity.last_seen_at) as last_seen_at' in definition)=0
    or position('group by e.id,e.name' in definition)=0 then
    raise exception 'Unexpected account_context definition';
  end if;
  definition:=replace(definition,
    'jsonb_build_object(''id'',online.id,''name'',online.name,''lastSeenAt'',online.last_seen_at)',
    'jsonb_build_object(''id'',online.id,''name'',online.name,''role'',online.role,''lastSeenAt'',online.last_seen_at)');
  definition:=replace(definition,
    'select e.id,e.name,max(activity.last_seen_at) as last_seen_at',
    'select e.id,e.name,e.role,max(activity.last_seen_at) as last_seen_at');
  definition:=replace(definition,'group by e.id,e.name','group by e.id,e.name,e.role');
  execute definition;
end
$migration$;
