-- Treatments are one set for everyone, read-only from the app; each shoot can switch some off
-- until it goes to editing. Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  face uuid;
  seen int;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values (me, 'shared-treatments@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Shared Treatments', 'shared-treatments');

  -- a new account sees every treatment, and gets none of its own
  select count(*) into seen from public.treatments;
  if seen = 0 then
    raise exception 'FAILED: a new account sees no treatments';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.treatments) <> seen then
    raise exception 'FAILED: the new account sees % of % treatments', seen, (select count(*) from public.treatments);
  end if;
  perform set_config('role', 'authenticated', true);
  select id into face from public.treatments where system limit 1;

  -- nobody changes them from the app
  begin
    update public.treatments set name = 'Mine now' where id = face;
    raise exception 'FAILED: a treatment was changed from the app';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    insert into public.treatments (name, kind, placement, component) values ('My own', 'overlay', 'hook', 'search_bar');
    raise exception 'FAILED: a treatment was added from the app';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- a shoot switches one off, while it's being planned
  insert into public.brands (name, slug) values ('Brand', 'brand-treatments');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-treatments' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into shoot;
  update public.shoots set treatments_off = array[face] where id = shoot;
  if (select treatments_off from public.shoots where id = shoot) <> array[face] then
    raise exception 'FAILED: the shoot didn''t keep its treatment off';
  end if;

  -- once it's gone to editing, they're the ones Klip was given
  perform set_config('role', 'postgres', true);
  update public.shoots set status = 'editing' where id = shoot;
  perform set_config('role', 'authenticated', true);
  begin
    update public.shoots set treatments_off = '{}' where id = shoot;
    raise exception 'FAILED: treatments changed on a shoot in editing';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
    if sqlerrm not like '%Klip was given%' then raise exception 'FAILED: wrong error: %', sqlerrm; end if;
  end;

  raise notice 'shared_treatments: all passed';
end $$;

rollback;
