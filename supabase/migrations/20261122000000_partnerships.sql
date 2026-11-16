-- Partnerships (the restructure's Phase 3). A brand account invites a creator account by email; once
-- the creator accepts (choosing which of their channels it goes to), the brand's profile, products,
-- features and Library appear in the creator's account as read-only linked copies, kept in sync as
-- the brand edits them. The creator keeps their own deal on top: status, pay, notes, star, archive
-- and channels. Everything a shoot touches stays in one account, so the planner, Klip, recipes and
-- limits work as before. Ending a partnership archives the linked brand; the creator keeps its
-- shoots and everything made.
--
-- The sync is the only writer of a linked row's copied columns. It runs as a security definer and
-- marks the transaction (kreate.syncing) so the guards below let it through.

-- --- source links ----------------------------------------------------------------------------
-- Plain ids, not foreign keys: the partner's row is in another account, and when it goes the sync
-- notices (a foreign key clearing the link would be an edit the guard below refuses).
alter table public.brands add column source_brand_id uuid;
alter table public.products add column source_product_id uuid;
alter table public.product_features add column source_feature_id uuid;
alter table public.hook_templates add column source_id uuid;
alter table public.cta_templates add column source_id uuid;
alter table public.formats add column source_id uuid;

create unique index brands_linked_key on public.brands (org_id, source_brand_id) where source_brand_id is not null;
create unique index products_linked_key on public.products (org_id, source_product_id) where source_product_id is not null;
create unique index product_features_linked_key on public.product_features (org_id, source_feature_id) where source_feature_id is not null;
create unique index hook_templates_linked_key on public.hook_templates (org_id, source_id) where source_id is not null;
create unique index cta_templates_linked_key on public.cta_templates (org_id, source_id) where source_id is not null;
create unique index formats_linked_key on public.formats (org_id, source_id) where source_id is not null;
create index brands_source_brand_id_idx on public.brands (source_brand_id);
create index products_source_product_id_idx on public.products (source_product_id);
create index product_features_source_feature_id_idx on public.product_features (source_feature_id);
create index hook_templates_source_id_idx on public.hook_templates (source_id);
create index cta_templates_source_id_idx on public.cta_templates (source_id);
create index formats_source_id_idx on public.formats (source_id);

comment on column public.brands.source_brand_id is 'A partner''s brand, linked into this account: its profile is the partner''s (read-only), the deal is this account''s';

-- --- partnerships ------------------------------------------------------------------------------
create table public.partnerships (
  id uuid primary key default gen_random_uuid(),
  publisher_org_id uuid not null references public.orgs (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete cascade,
  invited_email text not null check (invited_email = lower(invited_email)),
  status text not null default 'invited' check (status in ('invited', 'active', 'declined', 'ended')),
  creator_org_id uuid references public.orgs (id) on delete cascade,
  linked_brand_id uuid references public.brands (id) on delete set null,
  -- names as they were, so each side can show the other without reading its account
  publisher_name text not null,
  brand_name text not null,
  creator_name text,
  invited_by uuid default auth.uid() references public.profiles (id) on delete set null,
  emailed_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index partnerships_pending_key on public.partnerships (brand_id, invited_email) where status = 'invited';
create unique index partnerships_active_key on public.partnerships (brand_id, creator_org_id) where status = 'active';
create index partnerships_publisher_idx on public.partnerships (publisher_org_id);
create index partnerships_creator_idx on public.partnerships (creator_org_id);
create index partnerships_email_idx on public.partnerships (invited_email);
create trigger set_updated_at before update on public.partnerships
  for each row execute function private.set_updated_at();

alter table public.partnerships enable row level security;
revoke all on public.partnerships from anon, authenticated;
grant select on public.partnerships to authenticated;
-- each side's team reads its own; every change goes through the functions below
create policy "either side's team can read" on public.partnerships for select to authenticated
  using (
    (publisher_org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
    or (creator_org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  );

-- --- the sync ----------------------------------------------------------------------------------
create function private.is_syncing() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('kreate.syncing', true), '') = 'on';
$$;

/** Copy a partner brand's profile, products, features and Library into the creator's account. */
create function private.sync_partnership(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.partnerships;
  src public.brands;
begin
  select * into p from public.partnerships where id = p_id;
  if p.id is null or p.status <> 'active' or p.linked_brand_id is null then
    return;
  end if;
  select * into src from public.brands where id = p.brand_id;
  perform set_config('kreate.syncing', 'on', true);

  -- the profile (never the partner's own deal)
  update public.brands set
    name = src.name, about = src.about, website_url = src.website_url, logo_url = src.logo_url,
    guidelines = src.guidelines, library_rule = src.library_rule
  where id = p.linked_brand_id;

  -- products (a product's slug never changes, so only the rest is updated)
  insert into public.products (org_id, brand_id, name, slug, claims_allowed, claims_forbidden, notes, source_product_id)
  select p.creator_org_id, p.linked_brand_id, sp.name, sp.slug, sp.claims_allowed, sp.claims_forbidden, sp.notes, sp.id
  from public.products sp where sp.brand_id = src.id
  on conflict (org_id, source_product_id) where source_product_id is not null do update set
    name = excluded.name, claims_allowed = excluded.claims_allowed, claims_forbidden = excluded.claims_forbidden, notes = excluded.notes;

  -- features, under the linked products
  insert into public.product_features (org_id, product_id, name, description, sort_order, slug, source_feature_id)
  select p.creator_org_id, lp.id, sf.name, sf.description, sf.sort_order, sf.slug, sf.id
  from public.product_features sf
  join public.products lp on lp.org_id = p.creator_org_id and lp.source_product_id = sf.product_id
  where sf.org_id = src.org_id
  on conflict (org_id, source_feature_id) where source_feature_id is not null do update set
    name = excluded.name, description = excluded.description, sort_order = excluded.sort_order;
  -- features the partner removed go too, unless VOs or b-roll here are about them
  begin
    delete from public.product_features lf
    where lf.org_id = p.creator_org_id and lf.source_feature_id is not null
      and exists (select 1 from public.products lp where lp.id = lf.product_id and lp.brand_id = p.linked_brand_id)
      and not exists (select 1 from public.product_features sf where sf.id = lf.source_feature_id);
  exception when foreign_key_violation or raise_exception then null;
  end;

  -- hooks: the brand's, or for one of its products; hook types matched by name
  insert into public.hook_templates (org_id, script, angle_id, est_seconds, tags, notes, archived, source_url, filming_notes, caption, product_id, brand_id, source_id)
  select p.creator_org_id, h.script,
    (select a.id from public.angles a where a.org_id = p.creator_org_id and lower(a.name) = lower(sa.name) limit 1),
    h.est_seconds, h.tags, h.notes, h.archived, h.source_url, h.filming_notes, h.caption,
    lp.id, case when lp.id is null then p.linked_brand_id end, h.id
  from public.hook_templates h
  left join public.angles sa on sa.id = h.angle_id
  left join public.products lp on lp.org_id = p.creator_org_id and lp.source_product_id = h.product_id
  where h.org_id = src.org_id and h.shoot_id is null
    and (h.brand_id = src.id or h.product_id in (select id from public.products where brand_id = src.id))
  on conflict (org_id, source_id) where source_id is not null do update set
    script = excluded.script, angle_id = excluded.angle_id, est_seconds = excluded.est_seconds, tags = excluded.tags,
    notes = excluded.notes, archived = excluded.archived, source_url = excluded.source_url,
    filming_notes = excluded.filming_notes, caption = excluded.caption, product_id = excluded.product_id, brand_id = excluded.brand_id;

  insert into public.cta_templates (org_id, script, mode, est_seconds, tags, notes, archived, source_url, product_id, brand_id, source_id)
  select p.creator_org_id, c.script, c.mode, c.est_seconds, c.tags, c.notes, c.archived, c.source_url,
    lp.id, case when lp.id is null then p.linked_brand_id end, c.id
  from public.cta_templates c
  left join public.products lp on lp.org_id = p.creator_org_id and lp.source_product_id = c.product_id
  where c.org_id = src.org_id and c.shoot_id is null
    and (c.brand_id = src.id or c.product_id in (select id from public.products where brand_id = src.id))
  on conflict (org_id, source_id) where source_id is not null do update set
    script = excluded.script, mode = excluded.mode, est_seconds = excluded.est_seconds, tags = excluded.tags,
    notes = excluded.notes, archived = excluded.archived, source_url = excluded.source_url,
    product_id = excluded.product_id, brand_id = excluded.brand_id;

  -- formats: a code already taken here gets the brand's slug added
  insert into public.formats (org_id, code, name, description, cta_modes, beats, target_seconds, archived, source_url,
    beat_descriptions, beat_broll, kind, beat_examples, beat_display, brand_id, source_id)
  select p.creator_org_id,
    case when exists (select 1 from public.formats o where o.org_id = p.creator_org_id and o.code = f.code and o.source_id is distinct from f.id)
      then f.code || '-' || upper(src.slug) else f.code end,
    f.name, f.description, f.cta_modes, f.beats, f.target_seconds, f.archived, f.source_url,
    f.beat_descriptions, f.beat_broll, f.kind, f.beat_examples, f.beat_display, p.linked_brand_id, f.id
  from public.formats f
  where f.org_id = src.org_id and f.brand_id = src.id
  on conflict (org_id, source_id) where source_id is not null do update set
    name = excluded.name, description = excluded.description, cta_modes = excluded.cta_modes, beats = excluded.beats,
    target_seconds = excluded.target_seconds, archived = excluded.archived, source_url = excluded.source_url,
    beat_descriptions = excluded.beat_descriptions, beat_broll = excluded.beat_broll, kind = excluded.kind,
    beat_examples = excluded.beat_examples, beat_display = excluded.beat_display;

  -- what the partner no longer has (deleted, or moved off the brand) is archived here
  update public.hook_templates l set archived = true
  where l.org_id = p.creator_org_id and l.source_id is not null and not l.archived
    and (l.brand_id = p.linked_brand_id or l.product_id in (select id from public.products where brand_id = p.linked_brand_id))
    and not exists (select 1 from public.hook_templates h where h.id = l.source_id and h.shoot_id is null
      and (h.brand_id = src.id or h.product_id in (select id from public.products where brand_id = src.id)));
  update public.cta_templates l set archived = true
  where l.org_id = p.creator_org_id and l.source_id is not null and not l.archived
    and (l.brand_id = p.linked_brand_id or l.product_id in (select id from public.products where brand_id = p.linked_brand_id))
    and not exists (select 1 from public.cta_templates c where c.id = l.source_id and c.shoot_id is null
      and (c.brand_id = src.id or c.product_id in (select id from public.products where brand_id = src.id)));
  update public.formats l set archived = true
  where l.org_id = p.creator_org_id and l.brand_id = p.linked_brand_id and l.source_id is not null and not l.archived
    and not exists (select 1 from public.formats f where f.id = l.source_id and f.brand_id = src.id);

  perform set_config('kreate.syncing', '', true);
end $$;
revoke all on function private.sync_partnership(uuid) from public, anon, authenticated;

/** Re-sync every active partnership for one of a publisher's brands. */
create function private.resync_brand(p_brand_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  if p_brand_id is null then return; end if;
  for pid in select id from public.partnerships where brand_id = p_brand_id and status = 'active' loop
    perform private.sync_partnership(pid);
  end loop;
end $$;
revoke all on function private.resync_brand(uuid) from public, anon, authenticated;

-- A publisher's edits flow to its partners. Rows that are themselves linked copies never trigger it.
create function private.resync_on_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record := coalesce(new, old);
  brand uuid;
begin
  if private.is_syncing() or not exists (select 1 from public.partnerships x where x.publisher_org_id = r.org_id and x.status = 'active') then
    return null;
  end if;
  if tg_table_name = 'brands' then
    if r.source_brand_id is null then brand := r.id; end if;
  elsif tg_table_name = 'products' then
    if r.source_product_id is null then brand := r.brand_id; end if;
  elsif tg_table_name = 'product_features' then
    if r.source_feature_id is null then brand := (select brand_id from public.products where id = r.product_id); end if;
  elsif r.source_id is null then
    -- hooks, CTAs and formats: their brand, or their product's brand
    brand := coalesce(r.brand_id, case when tg_table_name <> 'formats' then (select brand_id from public.products where id = (to_jsonb(r) ->> 'product_id')::uuid) end);
    -- an item moved between brands: the brand it left re-syncs too
    if tg_op = 'UPDATE' and old.brand_id is distinct from new.brand_id then perform private.resync_brand(old.brand_id); end if;
  end if;
  perform private.resync_brand(brand);
  return null;
end $$;
create trigger resync_partners after insert or update or delete on public.brands for each row execute function private.resync_on_change();
create trigger resync_partners after insert or update or delete on public.products for each row execute function private.resync_on_change();
create trigger resync_partners after insert or update or delete on public.product_features for each row execute function private.resync_on_change();
create trigger resync_partners after insert or update or delete on public.hook_templates for each row execute function private.resync_on_change();
create trigger resync_partners after insert or update or delete on public.cta_templates for each row execute function private.resync_on_change();
create trigger resync_partners after insert or update or delete on public.formats for each row execute function private.resync_on_change();

-- --- linked rows are read-only, apart from the creator's deal ----------------------------------
create function private.guard_linked_rows() returns trigger
language plpgsql set search_path = '' as $$
declare
  deal constant text[] := array['status', 'notes', 'trybe_url', 'flat_fee', 'commission_pct', 'currency', 'trybe_score',
    'videos_required', 'trybe_brand_id', 'trybe_data', 'pay_types', 'retainer_fee', 'ad_spend_pct', 'starred', 'archived_at', 'updated_at'];
  linked boolean;
begin
  if private.is_syncing() or (select auth.uid()) is null then
    return coalesce(new, old);
  end if;
  -- (one function for several tables: columns are read by name, since not every table has each)
  linked := coalesce(to_jsonb(old) ->> 'source_brand_id', to_jsonb(old) ->> 'source_product_id',
    to_jsonb(old) ->> 'source_feature_id', to_jsonb(old) ->> 'source_id') is not null;
  if not linked then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This comes from a partner brand: it can''t be deleted here';
  end if;
  if tg_table_name = 'brands' and (to_jsonb(new) - deal) = (to_jsonb(old) - deal) then
    return new;
  end if;
  raise exception 'This comes from a partner brand: only they can change it%', case when tg_table_name = 'brands' then ' (your deal, notes, star, archive and channels are yours)' else '' end;
end $$;
create trigger guard_linked_rows before update or delete on public.brands for each row execute function private.guard_linked_rows();
create trigger guard_linked_rows before update or delete on public.products for each row execute function private.guard_linked_rows();
create trigger guard_linked_rows before update or delete on public.product_features for each row execute function private.guard_linked_rows();
create trigger guard_linked_rows before update or delete on public.hook_templates for each row execute function private.guard_linked_rows();
create trigger guard_linked_rows before update or delete on public.cta_templates for each row execute function private.guard_linked_rows();
create trigger guard_linked_rows before update or delete on public.formats for each row execute function private.guard_linked_rows();

-- Nobody adds products or features to a partner's brand, or links rows by hand.
create function private.guard_linked_inserts() returns trigger
language plpgsql set search_path = '' as $$
declare
  -- one function for several tables: columns are read by name, since not every table has each
  j jsonb := to_jsonb(new);
begin
  if private.is_syncing() or (select auth.uid()) is null then
    return new;
  end if;
  if coalesce(j ->> 'source_brand_id', j ->> 'source_product_id', j ->> 'source_feature_id', j ->> 'source_id') is not null
     or (tg_table_name = 'products' and exists (select 1 from public.brands b where b.id = (j ->> 'brand_id')::uuid and b.source_brand_id is not null))
     or (tg_table_name = 'product_features' and exists (select 1 from public.products x where x.id = (j ->> 'product_id')::uuid and x.source_product_id is not null)) then
    raise exception 'Products, features and Library items from a partner brand come from the partner';
  end if;
  return new;
end $$;
create trigger guard_linked_inserts before insert on public.brands for each row execute function private.guard_linked_inserts();
create trigger guard_linked_inserts before insert on public.products for each row execute function private.guard_linked_inserts();
create trigger guard_linked_inserts before insert on public.product_features for each row execute function private.guard_linked_inserts();
create trigger guard_linked_inserts before insert on public.hook_templates for each row execute function private.guard_linked_inserts();
create trigger guard_linked_inserts before insert on public.cta_templates for each row execute function private.guard_linked_inserts();
create trigger guard_linked_inserts before insert on public.formats for each row execute function private.guard_linked_inserts();

-- --- limits: partner brands aren't your own ------------------------------------------------------
create or replace function private.org_usage(p_org_id uuid)
returns table (team integer, cast_members integer, channels integer, brands integer, shoots_this_month integer)
language sql stable security definer set search_path = '' as $$
  select
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role in ('owner', 'team'))
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'team'))::integer,
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role = 'cast')
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'cast'))::integer,
    (select count(*) from public.channels c where c.org_id = p_org_id and c.active)::integer,
    (select count(*) from public.brands b where b.org_id = p_org_id and b.archived_at is null and b.source_brand_id is null)::integer,
    coalesce((select c.planned from private.org_shoot_counts c where c.org_id = p_org_id and c.month = date_trunc('month', now())::date), 0);
$$;

create or replace function private.limit_brands() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- a partner's brand isn't one of your own: it never counts
  if new.source_brand_id is not null then
    return new;
  end if;
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    if private.org_kind(new.org_id) = 'brand'
       and exists (select 1 from public.brands b where b.org_id = new.org_id and b.id <> new.id) then
      raise exception 'A brand account has one brand. To run several, start an agency account.';
    end if;
    perform private.check_plan_limit(new.org_id, 'brands');
  end if;
  return new;
end $$;

-- --- the library rule -----------------------------------------------------------------------------
-- A partner brand that keeps its shoots to its own Library: hooks and CTAs on them must be its.
create function private.enforce_library_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rule text;
  ok boolean;
begin
  if new.kind not in ('hook', 'cta') then
    return new;
  end if;
  select b.library_rule into rule
  from public.shoots s join public.products pr on pr.id = s.product_id join public.brands b on b.id = pr.brand_id
  where s.id = new.shoot_id and b.source_brand_id is not null;
  if rule is distinct from 'brand_only' then
    return new;
  end if;
  ok := case new.kind
    when 'hook' then exists (select 1 from public.hook_templates h where h.id = new.hook_template_id and h.source_id is not null)
    else exists (select 1 from public.cta_templates c where c.id = new.cta_template_id and c.source_id is not null)
  end;
  if not ok then
    raise exception 'This brand''s shoots use only its own hooks and CTAs';
  end if;
  return new;
end $$;
create trigger enforce_library_rule before insert on public.shoot_items
  for each row execute function private.enforce_library_rule();

-- --- inviting, accepting, ending ----------------------------------------------------------------
create function public.invite_partner(p_brand_id uuid, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.brands;
  email text := lower(trim(p_email));
  id uuid;
begin
  select * into b from public.brands where brands.id = p_brand_id;
  if b.id is null or b.source_brand_id is not null or not private.is_org_admin(b.org_id) or b.org_id <> private.current_org_id() then
    raise exception 'Only the brand''s team can invite creators';
  end if;
  if private.org_kind(b.org_id) = 'creator' then
    raise exception 'Creator accounts don''t invite partners: start a brand account';
  end if;
  if email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address';
  end if;
  insert into public.partnerships (publisher_org_id, brand_id, invited_email, publisher_name, brand_name)
  values (b.org_id, b.id, email, (select o.name from public.orgs o where o.id = b.org_id), b.name)
  returning partnerships.id into id;
  return id;
exception when unique_violation then
  raise exception '% is already invited', email;
end $$;

/** Invitations waiting for the signed-in person's email. */
create function public.my_partner_invites()
returns table (id uuid, publisher_name text, brand_name text, about text, logo_url text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.id, x.publisher_name, x.brand_name, b.about, b.logo_url, x.created_at
  from public.partnerships x
  join public.brands b on b.id = x.brand_id
  where x.status = 'invited'
    and x.invited_email = lower((select u.email from auth.users u where u.id = (select auth.uid())))
  order by x.created_at;
$$;

create function public.accept_partnership(p_id uuid, p_org_id uuid, p_channel_ids uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.partnerships;
  src public.brands;
  me_email text := lower((select u.email from auth.users u where u.id = (select auth.uid())));
  v_slug text;
  n integer := 2;
  linked uuid;
begin
  select * into p from public.partnerships where id = p_id for update;
  if p.id is null or p.status <> 'invited' or p.invited_email <> me_email then
    raise exception 'That invitation isn''t yours, or has been answered';
  end if;
  if not private.is_org_admin(p_org_id) or private.org_kind(p_org_id) <> 'creator' then
    raise exception 'Accept it into a creator account you''re on the team of';
  end if;
  if exists (select 1 from public.partnerships x where x.brand_id = p.brand_id and x.creator_org_id = p_org_id and x.status = 'active') then
    raise exception 'That account already partners with this brand';
  end if;
  select * into src from public.brands where id = p.brand_id;

  perform set_config('kreate.syncing', 'on', true);
  -- the linked brand, with a slug of its own in this account
  v_slug := src.slug;
  while exists (select 1 from public.brands b where b.org_id = p_org_id and b.slug = v_slug) loop
    v_slug := src.slug || '-' || n;
    n := n + 1;
  end loop;
  -- an earlier, ended partnership's brand comes back rather than a second copy
  select b.id into linked from public.brands b where b.org_id = p_org_id and b.source_brand_id = src.id;
  if linked is null then
    insert into public.brands (org_id, name, slug, status, source_brand_id, about, website_url, logo_url, guidelines, library_rule)
    values (p_org_id, src.name, v_slug, 'active', src.id, src.about, src.website_url, src.logo_url, src.guidelines, src.library_rule)
    returning id into linked;
  else
    update public.brands set archived_at = null where id = linked;
  end if;
  -- the channels it goes to: the ones chosen, in this account
  delete from public.brand_channels where brand_id = linked;
  insert into public.brand_channels (org_id, brand_id, channel_id)
  select p_org_id, linked, c.id from public.channels c where c.org_id = p_org_id and c.id = any (p_channel_ids)
  on conflict do nothing;
  perform set_config('kreate.syncing', '', true);

  update public.partnerships set status = 'active', creator_org_id = p_org_id, linked_brand_id = linked,
    creator_name = (select o.name from public.orgs o where o.id = p_org_id), accepted_at = now()
  where id = p.id;
  perform private.sync_partnership(p.id);
  return linked;
end $$;

create function public.decline_partnership(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.partnerships set status = 'declined', ended_at = now()
  where id = p_id and status = 'invited'
    and invited_email = lower((select u.email from auth.users u where u.id = (select auth.uid())));
  if not found then raise exception 'That invitation isn''t yours, or has been answered'; end if;
end $$;

/** Either side ends it (the brand can also withdraw an invitation). The creator's copy is archived. */
create function public.end_partnership(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.partnerships;
begin
  select * into p from public.partnerships where id = p_id for update;
  if p.id is null or p.status not in ('invited', 'active')
     or not (private.is_org_admin(p.publisher_org_id) or (p.creator_org_id is not null and private.is_org_admin(p.creator_org_id))) then
    raise exception 'That partnership isn''t yours to end';
  end if;
  update public.partnerships set status = 'ended', ended_at = now() where id = p.id;
  if p.linked_brand_id is not null then
    perform set_config('kreate.syncing', 'on', true);
    update public.brands set archived_at = coalesce(archived_at, now()) where id = p.linked_brand_id;
    perform set_config('kreate.syncing', '', true);
  end if;
end $$;

revoke all on function public.invite_partner(uuid, text), public.my_partner_invites(), public.accept_partnership(uuid, uuid, uuid[]),
  public.decline_partnership(uuid), public.end_partnership(uuid) from public, anon;
grant execute on function public.invite_partner(uuid, text), public.my_partner_invites(), public.accept_partnership(uuid, uuid, uuid[]),
  public.decline_partnership(uuid), public.end_partnership(uuid) to authenticated, service_role;
