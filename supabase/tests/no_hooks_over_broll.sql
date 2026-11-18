-- Hooks and CTAs are never over b-roll: no Over b-roll treatment anywhere, new accounts get only
-- Face to camera, and a standalone format can't show its hook or CTA beat over b-roll.
-- Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  mine uuid;
begin
  if exists (select 1 from public.treatments where component = 'layout' and settings ->> 'show' = 'broll' and system) then
    raise exception 'FAILED: an Over b-roll treatment is still there';
  end if;
  if exists (select 1 from public.formats where kind = 'standalone' and (beat_display ->> 'hook' = 'broll' or beat_display ->> 'cta' = 'broll')) then
    raise exception 'FAILED: a format still shows its hook or CTA over b-roll';
  end if;

  insert into auth.users (id, email, aud, role) values (me, 'no-broll-hooks@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  mine := public.create_org('No Broll Hooks', 'no-broll-hooks');
  perform set_config('role', 'postgres', true);
  if (select array_agg(name order by name) from public.treatments where org_id = mine) <> array['Face to camera'] then
    raise exception 'FAILED: a new account got %', (select array_agg(name) from public.treatments where org_id = mine);
  end if;

  begin
    insert into public.formats (org_id, code, name, kind, beats, beat_display)
    values (mine, 'FX1', 'Bad', 'standalone', array['hook', 'problem', 'cta'], '{"hook": "broll"}');
    raise exception 'FAILED: a standalone format saved its hook over b-roll';
  exception when check_violation then null;
  end;
  insert into public.formats (org_id, code, name, kind, beats, beat_display)
  values (mine, 'FX2', 'Fine', 'standalone', array['hook', 'problem', 'cta'], '{"hook": "face", "problem": "broll", "cta": "screen"}');
end $$;

select 'no hooks over b-roll: all checks passed' as result;
rollback;
