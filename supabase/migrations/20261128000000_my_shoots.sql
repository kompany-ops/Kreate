-- My shoots (the restructure's Phase 8): the shoots you're involved in, across every account you're in,
-- for Your account's home. A shoot is yours when you're on camera for it, or when you're on that
-- account's team and it isn't Live yet. A guest only ever gets their own shoots. Stale shoots never.
create function public.my_shoots()
returns table (
  org_id uuid, org_name text, org_logo_url text, role text,
  code text, status text, shoot_date date, brand_name text, product_name text, on_camera boolean
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.logo_url, m.role, s.code, s.status, s.shoot_date, b.name, pr.name, cam.on_camera
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  join public.shoots s on s.org_id = o.id and s.stale_at is null
  join public.products pr on pr.id = s.product_id
  join public.brands b on b.id = pr.brand_id
  cross join lateral (
    select exists (
      select 1 from public.shoot_people sp join public.people pe on pe.id = sp.person_id
      where sp.shoot_id = s.id and pe.user_id = m.user_id
    ) as on_camera
  ) cam
  where m.user_id = (select auth.uid())
    and (m.shoot_ids is null or s.id = any (m.shoot_ids))
    and (cam.on_camera or (m.role in ('owner', 'team') and s.status <> 'edited'))
  order by coalesce(s.shoot_date, s.created_at::date) desc, s.code desc
  limit 200;
$$;
revoke all on function public.my_shoots() from public, anon;
grant execute on function public.my_shoots() to authenticated, service_role;
