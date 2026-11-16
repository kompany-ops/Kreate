-- Guests: someone outside the account invited onto one shoot joins it on signing in, sees that shoot
-- and what it needs (its brand, product, people and the hooks on it) and nothing else of the account
-- (other shoots, brands, the Library, deals, chat), and doesn't count toward the plan's cast.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  owner_user uuid := gen_random_uuid();
  guest_user uuid := gen_random_uuid();
  org uuid;
  channel uuid;
  brand_one uuid;
  brand_two uuid;
  product_one uuid;
  product_two uuid;
  shoot_one uuid;
  shoot_two uuid;
  used_hook uuid;
  other_hook uuid;
  guest_person uuid;
  be_owner text := json_build_object('sub', owner_user, 'role', 'authenticated')::text;
  be_guest text := json_build_object('sub', guest_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values (owner_user, 'guest-host@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  -- a Studio account with two brands, a shoot for each, and a hook only one uses
  perform set_config('request.jwt.claims', be_owner, true);
  org := public.create_org('Guest Host', 'guest-host');
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan) values (org, 'cus_guest', 'sub_guest', 'active', 'studio');
  perform set_config('role', 'authenticated', true);
  insert into public.channels (name, slug, folder_slug) values ('One', 'one', 'one') returning id into channel;
  insert into public.brands (name, slug) values ('Brand One', 'brand-one') returning id into brand_one;
  insert into public.brands (name, slug) values ('Brand Two', 'brand-two') returning id into brand_two;
  insert into public.brand_deals (brand_id, pay_types, flat_fee) values (brand_one, array['flat'], 500);
  insert into public.products (brand_id, name, slug) values (brand_one, 'One Thing', 'one-thing') returning id into product_one;
  insert into public.products (brand_id, name, slug) values (brand_two, 'Two Thing', 'two-thing') returning id into product_two;
  insert into public.shoots (product_id) values (product_one) returning id into shoot_one;
  insert into public.shoots (product_id) values (product_two) returning id into shoot_two;
  insert into public.shoot_channels (shoot_id, channel_id) values (shoot_one, channel);
  insert into public.hook_templates (script) values ('The hook on the guest''s shoot') returning id into used_hook;
  insert into public.hook_templates (script) values ('A hook from the Library') returning id into other_hook;
  insert into public.org_messages (author_id, kind, body) values (owner_user, 'text', 'Team only');

  -- invite a guest onto shoot one, on channel one
  insert into public.org_invites (email, role, display_name, shoot_ids, channel_ids)
  values ('guest@example.com', 'cast', 'Guest Person', array[shoot_one], array[channel]);
  if (select cast_used from public.my_plan()) <> 0 then raise exception 'FAILED: a guest invitation counted as cast'; end if;

  -- they sign in: a member of just that shoot
  perform set_config('role', 'postgres', true);
  insert into auth.users (id, email, aud, role, email_confirmed_at) values (guest_user, 'guest@example.com', 'authenticated', 'authenticated', now());
  update public.profiles set active_org_id = org where id = guest_user;
  select id into guest_person from public.people where org_id = org and user_id = guest_user;
  if guest_person is null then raise exception 'FAILED: the guest has no person record'; end if;
  if not exists (select 1 from public.shoot_people where shoot_id = shoot_one and person_id = guest_person) then raise exception 'FAILED: the guest isn''t on their shoot'; end if;
  insert into public.shoot_items (org_id, shoot_id, person_id, kind, hook_template_id, code, script_snapshot)
  values (org, shoot_one, guest_person, 'hook', used_hook, 'H01', '"The hook on the guest''s shoot"');
  perform set_config('role', 'authenticated', true);

  -- as the guest
  perform set_config('request.jwt.claims', be_guest, true);
  if (select count(*) from public.shoots) <> 1 or not exists (select 1 from public.shoots where id = shoot_one) then raise exception 'FAILED: the guest sees other shoots'; end if;
  if (select count(*) from public.brands) <> 1 or (select count(*) from public.products) <> 1 then raise exception 'FAILED: the guest sees other brands or products'; end if;
  if exists (select 1 from public.brand_deals) then raise exception 'FAILED: the guest sees a deal'; end if;
  if not exists (select 1 from public.hook_templates where id = used_hook) then raise exception 'FAILED: the guest can''t see their shoot''s hook'; end if;
  if exists (select 1 from public.hook_templates where id = other_hook) then raise exception 'FAILED: the guest sees the Library'; end if;
  if exists (select 1 from public.org_messages) then raise exception 'FAILED: the guest sees the chat'; end if;
  if (select count(*) from public.org_members) <> 1 then raise exception 'FAILED: the guest sees the account''s members'; end if;
  if not exists (select 1 from public.shoot_items where shoot_id = shoot_one) then raise exception 'FAILED: the guest can''t see their shots'; end if;
  if not exists (select 1 from public.channels where id = channel) then raise exception 'FAILED: the guest can''t see their shoot''s channel'; end if;
  -- they can tick off their own shot once the owner has started the shoot
  perform set_config('request.jwt.claims', be_owner, true);
  update public.shoots set status = 'shooting' where id = shoot_one;
  perform set_config('request.jwt.claims', be_guest, true);
  update public.shoot_items set status = 'filmed' where shoot_id = shoot_one and person_id = guest_person;
  if (select status from public.shoot_items where shoot_id = shoot_one and person_id = guest_person) <> 'filmed' then raise exception 'FAILED: the guest couldn''t tick off their shot'; end if;

  -- the owner still sees everything, and the guest isn't one of the plan's cast
  perform set_config('request.jwt.claims', be_owner, true);
  if (select count(*) from public.shoots) <> 2 then raise exception 'FAILED: the guest rules hid shoots from the owner'; end if;
  if (select cast_used from public.my_plan()) <> 0 then raise exception 'FAILED: a guest counted as cast'; end if;

  perform set_config('role', 'postgres', true);
end $$;

select 'guests: all checks passed' as result;
rollback;
