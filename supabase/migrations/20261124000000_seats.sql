-- Seats (the restructure's Phase 5): a brand or agency pays for a partnered creator's work on its
-- brands. While a seat is live (the creator is partnered, the seat is active and the payer's
-- subscription is live), that creator's shoots for the payer's brands skip their plan's shoots a
-- month (they still count), and the creator has Klip. Nothing is ever removed when a seat ends.
--
-- The payer's subscription carries one seat price (kreate_brand_seat or kreate_agency_seat,
-- graduated) whose quantity is its seats; the webhook copies it into org_subscriptions.seats. A seat
-- assigned before the payer has a live subscription waits (pending) until checkout goes through.

create table public.seats (
  id uuid primary key default gen_random_uuid(),
  publisher_org_id uuid not null references public.orgs (id) on delete cascade,
  creator_org_id uuid not null references public.orgs (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'ended')),
  -- names as they were, so each side can show the other without reading its account
  publisher_name text not null,
  creator_name text not null,
  assigned_by uuid default auth.uid() references public.profiles (id) on delete set null,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index seats_current_key on public.seats (publisher_org_id, creator_org_id) where status <> 'ended';
create index seats_creator_idx on public.seats (creator_org_id);
create trigger set_updated_at before update on public.seats
  for each row execute function private.set_updated_at();

alter table public.seats enable row level security;
revoke all on public.seats from anon, authenticated;
grant select on public.seats to authenticated;
-- the payer's team, and the creator's whole account (it's their plan), can see a seat; only the
-- server writes them
create policy "either side can read" on public.seats for select to authenticated
  using (
    (publisher_org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
    or creator_org_id = (select private.current_org_id())
  );

alter table public.org_subscriptions add column seats integer not null default 0 check (seats >= 0);
comment on column public.org_subscriptions.seats is 'Seats paid for (the seat price''s quantity). Written by the Stripe webhook only.';

-- Does the payer cover this creator account right now?
create function private.has_seat(p_creator_org_id uuid, p_publisher_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.seats s
    join public.org_subscriptions sub on sub.org_id = s.publisher_org_id and sub.status in ('trialing', 'active', 'past_due')
    where s.creator_org_id = p_creator_org_id and s.status = 'active'
      and (p_publisher_org_id is null or s.publisher_org_id = p_publisher_org_id)
      and exists (select 1 from public.partnerships x where x.publisher_org_id = s.publisher_org_id and x.creator_org_id = s.creator_org_id and x.status = 'active')
  );
$$;
revoke all on function private.has_seat(uuid, uuid) from public, anon;
grant execute on function private.has_seat(uuid, uuid) to authenticated, service_role;

-- --- shoots on a covered brand skip the limit (they still count) ------------------------------------
create or replace function private.count_planned_shoot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', coalesce(new.shoot_date, current_date))::date;
  v_plan text := private.org_plan(new.org_id);
  allowed integer := (select l.shoots_per_month from private.plan_limits(v_plan) l);
  used integer;
  payer uuid;
begin
  if new.status = 'planned' and old.status = 'draft' and new.plan_counted_at is null then
    -- a partner brand whose partner pays a seat for this account: no limit on its shoots
    select x.publisher_org_id into payer
    from public.products pr join public.brands b on b.id = pr.brand_id
    join public.partnerships x on x.linked_brand_id = b.id and x.status = 'active'
    where pr.id = new.product_id and b.source_brand_id is not null
    limit 1;
    if (select auth.uid()) is not null and not (select o.billing_exempt from public.orgs o where o.id = new.org_id)
       and allowed is not null and not (payer is not null and private.has_seat(new.org_id, payer)) then
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

-- --- Klip comes with a seat ------------------------------------------------------------------------
create or replace function private.org_klip_access(p_org_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.klip_purchased_at is not null then 'purchased'
    when o.billing_exempt then 'exempt'
    when private.org_plan(o.id) = 'studio' then 'included'
    when private.has_seat(o.id, null) then 'seat'
    when exists (select 1 from public.org_subscriptions s where s.org_id = o.id and s.status = 'trialing') then 'trial'
    else 'none'
  end
  from public.orgs o
  where o.id = p_org_id;
$$;
