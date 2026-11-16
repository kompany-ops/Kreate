-- Plans: Free, Starter, Pro and Studio (docs/spec.md §2, Billing). Every org can use Kreate (Free is
-- a plan), so there's no billing wall any more: a plan sets how much an org can add. Limits count
-- across the whole org, never per channel. Nothing is ever removed after a downgrade: they just
-- can't add more. Billing-exempt orgs are on Studio with no limits at all.
--
-- The numbers live in shared/utils/plans.ts too; tests/plans.test.ts keeps the two in step.

-- --- the plan an org is on ---------------------------------------------------------------------
alter table public.org_subscriptions
  add column plan text check (plan in ('starter', 'pro', 'studio')),
  add column extra_team integer not null default 0 check (extra_team >= 0);
comment on column public.org_subscriptions.plan is 'The plan the subscription is for, from its base price''s lookup key. Written by the Stripe webhook only.';
comment on column public.org_subscriptions.extra_team is 'Team places bought on top of the plan''s (the team member add-on''s quantity). Written by the Stripe webhook only.';

-- the one price before plans was Pro's
update public.org_subscriptions set plan = 'pro' where stripe_subscription_id is not null and plan is null;

-- What each plan includes. Null means unlimited.
create function private.plan_limits(p_plan text)
returns table (team integer, cast_members integer, channels integer, brands integer, shoots_per_month integer)
language sql immutable set search_path = '' as $$
  select l.team, l.cast_members, l.channels, l.brands, l.shoots_per_month
  from (values
    -- plan,     team, cast, channels, brands, shoots a month
    ('free',     1,    1,    1,        1,      1),
    ('starter',  1,    2,    1,        5,      4),
    ('pro',      2,    6,    3,        10,     10),
    ('studio',   3,    null, null,     null,   null)
  ) as l (plan, team, cast_members, channels, brands, shoots_per_month)
  where l.plan = p_plan;
$$;

-- free, starter, pro or studio
create function private.org_plan(p_org_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.billing_exempt then 'studio'
    else coalesce((
      select s.plan from public.org_subscriptions s
      where s.org_id = o.id and s.status in ('trialing', 'active', 'past_due') and s.plan is not null
    ), 'free')
  end
  from public.orgs o
  where o.id = p_org_id;
$$;
revoke all on function private.org_plan(uuid) from public, anon;
grant execute on function private.org_plan(uuid) to authenticated, service_role;

-- Every org can use the app now: Free is a plan. (my_orgs and the license still ask.)
create or replace function private.org_is_entitled(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.orgs o where o.id = p_org_id);
$$;

-- Anyone can start an account, on Free.
update private.platform set org_signup_open = true;

-- Studio includes Klip.
create or replace function private.org_klip_access(p_org_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.klip_purchased_at is not null then 'purchased'
    when o.billing_exempt then 'exempt'
    when private.org_plan(o.id) = 'studio' then 'included'
    when exists (select 1 from public.org_subscriptions s where s.org_id = o.id and s.status = 'trialing') then 'trial'
    else 'none'
  end
  from public.orgs o
  where o.id = p_org_id;
$$;

-- --- shoots a month ----------------------------------------------------------------------------
-- A shoot counts when it's first marked Planned, in the month it happens (its date, else this
-- month). Deleting it or taking it back to draft doesn't give it back.
create table private.org_shoot_counts (
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null,
  planned integer not null default 0,
  primary key (org_id, month)
);
revoke all on private.org_shoot_counts from public, anon, authenticated;

alter table public.shoots add column plan_counted_at timestamptz;
comment on column public.shoots.plan_counted_at is 'When the shoot was first marked Planned and counted against the plan''s shoots a month.';
-- shoots already past draft were planned before plans existed: they don't count again
update public.shoots set plan_counted_at = coalesce(started_at, updated_at) where status <> 'draft';

-- --- usage, for the plan page and the checks below ---------------------------------------------
create function private.org_usage(p_org_id uuid)
returns table (team integer, cast_members integer, channels integer, brands integer, shoots_this_month integer)
language sql stable security definer set search_path = '' as $$
  select
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role in ('owner', 'team'))
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'team'))::integer,
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role = 'cast')
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'cast'))::integer,
    (select count(*) from public.channels c where c.org_id = p_org_id and c.active)::integer,
    (select count(*) from public.brands b where b.org_id = p_org_id and b.archived_at is null)::integer,
    coalesce((select c.planned from private.org_shoot_counts c where c.org_id = p_org_id and c.month = date_trunc('month', now())::date), 0);
$$;
revoke all on function private.org_usage(uuid) from public, anon;
grant execute on function private.org_usage(uuid) to authenticated, service_role;

-- The current org's plan, what it includes and what it's using. Null limits are unlimited.
create function public.my_plan()
returns table (
  plan text, billing_exempt boolean, extra_team integer,
  team_used integer, team_limit integer,
  cast_used integer, cast_limit integer,
  channels_used integer, channels_limit integer,
  brands_used integer, brands_limit integer,
  shoots_used integer, shoots_limit integer
)
language sql stable security definer set search_path = '' as $$
  select pl.plan, o.billing_exempt, coalesce(s.extra_team, 0),
    u.team, case when o.billing_exempt then null else l.team + case when pl.plan = 'free' then 0 else coalesce(s.extra_team, 0) end end,
    u.cast_members, case when o.billing_exempt then null else l.cast_members end,
    u.channels, case when o.billing_exempt then null else l.channels end,
    u.brands, case when o.billing_exempt then null else l.brands end,
    u.shoots_this_month, case when o.billing_exempt then null else l.shoots_per_month end
  from public.orgs o
  cross join lateral (select private.org_plan(o.id) as plan) pl
  cross join lateral private.plan_limits(pl.plan) l
  cross join lateral private.org_usage(o.id) u
  left join public.org_subscriptions s on s.org_id = o.id and s.status in ('trialing', 'active', 'past_due')
  where o.id = private.current_org_id() and private.is_org_member(o.id);
$$;
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated, service_role;

-- --- the checks --------------------------------------------------------------------------------
-- Raises when the org already has as many as its plan includes. Billing-exempt orgs and the
-- server (no signed-in user) aren't limited.
create function private.check_plan_limit(p_org_id uuid, p_what text) returns void
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
  if (select auth.uid()) is null or (select o.billing_exempt from public.orgs o where o.id = p_org_id) then
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

-- invites and role changes
create function private.limit_people() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    perform private.check_plan_limit(new.org_id, new.role);
  end if;
  return new;
end $$;
-- named to run before invite_existing_user, which may turn the invite straight into a member
create trigger check_plan_limits before insert or update of role on public.org_invites
  for each row execute function private.limit_people();
create trigger check_plan_limits before update of role on public.org_members
  for each row when (new.role in ('team', 'cast')) execute function private.limit_people();

-- channels: a new one, or one switched back on
create function private.limit_channels() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform private.check_plan_limit(new.org_id, 'channels');
  end if;
  return new;
end $$;
create trigger check_plan_limits before insert or update of active on public.channels
  for each row execute function private.limit_channels();

-- brands: a new one, or one restored from the archive
create function private.limit_brands() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    perform private.check_plan_limit(new.org_id, 'brands');
  end if;
  return new;
end $$;
create trigger check_plan_limits before insert or update of archived_at on public.brands
  for each row execute function private.limit_brands();

-- shoots: counted the first time one is marked Planned
create function private.count_planned_shoot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', coalesce(new.shoot_date, current_date))::date;
  v_plan text := private.org_plan(new.org_id);
  allowed integer := (select l.shoots_per_month from private.plan_limits(v_plan) l);
  used integer;
begin
  if new.status = 'planned' and old.status = 'draft' and new.plan_counted_at is null then
    if (select auth.uid()) is not null and not (select o.billing_exempt from public.orgs o where o.id = new.org_id) and allowed is not null then
      used := coalesce((select c.planned from private.org_shoot_counts c where c.org_id = new.org_id and c.month = v_month), 0);
      if used >= allowed then
        raise exception '% includes % % a month. Upgrade your plan in Settings → Billing for more.',
          initcap(v_plan), allowed, case when allowed = 1 then 'shoot' else 'shoots' end;
      end if;
    end if;
    insert into private.org_shoot_counts (org_id, month, planned) values (new.org_id, v_month, 1)
    on conflict (org_id, month) do update set planned = private.org_shoot_counts.planned + 1;
    new.plan_counted_at := now();
  end if;
  return new;
end $$;
create trigger count_planned_shoot before update of status on public.shoots
  for each row execute function private.count_planned_shoot();
