-- A shoot's statics: copy is written for a static format on the shoot, while it's a draft, and frozen
-- once planned; stills are planned by the team and ticked off by cast, who can't change or skip
-- them; deleting a draft shoot takes it all. Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  other_format uuid;
  format uuid;
  copy uuid;
  still uuid;
  n bigint;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'static-shoots@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'static-shoots-cast@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Static Shoots', 'static-shoots');
  perform set_config('role', 'postgres', true);
  insert into public.org_members (org_id, user_id, role) values (mine, cast_user, 'cast');
  update public.profiles set active_org_id = mine where id = cast_user;
  perform set_config('role', 'authenticated', true);

  insert into public.brands (name, slug) values ('Brand', 'brand-static-shoots');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-static-shoots' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into shoot;
  insert into public.static_formats (code, name, slots) values ('SF01', 'Notes app', '[{"key": "headline"}]') returning id into format;
  insert into public.static_formats (code, name) values ('SF02', 'Banner') returning id into other_format;
  insert into public.shoot_static_formats (shoot_id, static_format_id) values (shoot, format);

  -- copy is for a format on the shoot
  insert into public.static_copies (shoot_id, static_format_id, product_id, code, slots)
  values (shoot, format, product, 'A01', '[{"slot": "headline", "text": "My dog finally eats", "alternates": [{"text": "Dinner, solved"}]}]')
  returning id into copy;
  begin
    insert into public.static_copies (shoot_id, static_format_id, product_id, code) values (shoot, other_format, product, 'A02');
    raise exception 'FAILED: copy was written for a format that isn''t on the shoot';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.static_copies (shoot_id, static_format_id, product_id, code) values (shoot, format, product, 'A01');
    raise exception 'FAILED: two copies with one code';
  exception when unique_violation then null;
  end;

  -- stills: the team plans them
  insert into public.still_shots (shoot_id, kind, description) values (shoot, 'product', 'Product hero') returning id into still;
  begin
    insert into public.still_shots (shoot_id, kind, description, feature_id) values (shoot, 'avatar', 'Portrait', (select id from public.product_features limit 1));
    if (select count(*) from public.product_features) > 0 then raise exception 'FAILED: an avatar still took a feature'; end if;
  exception when check_violation then null;
  end;

  -- planned: the copy is frozen
  perform set_config('role', 'postgres', true);
  update public.shoots set status = 'planned' where id = shoot;
  perform set_config('role', 'authenticated', true);
  begin
    update public.static_copies set slots = '[]' where id = copy;
    raise exception 'FAILED: copy changed on a planned shoot';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
    if sqlerrm not like '%frozen%' then raise exception 'FAILED: wrong error: %', sqlerrm; end if;
  end;

  -- cast can't film before it starts, or change the still, or skip it; once started they tick it off
  perform set_config('request.jwt.claims', be_cast, true);
  begin
    update public.still_shots set photos_filmed = 1 where id = still;
    raise exception 'FAILED: cast added photos before the shoot started';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', be_me, true);
  update public.shoots set status = 'shooting' where id = shoot;
  perform set_config('request.jwt.claims', be_cast, true);
  perform set_config('role', 'authenticated', true);
  update public.still_shots set photos_filmed = 3, status = 'filmed' where id = still;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: cast couldn''t tick a still off'; end if;
  begin
    update public.still_shots set description = 'cast was here' where id = still;
    raise exception 'FAILED: cast changed a still';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.still_shots set status = 'skipped' where id = still;
    raise exception 'FAILED: cast skipped a still';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- back to a draft and deleted: it all goes
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', be_me, true);
  update public.shoots set status = 'draft' where id = shoot;
  delete from public.shoots where id = shoot;
  if exists (select 1 from public.static_copies where id = copy) or exists (select 1 from public.still_shots where id = still) then
    raise exception 'FAILED: the shoot''s statics outlived it';
  end if;

  raise notice 'static_shoots: all passed';
end $$;

rollback;
