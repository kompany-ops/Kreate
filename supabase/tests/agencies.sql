-- Agencies: an agency runs several brands, invites only once its plan is live, links its own
-- Library into a creator's account for every brand of its they partner on (and only those shoots),
-- keeps its deal terms to itself, and marks linked brands as from it.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  agency_user uuid := gen_random_uuid();
  creator_user uuid := gen_random_uuid();
  agency_org uuid;
  creator_org uuid;
  brand_a uuid;
  brand_b uuid;
  agency_hook uuid;
  invite uuid;
  linked uuid;
  copy uuid;
  be_agency text := json_build_object('sub', agency_user, 'role', 'authenticated')::text;
  be_creator text := json_build_object('sub', creator_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    (agency_user, 'agency-owner@example.com', 'authenticated', 'authenticated', now()),
    (creator_user, 'agency-creator@example.com', 'authenticated', 'authenticated', now());
  perform set_config('role', 'authenticated', true);

  -- an agency with two brands, its deal with one, and a hook of its own
  perform set_config('request.jwt.claims', be_agency, true);
  agency_org := public.create_org('Paw Agency', 'paw-agency', '{}', 'agency');
  if (select kind from public.my_orgs() where id = agency_org) <> 'agency' then raise exception 'FAILED: not an agency account'; end if;
  insert into public.brands (name, slug, pay_types, flat_fee) values ('Brand A', 'brand-a', array['flat'], 120) returning id into brand_a;
  insert into public.brands (name, slug) values ('Brand B', 'brand-b') returning id into brand_b;
  insert into public.products (brand_id, name, slug) values (brand_a, 'A Thing', 'a-thing');
  insert into public.hook_templates (script) values ('The agency''s own hook') returning id into agency_hook;
  if (select brand_id from public.hook_templates where id = agency_hook) is not null then raise exception 'FAILED: the agency''s own hook got a brand'; end if;

  -- no inviting until the agency plan is live
  begin
    perform public.invite_partner(brand_a, 'agency-creator@example.com');
    raise exception 'FAILED: an agency invited without its plan';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan)
  values (agency_org, 'cus_agency_test', 'sub_agency_test', 'active', 'agency');
  perform set_config('role', 'authenticated', true);
  invite := public.invite_partner(brand_a, 'agency-creator@example.com');

  -- the creator accepts Brand A: it's from the agency, the agency's hook comes along, its deal doesn't
  perform set_config('request.jwt.claims', be_creator, true);
  creator_org := public.create_org('Agency Creator', 'agency-creator');
  linked := public.accept_partnership(invite, creator_org, '{}');
  if (select partner_org_id from public.brands where id = linked) <> agency_org then raise exception 'FAILED: the linked brand doesn''t say it''s from the agency'; end if;
  if (select flat_fee from public.brands where id = linked) is not null or (select pay_types from public.brands where id = linked) <> '{}' then raise exception 'FAILED: the agency''s deal terms reached the creator'; end if;
  select id into copy from public.hook_templates where source_id = agency_hook;
  if copy is null then raise exception 'FAILED: the agency''s own hook didn''t come along'; end if;
  if (select partner_org_id from public.hook_templates where id = copy) <> agency_org or (select brand_id from public.hook_templates where id = copy) is not null then
    raise exception 'FAILED: the agency''s hook isn''t marked as the agency''s';
  end if;
  if exists (select 1 from public.brands where org_id = creator_org and source_brand_id = brand_b) then raise exception 'FAILED: a brand not partnered on came along'; end if;

  -- the agency changes its hook: the copy follows
  perform set_config('request.jwt.claims', be_agency, true);
  update public.hook_templates set script = 'The agency''s own hook, better' where id = agency_hook;
  perform set_config('request.jwt.claims', be_creator, true);
  if (select script from public.hook_templates where id = copy) <> 'The agency''s own hook, better' then raise exception 'FAILED: an agency Library edit didn''t sync'; end if;

  -- nobody marks their own hook as a partner's
  begin
    insert into public.hook_templates (script, partner_org_id) values ('Sneaky', agency_org);
    raise exception 'FAILED: a creator marked their own hook as the agency''s';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- the agency's results for Brand A include its own hook
  perform set_config('request.jwt.claims', be_agency, true);
  if not exists (select 1 from public.partner_item_results(brand_a) where item_id = agency_hook) then raise exception 'FAILED: the agency''s own hook isn''t in its results'; end if;

  perform set_config('role', 'postgres', true);
end $$;

select 'agencies: all checks passed' as result;
rollback;
