-- Brand kits: one per brand, the team sets it, cast read it, another account sees none, and it goes
-- with its brand. Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  mine uuid;
  brand uuid;
  n bigint;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
  be_other text := json_build_object('sub', other, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'kits-owner@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'kits-cast@example.com', 'authenticated', 'authenticated'),
    (other, 'kits-other@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', be_other, true);
  perform public.create_org('Other Kits', 'other-kits');
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Kits', 'kits-test');
  perform set_config('role', 'postgres', true);
  insert into public.org_members (org_id, user_id, role) values (mine, cast_user, 'cast');
  update public.profiles set active_org_id = mine where id = cast_user;
  perform set_config('role', 'authenticated', true);

  insert into public.brands (name, slug) values ('Brand', 'brand-kits-test') returning id into brand;

  -- the team sets the kit, once per brand
  insert into public.brand_kits (brand_id, colors, style_notes) values (brand, '[{"name": "Primary", "hex": "#ff6600"}]', 'Warm, hand-made');
  begin
    insert into public.brand_kits (brand_id) values (brand);
    raise exception 'FAILED: a brand got two kits';
  exception when unique_violation then null;
  end;
  begin
    update public.brand_kits set colors = '{"not": "a list"}' where brand_id = brand;
    raise exception 'FAILED: colours that aren''t a list were kept';
  exception when check_violation then null;
  end;

  -- cast read it, and can't change it
  perform set_config('request.jwt.claims', be_cast, true);
  if not exists (select 1 from public.brand_kits where brand_id = brand) then
    raise exception 'FAILED: cast can''t see the brand kit';
  end if;
  update public.brand_kits set style_notes = 'cast' where brand_id = brand;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: cast changed a brand kit'; end if;

  -- another account sees nothing
  perform set_config('request.jwt.claims', be_other, true);
  if exists (select 1 from public.brand_kits where brand_id = brand) then
    raise exception 'FAILED: another account can see the brand kit';
  end if;

  -- it goes with its brand
  perform set_config('role', 'postgres', true);
  delete from public.brands where id = brand;
  if exists (select 1 from public.brand_kits where brand_id = brand) then
    raise exception 'FAILED: the kit outlived its brand';
  end if;

  raise notice 'brand_kits: all passed';
end $$;

rollback;
