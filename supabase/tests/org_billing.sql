-- Billing: every org can use the app (Free is a plan), a subscription's plan sets the org's plan
-- while it's live, only the server can write billing rows, and someone reads only their own org's
-- subscription. Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  a_org uuid := (select id from public.orgs where slug = 'topdogugc');
  a_admin uuid := (select user_id from public.org_members where org_id = (select id from public.orgs where slug = 'topdogugc') and role = 'owner' limit 1);
  b_user uuid := gen_random_uuid();
  b_org uuid;
  be_a text := json_build_object('sub', a_admin, 'role', 'authenticated')::text;
  be_b text := json_build_object('sub', b_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values (b_user, 'billing-test@example.com', 'authenticated', 'authenticated');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_b, true);
  b_org := public.create_org('Billing Test', 'billing-test');

  -- a new org can use the app, on Free, and its creator owns it
  if not (select entitled from public.my_orgs() where id = b_org) then raise exception 'FAILED: a new org can''t use the app'; end if;
  if (select plan from public.my_plan()) <> 'free' then raise exception 'FAILED: a new org isn''t on Free'; end if;
  if (select role from public.my_orgs() where id = b_org) <> 'owner' then raise exception 'FAILED: the creator isn''t the owner'; end if;

  -- nobody writes billing but the server
  begin
    insert into public.org_subscriptions (org_id, stripe_customer_id, status) values (b_org, 'cus_fake', 'active');
    raise exception 'FAILED: someone wrote their own subscription';
  exception when insufficient_privilege then null;
  end;

  -- the server syncs a Pro trial: on Pro, with Klip for the trial
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan, trial_used)
  values (b_org, 'cus_test_billing', 'sub_test_billing', 'trialing', 'pro', true);

  perform set_config('role', 'authenticated', true);
  if (select plan from public.my_plan()) <> 'pro' then raise exception 'FAILED: a Pro trial isn''t on Pro'; end if;
  if (select klip_access from public.my_orgs() where id = b_org) <> 'trial' then raise exception 'FAILED: a trial doesn''t include Klip'; end if;
  if (select count(*) from public.org_subscriptions) <> 1 then raise exception 'FAILED: B sees other orgs'' billing'; end if;

  -- Studio includes Klip
  perform set_config('role', 'postgres', true);
  update public.org_subscriptions set status = 'active', plan = 'studio' where org_id = b_org;
  perform set_config('role', 'authenticated', true);
  if (select klip_access from public.my_orgs() where id = b_org) <> 'included' then raise exception 'FAILED: Studio doesn''t include Klip'; end if;

  -- cancelled: back on Free, still able to use the app
  perform set_config('role', 'postgres', true);
  update public.org_subscriptions set status = 'canceled' where org_id = b_org;
  perform set_config('role', 'authenticated', true);
  if (select plan from public.my_plan()) <> 'free' then raise exception 'FAILED: a cancelled org isn''t back on Free'; end if;
  if not (select entitled from public.my_orgs() where id = b_org) then raise exception 'FAILED: a cancelled org can''t use the app'; end if;

  -- the founding org is billing-exempt (Studio, no limits), and A can't see B's billing
  perform set_config('request.jwt.claims', be_a, true);
  if (select plan from public.my_plan()) <> 'studio' or (select team_limit from public.my_plan()) is not null then
    raise exception 'FAILED: the founding org isn''t on unlimited Studio';
  end if;
  if exists (select 1 from public.org_subscriptions where org_id = b_org) then raise exception 'FAILED: A sees B''s billing'; end if;

  perform set_config('role', 'postgres', true);
  raise notice 'org billing: all checks passed';
end $$;

rollback;
