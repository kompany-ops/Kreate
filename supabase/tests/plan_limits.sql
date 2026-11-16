-- Plan limits: each limit stops the next one on Free and lets it through on the plan above; a
-- shoot counts once, when it's first marked Planned; billing-exempt orgs have no limits.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  org uuid;
  a_product uuid;
  a_shoot uuid;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values (me, 'plan-test@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  org := public.create_org('Plan Test', 'plan-test');

  -- Free: one brand, one channel, one cast member, just the owner on the team
  insert into public.brands (name, slug) values ('First', 'first');
  begin
    insert into public.brands (name, slug) values ('Second', 'second');
    raise exception 'FAILED: Free allowed a second brand';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  insert into public.channels (name, slug, folder_slug) values ('One', 'one', 'one');
  begin
    insert into public.channels (name, slug, folder_slug) values ('Two', 'two', 'two');
    raise exception 'FAILED: Free allowed a second channel';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  insert into public.org_invites (email, role) values ('cast-one@example.com', 'cast');
  begin
    insert into public.org_invites (email, role) values ('cast-two@example.com', 'cast');
    raise exception 'FAILED: Free allowed a second cast member';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    insert into public.org_invites (email, role) values ('team-one@example.com', 'team');
    raise exception 'FAILED: Free allowed a second team member';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- Starter: room for more
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan)
  values (org, 'cus_plan_test', 'sub_plan_test', 'active', 'starter');
  perform set_config('role', 'authenticated', true);
  insert into public.brands (name, slug) values ('Second', 'second');
  insert into public.org_invites (email, role) values ('cast-two@example.com', 'cast');
  if (select brands_used from public.my_plan()) <> 2 or (select cast_used from public.my_plan()) <> 2 then
    raise exception 'FAILED: usage doesn''t count what was added';
  end if;

  -- shoots: counted once, when first marked Planned (the server plans them here, as the guard
  -- that only the team plans is tested elsewhere; counting doesn't depend on who)
  perform set_config('role', 'postgres', true);
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where org_id = org and slug = 'first'), 'Thing', 'thing') returning id into a_product;
  insert into public.shoots (org_id, code, product_id, status) values (org, 'S900', a_product, 'draft') returning id into a_shoot;
  update public.shoots set status = 'planned' where id = a_shoot;
  update public.shoots set status = 'draft' where id = a_shoot;
  update public.shoots set status = 'planned' where id = a_shoot;
  perform set_config('role', 'authenticated', true);
  if (select shoots_used from public.my_plan()) <> 1 then raise exception 'FAILED: a re-planned shoot counted twice'; end if;

  -- Free again: nothing is removed, but nothing more can be added
  perform set_config('role', 'postgres', true);
  update public.org_subscriptions set status = 'canceled' where org_id = org;
  perform set_config('role', 'authenticated', true);
  if (select brands_used from public.my_plan()) <> 2 then raise exception 'FAILED: a downgrade removed brands'; end if;
  begin
    insert into public.brands (name, slug) values ('Third', 'third');
    raise exception 'FAILED: Free allowed a brand over its limit after a downgrade';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- billing-exempt: no limits
  perform set_config('role', 'postgres', true);
  update public.orgs set billing_exempt = true where id = org;
  perform set_config('role', 'authenticated', true);
  insert into public.brands (name, slug) values ('Third', 'third');

  perform set_config('role', 'postgres', true);
  raise notice 'plan limits: all checks passed';
end $$;

rollback;
