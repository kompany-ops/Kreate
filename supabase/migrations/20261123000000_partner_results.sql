-- Results for brands (the restructure's Phase 4): a brand account sees the shoots its partner
-- creators make for it, and how its Library does across them. Read-only, and only ever about the
-- brand's own shoots: never creators' media, their other brands, their own Library or people's names.
-- Both functions answer only the team of the account that owns the brand.

create function private.owns_brand(p_brand_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.brands b
    where b.id = p_brand_id and b.source_brand_id is null and private.is_org_admin(b.org_id)
  );
$$;
revoke all on function private.owns_brand(uuid) from public, anon;
grant execute on function private.owns_brand(uuid) to authenticated, service_role;

/** Every shoot partner creators have made for one of your brands. */
create function public.partner_shoots(p_brand_id uuid)
returns table (
  shoot_id uuid, code text, status text, shoot_date date, started_at timestamptz, ended_at timestamptz,
  creator_name text, partnership_active boolean, product_name text, channels text[],
  clips_edited integer, batches integer, batches_measured integer, renders integer
)
language plpgsql stable security definer set search_path = '' as $$
-- the output columns share names with columns in the queries: the queries mean the columns
#variable_conflict use_column
begin
  if not private.owns_brand(p_brand_id) then
    raise exception 'Only the brand''s team sees its results';
  end if;
  return query
  select s.id, s.code, s.status, s.shoot_date, s.started_at, s.ended_at,
    coalesce(x.creator_name, 'A creator'), coalesce(x.status = 'active', false), pr.name,
    coalesce((select array_agg(c.name order by c.name) from public.shoot_channels sc join public.channels c on c.id = sc.channel_id where sc.shoot_id = s.id), '{}'),
    coalesce((
      select count(*)::integer from jsonb_array_elements(m.data -> 'clips') clip
      where clip ->> 'kind' <> 'broll' and coalesce(clip ->> 'file', '') <> ''
    ), 0),
    (select count(*)::integer from public.shoot_shortlists sl where sl.shoot_id = s.id),
    (select count(*)::integer from public.shoot_shortlists sl where sl.shoot_id = s.id and sl.status = 'measured'),
    coalesce((select sum(sl.size)::integer from public.shoot_shortlists sl where sl.shoot_id = s.id), 0)
  from public.brands lb
  join public.products pr on pr.brand_id = lb.id
  join public.shoots s on s.product_id = pr.id and s.stale_at is null
  left join lateral (
    select y.creator_name, y.status from public.partnerships y
    where y.linked_brand_id = lb.id order by y.created_at desc limit 1
  ) x on true
  left join lateral (
    select sm.data from public.shoot_manifests sm where sm.shoot_id = s.id order by sm.version desc limit 1
  ) m on true
  where lb.source_brand_id = p_brand_id
  order by coalesce(s.shoot_date, s.created_at::date) desc, s.code;
end $$;

/**
 * How each of your brand's Library items has done on your partners' shoots: how many shoots used
 * it, and its batch scores there (a hook or CTA scored by the code it had on the shoot, a format by
 * its code in the creator's account).
 */
create function public.partner_item_results(p_brand_id uuid)
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
  scores as (
    select u.kind, u.id, bs.score
    from (select distinct kind, id, shoot_id, code from uses) u
    join public.shoot_shortlists sl on sl.shoot_id = u.shoot_id
    join public.batch_scores bs on bs.shortlist_id = sl.id and bs.element_kind = u.kind and bs.element_key = u.code
  )
  select i.kind, i.id, i.label, i.archived,
    (select count(distinct u.shoot_id)::integer from uses u where u.kind = i.kind and u.id = i.id),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'winner'),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'mid'),
    (select count(*)::integer from scores sc where sc.kind = i.kind and sc.id = i.id and sc.score = 'loser')
  from items i
  order by 6 desc, 5 desc, i.kind, i.label;
end $$;

revoke all on function public.partner_shoots(uuid), public.partner_item_results(uuid) from public, anon;
grant execute on function public.partner_shoots(uuid), public.partner_item_results(uuid) to authenticated, service_role;
