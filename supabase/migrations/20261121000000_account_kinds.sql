-- Account types (the restructure's Phase 2): an account is a creator's (shoots, channels, team and
-- cast; what every account has been until now), a brand's (one brand: its public profile, products
-- and library; free) or an agency's (many brands; Phase 6). Brands and agencies never shoot.
--
-- Brands gain a public profile (what partner creators will see) and a library rule; Library items
-- can be scoped to one brand. In a brand account every Library item is its brand's.

-- --- what kind of account ----------------------------------------------------------------
alter table public.orgs add column kind text not null default 'creator'
  check (kind in ('creator', 'brand', 'agency'));
comment on column public.orgs.kind is 'creator (shoots), brand (one brand, its profile and library; free) or agency (many brands)';

create function private.org_kind(p_org_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select o.kind from public.orgs o where o.id = p_org_id;
$$;
revoke all on function private.org_kind(uuid) from public, anon;
grant execute on function private.org_kind(uuid) to authenticated, service_role;

-- --- the brand's public profile ------------------------------------------------------------
alter table public.brands
  add column about text,
  add column website_url text,
  add column logo_url text,
  add column guidelines text,
  add column library_rule text not null default 'mix' check (library_rule in ('brand_only', 'mix'));
comment on column public.brands.about is 'What the brand is, in its own words: shown to partner creators';
comment on column public.brands.guidelines is 'Dos and don''ts for creators making its ads';
comment on column public.brands.library_rule is 'brand_only: its shoots use only its own Library items; mix: the creator''s too';

-- --- Library items for one brand -----------------------------------------------------------
-- Null: general, for any brand. A product-scoped item stays scoped by its product.
do $$
declare
  t text;
begin
  foreach t in array array['hook_templates', 'cta_templates', 'formats'] loop
    execute format('alter table public.%I add column brand_id uuid', t);
    execute format('alter table public.%I add constraint %I foreign key (org_id, brand_id) references public.brands (org_id, id) on delete set null (brand_id)', t, t || '_brand_id_fkey');
    execute format('create index %I on public.%I (brand_id)', t || '_brand_id_idx', t);
    execute format('comment on column public.%I.brand_id is %L', t, 'Only for this brand''s shoots; null = any brand');
  end loop;
end $$;

-- In a brand account, everything in the Library is its brand's.
create function private.default_brand_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.brand_id is null and private.org_kind(new.org_id) = 'brand' then
    new.brand_id := (select b.id from public.brands b where b.org_id = new.org_id order by b.created_at limit 1);
  end if;
  return new;
end $$;
create trigger default_brand_scope before insert on public.hook_templates for each row execute function private.default_brand_scope();
create trigger default_brand_scope before insert on public.cta_templates for each row execute function private.default_brand_scope();
create trigger default_brand_scope before insert on public.formats for each row execute function private.default_brand_scope();

-- --- brands and agencies don't shoot -------------------------------------------------------
create function private.creators_shoot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.org_kind(new.org_id) <> 'creator' then
    raise exception 'Only creator accounts plan shoots';
  end if;
  return new;
end $$;
create trigger creators_shoot before insert on public.shoots
  for each row execute function private.creators_shoot();

-- --- limits: plans are for creators; a brand account has one brand ---------------------------
create or replace function private.limit_brands() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    if private.org_kind(new.org_id) = 'brand'
       and exists (select 1 from public.brands b where b.org_id = new.org_id and b.id <> new.id) then
      raise exception 'A brand account has one brand. To run several, start an agency account.';
    end if;
    perform private.check_plan_limit(new.org_id, 'brands');
  end if;
  return new;
end $$;

-- Plan limits apply to creator accounts only (brand accounts are free; agencies come later).
create or replace function private.check_plan_limit(p_org_id uuid, p_what text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan text := private.org_plan(p_org_id);
  l record;
  u record;
  extra integer;
  used integer;
  allowed integer;
  noun text;
begin
  if (select auth.uid()) is null
     or (select o.billing_exempt from public.orgs o where o.id = p_org_id)
     or private.org_kind(p_org_id) <> 'creator' then
    return;
  end if;
  select * into l from private.plan_limits(v_plan);
  select * into u from private.org_usage(p_org_id);
  if p_what = 'team' then
    extra := case when v_plan = 'free' then 0 else coalesce((
      select s.extra_team from public.org_subscriptions s
      where s.org_id = p_org_id and s.status in ('trialing', 'active', 'past_due')), 0) end;
    used := u.team; allowed := l.team + extra; noun := 'team member';
  elsif p_what = 'cast' then
    used := u.cast_members; allowed := l.cast_members; noun := 'cast member';
  elsif p_what = 'channels' then
    used := u.channels; allowed := l.channels; noun := 'channel';
  elsif p_what = 'brands' then
    used := u.brands; allowed := l.brands; noun := 'brand';
  else
    raise exception 'Unknown limit %', p_what;
  end if;
  if allowed is not null and used >= allowed then
    if p_what = 'team' and v_plan <> 'free' then
      raise exception '% includes % % (with any extra places). Add a team place in Settings → Billing for $29.99 a month.',
        initcap(v_plan), allowed, case when allowed = 1 then noun else noun || 's' end;
    end if;
    raise exception '% includes % %. Upgrade your plan in Settings → Billing for more.',
      initcap(v_plan), allowed, case when allowed = 1 then noun else noun || 's' end;
  end if;
end $$;

-- --- starting an account of a kind --------------------------------------------------------
drop function public.create_org(text, text, jsonb);
create function public.create_org(p_name text, p_slug text, p_profile jsonb default '{}'::jsonb, p_kind text default 'creator')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  org uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if not public.org_signup_open() then raise exception 'New organisations aren''t open yet'; end if;
  if jsonb_typeof(coalesce(p_profile, '{}')) <> 'object' then raise exception 'The profile must be an object'; end if;
  if coalesce(p_kind, '') not in ('creator', 'brand') then raise exception 'Choose a creator or brand account'; end if;
  insert into public.orgs (name, slug, created_by, kind) values (trim(p_name), p_slug, me, p_kind) returning id into org;
  insert into public.org_members (org_id, user_id, role) values (org, me, 'owner');
  update public.profiles set active_org_id = org where id = me;
  insert into public.settings (org_id, org_profile) values (org, coalesce(p_profile, '{}'));
  if p_kind = 'brand' then
    -- the brand itself: its account's one brand
    insert into public.brands (org_id, name, slug, status, about)
    values (org, trim(p_name), p_slug, 'active', nullif(trim(coalesce(p_profile ->> 'about', '')), ''));
  else
    insert into public.treatments (org_id, name, description, kind, placement, needs, component, settings, active, system, sort_order) values
      (org, 'Face to camera', 'The whole video with the speaker on camera: every VO beat shows them talking (a talking-head version). Skipped where a recipe already shows them throughout.', 'layout', 'video', array['speaker_video'], 'layout', '{"show": "face"}', true, true, 1),
      (org, 'Over b-roll', 'The whole video over b-roll: every VO beat is their voice over footage, none on camera. Skipped where a recipe already plays over b-roll throughout.', 'layout', 'video', '{}', 'layout', '{"show": "broll"}', true, true, 2);
  end if;
  return org;
end $$;
revoke all on function public.create_org(text, text, jsonb, text) from public, anon;
grant execute on function public.create_org(text, text, jsonb, text) to authenticated, service_role;

-- --- my_orgs says what kind each is --------------------------------------------------------
drop function public.my_orgs();
create function public.my_orgs()
returns table (id uuid, name text, slug text, role text, display_name text, is_current boolean, has_chosen boolean, entitled boolean, klip_access text, logo_url text, kind text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.slug, m.role, m.display_name,
    o.id = private.current_org_id(),
    p.active_org_id is not null,
    private.org_is_entitled(o.id),
    private.org_klip_access(o.id),
    o.logo_url,
    o.kind
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  join public.profiles p on p.id = m.user_id
  where m.user_id = (select auth.uid())
  order by o.name;
$$;
revoke all on function public.my_orgs() from public, anon;
grant execute on function public.my_orgs() to authenticated, service_role;
