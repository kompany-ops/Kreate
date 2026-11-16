-- Brand deals move out of brands (before guest collaborators, the restructure's Phase 7). How a
-- brand pays an account (pay types, amounts, currency) and its notes on the deal are the team's
-- business: cast, and soon guests from outside the account, see a shoot's brand but never what the
-- account earns from it. A brands row can't hide some columns from some people, so the deal gets a
-- table of its own that only the team can read or write. Status, star and archive stay on brands:
-- they're not secret, and lists filter on them. Trybe's data stays too: it's the marketplace's,
-- not the account's.

create table public.brand_deals (
  brand_id uuid primary key,
  org_id uuid not null default private.current_org_id() references public.orgs (id) on delete cascade,
  pay_types text[] not null default '{}' check (pay_types <@ array['flat', 'retainer', 'commission', 'ad_spend']::text[]),
  flat_fee numeric(10, 2) check (flat_fee >= 0),
  retainer_fee numeric(10, 2) check (retainer_fee >= 0),
  commission_pct numeric(5, 2) check (commission_pct between 0 and 100),
  ad_spend_pct numeric(5, 2) check (ad_spend_pct between 0 and 100),
  currency text not null default 'GBP',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, brand_id) references public.brands (org_id, id) on delete cascade
);
create index brand_deals_org_id_idx on public.brand_deals (org_id);
create trigger set_updated_at before update on public.brand_deals
  for each row execute function private.set_updated_at();
comment on table public.brand_deals is 'How a brand pays this account, and the team''s notes on it. The team''s only: cast and guests never see it.';

alter table public.brand_deals enable row level security;
revoke all on public.brand_deals from anon, authenticated;
grant select, insert, update, delete on public.brand_deals to authenticated;
create policy "the team can read" on public.brand_deals for select to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can insert" on public.brand_deals for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can update" on public.brand_deals for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can delete" on public.brand_deals for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));

-- every deal so far
insert into public.brand_deals (brand_id, org_id, pay_types, flat_fee, retainer_fee, commission_pct, ad_spend_pct, currency, notes)
select b.id, b.org_id, b.pay_types, b.flat_fee, b.retainer_fee, b.commission_pct, b.ad_spend_pct, b.currency, b.notes
from public.brands b
where b.pay_types <> '{}' or b.flat_fee is not null or b.retainer_fee is not null or b.commission_pct is not null
  or b.ad_spend_pct is not null or b.notes is not null or b.currency <> 'GBP';

alter table public.brands
  drop column pay_types,
  drop column flat_fee,
  drop column retainer_fee,
  drop column commission_pct,
  drop column ad_spend_pct,
  drop column currency,
  drop column notes;
