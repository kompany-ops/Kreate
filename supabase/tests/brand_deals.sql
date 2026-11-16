-- Brand deals: how a brand pays the account, and the team's notes on it, are the team's only. Cast
-- see the brand but never its deal, and can't write one.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  owner_user uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  org uuid;
  the_brand uuid;
  be_owner text := json_build_object('sub', owner_user, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (owner_user, 'deal-owner@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'deal-cast@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', be_owner, true);
  org := public.create_org('Deal Test', 'deal-test');
  insert into public.brands (name, slug) values ('Paying Brand', 'paying-brand') returning id into the_brand;
  insert into public.brand_deals (brand_id, pay_types, flat_fee, commission_pct, notes) values (the_brand, array['flat', 'commission'], 150, 10, 'Pays on time');
  if (select flat_fee from public.brand_deals where brand_id = the_brand) <> 150 then raise exception 'FAILED: the team can''t read its deal'; end if;

  perform set_config('role', 'postgres', true);
  insert into public.org_members (org_id, user_id, role) values (org, cast_user, 'cast');
  update public.profiles set active_org_id = org where id = cast_user;
  perform set_config('role', 'authenticated', true);

  -- cast see the brand, never the deal
  perform set_config('request.jwt.claims', be_cast, true);
  if not exists (select 1 from public.brands where id = the_brand) then raise exception 'FAILED: cast can''t see the brand'; end if;
  if exists (select 1 from public.brand_deals where brand_id = the_brand) then raise exception 'FAILED: cast can read the deal'; end if;
  begin
    insert into public.brand_deals (brand_id, pay_types) values (the_brand, array['flat']);
    raise exception 'FAILED: cast wrote a deal';
  exception when insufficient_privilege or unique_violation then null;
  end;

  perform set_config('role', 'postgres', true);
end $$;

select 'brand deals: all checks passed' as result;
rollback;
