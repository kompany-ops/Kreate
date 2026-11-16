-- My shoots: across accounts, the shoots you're on camera for, plus your team's shoots that aren't
-- Live yet; nothing from accounts you're not in, and nothing stale.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  mine uuid;
  theirs uuid;
  channel uuid;
  product uuid;
  person uuid;
  filmed_shoot uuid;
  live uuid;
  stale uuid;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_other text := json_build_object('sub', other, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'my-shoots@example.com', 'authenticated', 'authenticated'),
    (other, 'not-mine@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  -- someone else's account, with a shoot
  perform set_config('request.jwt.claims', be_other, true);
  theirs := public.create_org('Not Mine', 'not-mine');
  insert into public.brands (name, slug) values ('Theirs', 'theirs');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'theirs' and org_id = theirs), 'P', 'p') returning id into product;
  insert into public.shoots (product_id) values (product);

  -- my account: a draft I'm on camera for, a Live one, a stale one
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Mine', 'mine-shoots');
  insert into public.channels (name, slug, folder_slug) values ('One', 'one', 'one') returning id into channel;
  perform public.set_channel_members(channel, array[me]);
  select id into person from public.people where org_id = mine and user_id = me;
  insert into public.brands (name, slug) values ('My Brand', 'my-brand');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'my-brand' and org_id = mine), 'Q', 'q') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into filmed_shoot;
  insert into public.shoot_people (shoot_id, person_id) values (filmed_shoot, person);
  insert into public.shoots (product_id) values (product) returning id into live;
  insert into public.shoots (product_id) values (product) returning id into stale;
  perform set_config('role', 'postgres', true);
  update public.shoots set status = 'edited' where id = live;
  update public.shoots set stale_at = now() where id = stale;
  perform set_config('role', 'authenticated', true);

  if (select count(*) from public.my_shoots()) <> 1 then raise exception 'FAILED: expected just the one shoot, got %', (select count(*) from public.my_shoots()); end if;
  if not (select on_camera from public.my_shoots()) then raise exception 'FAILED: on camera isn''t marked'; end if;
  if exists (select 1 from public.my_shoots() where org_id = theirs) then raise exception 'FAILED: another account''s shoot showed'; end if;

  perform set_config('role', 'postgres', true);
end $$;

select 'my shoots: all checks passed' as result;
rollback;
