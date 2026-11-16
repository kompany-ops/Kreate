-- Agencies (the restructure's Phase 6). An agency account runs many brands, each with its own
-- profile, products, Library and the agency's private deal with it (its deal columns, which the
-- sync never copies). It invites creators to its brands once its agency plan (kreate_agency) is
-- live, and pays for them with agency seats. Its own Library (items for none of its brands in
-- particular) is linked into every partner creator's account, marked with the agency
-- (partner_org_id), and offered on the shoots of every brand that comes from it. A linked brand
-- records who it's from (brands.partner_org_id), so a creator's Brands page can say "via" the agency.

-- --- who a linked row is from --------------------------------------------------------------------
alter table public.brands add column partner_org_id uuid;
alter table public.hook_templates add column partner_org_id uuid;
alter table public.cta_templates add column partner_org_id uuid;
alter table public.formats add column partner_org_id uuid;
create index brands_partner_org_id_idx on public.brands (partner_org_id);
create index hook_templates_partner_org_id_idx on public.hook_templates (partner_org_id);
create index cta_templates_partner_org_id_idx on public.cta_templates (partner_org_id);
create index formats_partner_org_id_idx on public.formats (partner_org_id);
comment on column public.brands.partner_org_id is 'A linked brand: the brand or agency account it comes from';
comment on column public.hook_templates.partner_org_id is 'Linked in from a partner''s own Library (for any of its brands): that partner account';

-- linked brands so far
update public.brands b set partner_org_id = x.publisher_org_id
from public.partnerships x where x.linked_brand_id = b.id and b.partner_org_id is null;

-- the agency plan
alter table public.org_subscriptions drop constraint org_subscriptions_plan_check;
alter table public.org_subscriptions add constraint org_subscriptions_plan_check check (plan in ('starter', 'pro', 'studio', 'agency'));

create or replace function public.create_org(p_name text, p_slug text, p_profile jsonb default '{}'::jsonb, p_kind text default 'creator')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  org uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if not public.org_signup_open() then raise exception 'New organisations aren''t open yet'; end if;
  if jsonb_typeof(coalesce(p_profile, '{}')) <> 'object' then raise exception 'The profile must be an object'; end if;
  if coalesce(p_kind, '') not in ('creator', 'brand', 'agency') then raise exception 'Choose a creator, brand or agency account'; end if;
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

create or replace function private.sync_partnership(p_id uuid) returns void
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
    guidelines = src.guidelines, library_rule = src.library_rule, partner_org_id = p.publisher_org_id
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

  -- an agency's own Library (for none of its brands in particular): linked in for every one of its
  -- brands here, marked with the agency (partner_org_id)
  if private.org_kind(src.org_id) = 'agency' then
    insert into public.hook_templates (org_id, script, angle_id, est_seconds, tags, notes, archived, source_url, filming_notes, caption, product_id, brand_id, partner_org_id, source_id)
    select p.creator_org_id, h.script,
      (select a.id from public.angles a where a.org_id = p.creator_org_id and lower(a.name) = lower(sa.name) limit 1),
      h.est_seconds, h.tags, h.notes, h.archived, h.source_url, h.filming_notes, h.caption, null, null, src.org_id, h.id
    from public.hook_templates h
    left join public.angles sa on sa.id = h.angle_id
    where h.org_id = src.org_id and h.shoot_id is null and h.brand_id is null and h.product_id is null
    on conflict (org_id, source_id) where source_id is not null do update set
      script = excluded.script, angle_id = excluded.angle_id, est_seconds = excluded.est_seconds, tags = excluded.tags,
      notes = excluded.notes, archived = excluded.archived, source_url = excluded.source_url,
      filming_notes = excluded.filming_notes, caption = excluded.caption;

    insert into public.cta_templates (org_id, script, mode, est_seconds, tags, notes, archived, source_url, product_id, brand_id, partner_org_id, source_id)
    select p.creator_org_id, c.script, c.mode, c.est_seconds, c.tags, c.notes, c.archived, c.source_url, null, null, src.org_id, c.id
    from public.cta_templates c
    where c.org_id = src.org_id and c.shoot_id is null and c.brand_id is null and c.product_id is null
    on conflict (org_id, source_id) where source_id is not null do update set
      script = excluded.script, mode = excluded.mode, est_seconds = excluded.est_seconds, tags = excluded.tags,
      notes = excluded.notes, archived = excluded.archived, source_url = excluded.source_url;

    insert into public.formats (org_id, code, name, description, cta_modes, beats, target_seconds, archived, source_url,
      beat_descriptions, beat_broll, kind, beat_examples, beat_display, brand_id, partner_org_id, source_id)
    select p.creator_org_id,
      case when exists (select 1 from public.formats o where o.org_id = p.creator_org_id and o.code = f.code and o.source_id is distinct from f.id)
        then f.code || '-' || upper((select o.slug from public.orgs o where o.id = src.org_id)) else f.code end,
      f.name, f.description, f.cta_modes, f.beats, f.target_seconds, f.archived, f.source_url,
      f.beat_descriptions, f.beat_broll, f.kind, f.beat_examples, f.beat_display, null, src.org_id, f.id
    from public.formats f
    where f.org_id = src.org_id and f.brand_id is null
    on conflict (org_id, source_id) where source_id is not null do update set
      name = excluded.name, description = excluded.description, cta_modes = excluded.cta_modes, beats = excluded.beats,
      target_seconds = excluded.target_seconds, archived = excluded.archived, source_url = excluded.source_url,
      beat_descriptions = excluded.beat_descriptions, beat_broll = excluded.beat_broll, kind = excluded.kind,
      beat_examples = excluded.beat_examples, beat_display = excluded.beat_display;

    -- what's no longer the agency's own Library is archived here
    update public.hook_templates l set archived = true
    where l.org_id = p.creator_org_id and l.partner_org_id = src.org_id and l.brand_id is null and l.product_id is null and not l.archived
      and not exists (select 1 from public.hook_templates h where h.id = l.source_id and h.shoot_id is null and h.brand_id is null and h.product_id is null);
    update public.cta_templates l set archived = true
    where l.org_id = p.creator_org_id and l.partner_org_id = src.org_id and l.brand_id is null and l.product_id is null and not l.archived
      and not exists (select 1 from public.cta_templates c where c.id = l.source_id and c.shoot_id is null and c.brand_id is null and c.product_id is null);
    update public.formats l set archived = true
    where l.org_id = p.creator_org_id and l.partner_org_id = src.org_id and l.brand_id is null and not l.archived
      and not exists (select 1 from public.formats f where f.id = l.source_id and f.brand_id is null);
  end if;

  perform set_config('kreate.syncing', '', true);
end $$;

create or replace function private.resync_on_change() returns trigger
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
  -- an agency's own Library item (no brand, no product): every partnership the agency has
  if brand is null and tg_table_name in ('hook_templates', 'cta_templates', 'formats') and (to_jsonb(r) ->> 'source_id') is null
     and private.org_kind(r.org_id) = 'agency' then
    perform private.sync_partnership(x.id) from public.partnerships x where x.publisher_org_id = r.org_id and x.status = 'active';
    return null;
  end if;
  perform private.resync_brand(brand);
  return null;
end $$;

create or replace function public.accept_partnership(p_id uuid, p_org_id uuid, p_channel_ids uuid[] default '{}') returns uuid
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
    insert into public.brands (org_id, name, slug, status, source_brand_id, partner_org_id, about, website_url, logo_url, guidelines, library_rule)
    values (p_org_id, src.name, v_slug, 'active', src.id, p.publisher_org_id, src.about, src.website_url, src.logo_url, src.guidelines, src.library_rule)
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

create or replace function public.invite_partner(p_brand_id uuid, p_email text) returns uuid
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
  if private.org_kind(b.org_id) = 'agency' and private.org_plan(b.org_id) not in ('agency', 'studio') then
    raise exception 'Start the agency plan in Settings → Billing to invite creators';
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

create or replace function public.partner_item_results(p_brand_id uuid)
returns table (kind text, item_id uuid, label text, archived boolean, shoots integer, winners integer, mids integer, losers integer)
language plpgsql stable security definer set search_path = '' as $$
-- the output columns share names with columns in the queries: the queries mean the columns
#variable_conflict use_column
begin
  if not private.owns_brand(p_brand_id) then
    raise exception 'Only the brand''s team sees its results';
  end if;
  return query
  with items as (
    select 'hook'::text as kind, h.id, h.script as label, h.archived from public.hook_templates h
    where h.shoot_id is null and h.source_id is null
      and (h.brand_id = p_brand_id or h.product_id in (select id from public.products where brand_id = p_brand_id))
    union all
    select 'cta', c.id, c.script, c.archived from public.cta_templates c
    where c.shoot_id is null and c.source_id is null
      and (c.brand_id = p_brand_id or c.product_id in (select id from public.products where brand_id = p_brand_id))
    union all
    select 'format', f.id, f.code || ' · ' || f.name, f.archived from public.formats f
    where f.source_id is null and f.brand_id = p_brand_id
    -- an agency's own Library, used on this brand's shoots
    union all
    select 'hook', h.id, h.script, h.archived from public.hook_templates h
    join public.brands b on b.id = p_brand_id and b.org_id = h.org_id and private.org_kind(b.org_id) = 'agency'
    where h.shoot_id is null and h.source_id is null and h.brand_id is null and h.product_id is null
    union all
    select 'cta', c.id, c.script, c.archived from public.cta_templates c
    join public.brands b on b.id = p_brand_id and b.org_id = c.org_id and private.org_kind(b.org_id) = 'agency'
    where c.shoot_id is null and c.source_id is null and c.brand_id is null and c.product_id is null
    union all
    select 'format', f.id, f.code || ' · ' || f.name, f.archived from public.formats f
    join public.brands b on b.id = p_brand_id and b.org_id = f.org_id and private.org_kind(b.org_id) = 'agency'
    where f.source_id is null and f.brand_id is null
  ),
  -- where each was used: the shoots, and the code it had on each
  uses as (
    select i.kind, i.id, si.shoot_id, si.code
    from items i
    join public.hook_templates copy on i.kind = 'hook' and copy.source_id = i.id
    join public.shoot_items si on si.kind = 'hook' and si.hook_template_id = copy.id
    union
    select i.kind, i.id, si.shoot_id, si.code
    from items i
    join public.cta_templates copy on i.kind = 'cta' and copy.source_id = i.id
    join public.shoot_items si on si.kind = 'cta' and si.cta_template_id = copy.id
    union
    select i.kind, i.id, sf.shoot_id, copy.code
    from items i
    join public.formats copy on i.kind = 'format' and copy.source_id = i.id
    join public.shoot_formats sf on sf.format_id = copy.id
  ),
  -- (an agency's own item is linked into every brand: only this brand's shoots count here)
  brand_uses as (
    select u.* from uses u
    join public.shoots s on s.id = u.shoot_id
    join public.products pr on pr.id = s.product_id
    join public.brands lb on lb.id = pr.brand_id and lb.source_brand_id = p_brand_id
  ),
  scores as (
    select u.kind, u.id, bs.score
    from (select distinct kind, id, shoot_id, code from brand_uses) u
    join public.shoot_shortlists sl on sl.shoot_id = u.shoot_id
    join public.batch_scores bs on bs.shortlist_id = sl.id and bs.element_kind = u.kind and bs.element_key = u.code
  )
  select i.kind, i.id, i.label, i.archived,
    (select count(distinct u.shoot_id)::integer from brand_uses u where u.kind = i.kind and u.id = i.id),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'winner'),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'mid'),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'loser')
  from items i
  order by 6 desc, 5 desc, i.kind, i.label;
end $$;

-- nobody marks their own rows as a partner's
create or replace function private.guard_linked_inserts() returns trigger
language plpgsql set search_path = '' as $$
declare
  -- one function for several tables: columns are read by name, since not every table has each
  j jsonb := to_jsonb(new);
begin
  if private.is_syncing() or (select auth.uid()) is null then
    return new;
  end if;
  if coalesce(j ->> 'source_brand_id', j ->> 'source_product_id', j ->> 'source_feature_id', j ->> 'source_id', j ->> 'partner_org_id') is not null
     or (tg_table_name = 'products' and exists (select 1 from public.brands b where b.id = (j ->> 'brand_id')::uuid and b.source_brand_id is not null))
     or (tg_table_name = 'product_features' and exists (select 1 from public.products x where x.id = (j ->> 'product_id')::uuid and x.source_product_id is not null)) then
    raise exception 'Products, features and Library items from a partner brand come from the partner';
  end if;
  return new;
end $$;
