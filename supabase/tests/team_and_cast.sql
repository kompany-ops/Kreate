-- Team and cast: cast can't write the Library, Brands or plan shoots, but can tick off their own
-- shots; the team can do what admins could; only the owner adds team members; nobody removes or
-- replaces the owner. Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  owner_user uuid := gen_random_uuid();
  team_user uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  org uuid;
  a_brand uuid;
  a_product uuid;
  n bigint;
  be_owner text := json_build_object('sub', owner_user, 'role', 'authenticated')::text;
  be_team text := json_build_object('sub', team_user, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (owner_user, 'owner-test@example.com', 'authenticated', 'authenticated'),
    (team_user, 'team-test@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'cast-test@example.com', 'authenticated', 'authenticated');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_owner, true);
  org := public.create_org('Team Test', 'team-test');

  -- the server puts them on Studio and adds the other two (as an accepted invite would)
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan)
  values (org, 'cus_team_test', 'sub_team_test', 'active', 'studio');
  insert into public.org_members (org_id, user_id, role) values (org, team_user, 'team'), (org, cast_user, 'cast');
  update public.profiles set active_org_id = org where id in (team_user, cast_user);
  perform set_config('role', 'authenticated', true);

  -- the team adds a brand; cast can't
  perform set_config('request.jwt.claims', be_team, true);
  insert into public.brands (name, slug) values ('Team Brand', 'team-brand') returning id into a_brand;
  insert into public.products (brand_id, name, slug) values (a_brand, 'Team Product', 'team-product') returning id into a_product;
  perform set_config('request.jwt.claims', be_cast, true);
  begin
    insert into public.brands (name, slug) values ('Cast Brand', 'cast-brand');
    raise exception 'FAILED: cast added a brand';
  exception when insufficient_privilege then null;
  end;
  update public.brands set name = 'Renamed by cast' where id = a_brand;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: cast renamed a brand'; end if;
  begin
    insert into public.hook_templates (script) values ('Cast hook');
    raise exception 'FAILED: cast wrote a hook';
  exception when insufficient_privilege or not_null_violation or check_violation then null;
  end;
  begin
    insert into public.shoots (product_id, status) values (a_product, 'draft');
    raise exception 'FAILED: cast started a shoot';
  exception when insufficient_privilege or not_null_violation then null;
  end;

  -- the team invites cast, but only the owner invites team
  perform set_config('request.jwt.claims', be_team, true);
  insert into public.org_invites (email, role) values ('new-cast@example.com', 'cast');
  begin
    insert into public.org_invites (email, role) values ('new-team@example.com', 'team');
    raise exception 'FAILED: the team invited a team member';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.org_members set role = 'team' where user_id = cast_user;
    raise exception 'FAILED: the team promoted cast to the team';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  -- nobody removes the owner
  begin
    delete from public.org_members where user_id = owner_user;
    raise exception 'FAILED: the team removed the owner';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- the owner can add team (Studio has three places: owner, team, and one more)
  perform set_config('request.jwt.claims', be_owner, true);
  insert into public.org_invites (email, role) values ('new-team@example.com', 'team');
  -- the fourth is over Studio's places
  begin
    update public.org_members set role = 'team' where user_id = cast_user;
    raise exception 'FAILED: the team grew past the plan''s places';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  -- until a place is bought
  perform set_config('role', 'postgres', true);
  update public.org_subscriptions set extra_team = 1 where org_id = org;
  perform set_config('role', 'authenticated', true);
  update public.org_members set role = 'team' where user_id = cast_user;
  -- and nobody can be made owner
  begin
    update public.org_members set role = 'owner' where user_id = team_user;
    raise exception 'FAILED: someone was made owner';
  exception when raise_exception or check_violation or unique_violation then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'team and cast: all checks passed';
end $$;

rollback;
