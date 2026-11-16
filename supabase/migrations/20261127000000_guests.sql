-- Guest collaborators (the restructure's Phase 7): the team invites someone from outside the account
-- onto one shoot (or a few). A guest is cast limited to those shoots (org_members.shoot_ids): they
-- film and upload their takes there, and see only what those shoots need. That's the shoot itself
-- and what's on it, its brand and product (never the deal: brand_deals is the team's), the people
-- and channels on it, and the Library items it uses. No chat, no other shoots, brands, products or
-- Library, no billing. Guests don't count toward the plan's cast.

alter table public.org_members add column shoot_ids uuid[];
alter table public.org_invites add column shoot_ids uuid[];
alter table public.org_members add constraint org_members_guest_is_cast check (shoot_ids is null or role = 'cast');
alter table public.org_invites add constraint org_invites_guest_is_cast check (shoot_ids is null or role = 'cast');
comment on column public.org_members.shoot_ids is 'A guest: cast on just these shoots, seeing nothing else of the account. Null: the whole account.';

-- --- what a guest can see ------------------------------------------------------------------------
/** The signed-in person's shoots in the current account if they're a guest; null if they're not. */
create function private.guest_shoots() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select m.shoot_ids from public.org_members m
  where m.org_id = private.current_org_id() and m.user_id = (select auth.uid());
$$;
create function private.is_guest() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is not null;
$$;
create function private.guest_sees_shoot(p_shoot_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null or p_shoot_id = any (private.guest_shoots());
$$;
create function private.guest_sees_product(p_product_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or exists (select 1 from public.shoots s where s.product_id = p_product_id and s.id = any (private.guest_shoots()));
$$;
create function private.guest_sees_brand(p_brand_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or exists (select 1 from public.shoots s join public.products p on p.id = s.product_id
               where p.brand_id = p_brand_id and s.id = any (private.guest_shoots()));
$$;
/** A Library item a guest's shoot uses (on its shot list, or written in it). */
create function private.guest_sees_template(p_kind text, p_template_id uuid, p_shoot_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or p_shoot_id = any (private.guest_shoots())
    or exists (
      select 1 from public.shoot_items si
      where si.shoot_id = any (private.guest_shoots()) and si.kind = p_kind
        and p_template_id = case p_kind when 'hook' then si.hook_template_id when 'cta' then si.cta_template_id else si.body_template_id end
    );
$$;
create function private.guest_sees_format(p_format_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or exists (select 1 from public.shoot_formats sf where sf.format_id = p_format_id and sf.shoot_id = any (private.guest_shoots()))
    or exists (select 1 from public.shoot_items si join public.body_templates b on b.id = si.body_template_id
               where b.format_id = p_format_id and si.shoot_id = any (private.guest_shoots()));
$$;
create function private.guest_sees_person(p_person_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or exists (select 1 from public.shoot_people sp where sp.person_id = p_person_id and sp.shoot_id = any (private.guest_shoots()));
$$;
create function private.guest_sees_channel(p_channel_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.guest_shoots() is null
    or exists (select 1 from public.shoot_channels sc where sc.channel_id = p_channel_id and sc.shoot_id = any (private.guest_shoots()));
$$;
do $$
declare
  f text;
begin
  foreach f in array array['guest_shoots()', 'is_guest()', 'guest_sees_shoot(uuid)', 'guest_sees_product(uuid)', 'guest_sees_brand(uuid)',
    'guest_sees_template(text, uuid, uuid)', 'guest_sees_format(uuid)', 'guest_sees_person(uuid)', 'guest_sees_channel(uuid)'] loop
    execute format('revoke all on function private.%s from public, anon', f);
    execute format('grant execute on function private.%s to authenticated, service_role', f);
  end loop;
end $$;

-- --- reads: everyone as before; a guest only what their shoots need -------------------------------
-- (select not private.is_guest()) is worked out once per query, so nobody but a guest pays for the
-- per-row checks.
do $$
declare
  member constant text := 'org_id = (select private.current_org_id())';
  t text;
begin
  -- a shoot, and everything on it
  execute format('alter policy "org members can read" on public.shoots using (%s and ((select not private.is_guest()) or private.guest_sees_shoot(id)))', member);
  foreach t in array array['shoot_items', 'shoot_people', 'shoot_channels', 'shoot_formats', 'broll_shots', 'shoot_clips',
    'shoot_manifests', 'shoot_shortlists', 'shoot_element_overrides'] loop
    execute format('alter policy "org members can read" on public.%I using (%s and ((select not private.is_guest()) or private.guest_sees_shoot(shoot_id)))', t, member);
  end loop;
  -- its brand, product and features
  execute format('alter policy "org members can read" on public.brands using (%s and ((select not private.is_guest()) or private.guest_sees_brand(id)))', member);
  execute format('alter policy "org members can read" on public.products using (%s and ((select not private.is_guest()) or private.guest_sees_product(id)))', member);
  execute format('alter policy "org members can read" on public.product_features using (%s and ((select not private.is_guest()) or private.guest_sees_product(product_id)))', member);
  -- the Library items it uses
  execute format('alter policy "org members can read" on public.hook_templates using (%s and ((select not private.is_guest()) or private.guest_sees_template(''hook'', id, shoot_id)))', member);
  execute format('alter policy "org members can read" on public.cta_templates using (%s and ((select not private.is_guest()) or private.guest_sees_template(''cta'', id, shoot_id)))', member);
  execute format('alter policy "org members can read" on public.body_templates using (%s and ((select not private.is_guest()) or private.guest_sees_template(''body'', id, shoot_id)))', member);
  execute format('alter policy "org members can read" on public.formats using (%s and ((select not private.is_guest()) or private.guest_sees_format(id)))', member);
  foreach t in array array['vo_cast', 'vo_hook_links', 'vo_cta_links', 'body_template_products'] loop
    execute format('alter policy "org members can read" on public.%I using (%s and ((select not private.is_guest()) or private.guest_sees_template(''body'', body_template_id, null)))', t, member);
  end loop;
  -- the people and channels on it
  execute format('alter policy "org members can read" on public.people using (%s and ((select not private.is_guest()) or private.guest_sees_person(id)))', member);
  execute format('alter policy "org members can read" on public.person_channels using (%s and ((select not private.is_guest()) or private.guest_sees_person(person_id)))', member);
  execute format('alter policy "org members can read" on public.channels using (%s and ((select not private.is_guest()) or private.guest_sees_channel(id)))', member);
  -- nothing else of the account: brand channels, batch scores, chat, billing, seats, other members
  foreach t in array array['brand_channels', 'batch_scores', 'org_subscriptions'] loop
    execute format('alter policy "org members can read" on public.%I using (%s and (select not private.is_guest()))', t, member);
  end loop;
  execute format('alter policy "org members read the chat" on public.org_messages using (%s and (select not private.is_guest()))', member);
  execute format('alter policy "org members can read" on public.org_members using (%s and ((select not private.is_guest()) or user_id = (select auth.uid())))', member);
end $$;
alter policy "either side can read" on public.seats using (
  (publisher_org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  or (creator_org_id = (select private.current_org_id()) and (select not private.is_guest()))
);

-- --- guests don't count toward the cast ------------------------------------------------------------
create or replace function private.org_usage(p_org_id uuid)
returns table (team integer, cast_members integer, channels integer, brands integer, shoots_this_month integer)
language sql stable security definer set search_path = '' as $$
  select
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role in ('owner', 'team'))
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'team'))::integer,
    ((select count(*) from public.org_members m where m.org_id = p_org_id and m.role = 'cast' and m.shoot_ids is null)
      + (select count(*) from public.org_invites i where i.org_id = p_org_id and i.role = 'cast' and i.shoot_ids is null))::integer,
    (select count(*) from public.channels c where c.org_id = p_org_id and c.active)::integer,
    (select count(*) from public.brands b where b.org_id = p_org_id and b.archived_at is null and b.source_brand_id is null)::integer,
    coalesce((select c.planned from private.org_shoot_counts c where c.org_id = p_org_id and c.month = date_trunc('month', now())::date), 0);
$$;

create or replace function private.limit_people() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- a guest isn't one of the plan's cast
  if new.shoot_ids is not null then
    return new;
  end if;
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    perform private.check_plan_limit(new.org_id, new.role);
  end if;
  return new;
end $$;

-- --- an invitation carries its shoots: the guest joins them on signing in ----------------------------
create function private.join_invited_shoots(p_org_id uuid, p_user_id uuid, p_shoot_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  person uuid;
begin
  if p_shoot_ids is null or not exists (select 1 from public.shoots s where s.org_id = p_org_id and s.id = any (p_shoot_ids)) then
    return;
  end if;
  person := private.person_for_member(p_org_id, p_user_id);
  update public.people set active = true where id = person and not active;
  insert into public.shoot_people (org_id, shoot_id, person_id)
  select p_org_id, s.id, person from public.shoots s where s.org_id = p_org_id and s.id = any (p_shoot_ids)
  on conflict do nothing;
end $$;
revoke all on function private.join_invited_shoots(uuid, uuid, uuid[]) from public, anon, authenticated;

create or replace function private.accept_org_invites() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  invite record;
begin
  if new.email is not null and new.email_confirmed_at is not null then
    for invite in select * from public.org_invites i where i.email = lower(new.email) loop
      insert into public.org_members (org_id, user_id, role, display_name, shoot_ids)
      values (invite.org_id, new.id, invite.role, invite.display_name, invite.shoot_ids)
      on conflict do nothing;
      perform private.join_invited_channels(invite.org_id, new.id, invite.channel_ids);
      perform private.join_invited_shoots(invite.org_id, new.id, invite.shoot_ids);
    end loop;
    delete from public.org_invites where email = lower(new.email);
  end if;
  return new;
end $$;

create or replace function private.invite_existing_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  existing uuid;
begin
  select u.id into existing from auth.users u
  where lower(u.email) = new.email and u.email_confirmed_at is not null
  limit 1;
  if existing is null then
    return new;
  end if;
  insert into public.org_members (org_id, user_id, role, display_name, shoot_ids)
  values (new.org_id, existing, new.role, new.display_name, new.shoot_ids)
  on conflict do nothing;
  perform private.join_invited_channels(new.org_id, existing, new.channel_ids);
  perform private.join_invited_shoots(new.org_id, existing, new.shoot_ids);
  return null;
end $$;

-- --- my_orgs says when you're a guest (and on which shoots) ----------------------------------------
drop function public.my_orgs();
create function public.my_orgs()
returns table (id uuid, name text, slug text, role text, display_name text, is_current boolean, has_chosen boolean, entitled boolean, klip_access text, logo_url text, kind text, shoot_ids uuid[])
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.slug, m.role, m.display_name,
    o.id = private.current_org_id(),
    p.active_org_id is not null,
    private.org_is_entitled(o.id),
    private.org_klip_access(o.id),
    o.logo_url,
    o.kind,
    m.shoot_ids
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  join public.profiles p on p.id = m.user_id
  where m.user_id = (select auth.uid())
  order by o.name;
$$;
revoke all on function public.my_orgs() from public, anon;
grant execute on function public.my_orgs() to authenticated, service_role;
