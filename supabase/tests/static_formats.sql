-- Static formats: the team adds and changes them, cast only read them, another account sees none,
-- and slot keys are snake case and unique. Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  mine uuid;
  theirs uuid;
  format uuid;
  n bigint;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
  be_other text := json_build_object('sub', other, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'statics-owner@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'statics-cast@example.com', 'authenticated', 'authenticated'),
    (other, 'statics-other@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', be_other, true);
  theirs := public.create_org('Other Statics', 'other-statics');
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Statics', 'statics-test');

  perform set_config('role', 'postgres', true);
  insert into public.org_members (org_id, user_id, role) values (mine, cast_user, 'cast');
  update public.profiles set active_org_id = mine where id = cast_user;
  perform set_config('role', 'authenticated', true);

  -- the team adds one
  insert into public.static_formats (code, name, slots, variants)
  values ('SF01', 'Notes app', '[{"key": "headline", "label": "Headline", "max_words": 8, "required": true}]', '{text,text_product}')
  returning id into format;

  -- slot keys must be snake case, and unique
  begin
    update public.static_formats set slots = '[{"key": "Head Line"}]' where id = format;
    raise exception 'FAILED: a slot key that isn''t snake case was kept';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.static_formats set slots = '[{"key": "headline"}, {"key": "headline"}]' where id = format;
    raise exception 'FAILED: two slots with one key were kept';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.static_formats set variants = '{text,carousel}' where id = format;
    raise exception 'FAILED: an unknown variant was kept';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- cast read it but can't change or add one
  perform set_config('request.jwt.claims', be_cast, true);
  if not exists (select 1 from public.static_formats where id = format) then
    raise exception 'FAILED: cast can''t see the account''s static formats';
  end if;
  update public.static_formats set name = 'Cast was here' where id = format;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: cast changed a static format'; end if;
  begin
    insert into public.static_formats (code, name) values ('SF02', 'Cast format');
    raise exception 'FAILED: cast added a static format';
  exception when insufficient_privilege then null;
  end;

  -- another account sees none of it
  perform set_config('request.jwt.claims', be_other, true);
  if exists (select 1 from public.static_formats where id = format) then
    raise exception 'FAILED: another account can see the static format';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'static_formats: all passed';
end $$;

rollback;
