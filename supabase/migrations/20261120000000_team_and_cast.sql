-- Team and cast replace admin and member (docs/spec.md §3).
--   owner — one per org: the person whose account it is. Pays, and is the only one who adds or
--           removes team members (they can cost money).
--   team  — run the account with the owner: everything an admin could do.
--   cast  — on camera: they see the org, tick off their own shots and add their own clips, but
--           don't plan, write the Library or Brands, or change settings. Cast are free.
-- Existing admins and members become team, so nobody loses access; each org's creator (or, if
-- they've left, its earliest admin) becomes its owner.

-- --- roles -------------------------------------------------------------------------------------
alter table public.org_members drop constraint org_members_role_check;
alter table public.org_invites drop constraint org_invites_role_check;

with pick as (
  select distinct on (o.id) o.id as org_id, m.user_id
  from public.orgs o
  join public.org_members m on m.org_id = o.id
  order by o.id, (m.user_id = o.created_by) desc, (m.role = 'admin') desc, m.created_at, m.user_id
)
update public.org_members m set role = 'owner'
from pick
where m.org_id = pick.org_id and m.user_id = pick.user_id;

update public.org_members set role = 'team' where role in ('admin', 'member');
update public.org_invites set role = 'team' where role in ('admin', 'member');

alter table public.org_members
  add constraint org_members_role_check check (role in ('owner', 'team', 'cast')),
  alter column role set default 'cast';
alter table public.org_invites
  add constraint org_invites_role_check check (role in ('team', 'cast')),
  alter column role set default 'cast';
create unique index org_members_one_owner on public.org_members (org_id) where role = 'owner';

comment on column public.org_members.role is 'owner (one per org, pays), team (plans and runs the account) or cast (on camera, free)';
comment on column public.org_invites.role is 'team or cast: an invite never makes an owner';

-- --- who's who ---------------------------------------------------------------------------------
-- "Admin" now means "on the team" (the owner included). Every policy and guard that asked for an
-- admin asks for the team without changing.
create or replace function private.is_org_admin(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'team')
  );
$$;
comment on function private.is_org_admin(uuid) is 'On the team (owner or team) of that org.';

create function private.is_org_owner(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;
revoke all on function private.is_org_owner(uuid) from public, anon;
grant execute on function private.is_org_owner(uuid) to authenticated, service_role;

-- Only the owner adds or removes team members, nobody becomes owner through the app, and the owner
-- can't be removed or demoted. Name changes (role untouched) are fine for anyone allowed to edit.
create function private.guard_roles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  org uuid := coalesce(new.org_id, old.org_id);
  changed boolean := tg_op <> 'UPDATE' or new.role is distinct from old.role;
begin
  if (select auth.uid()) is null or not changed then
    return coalesce(new, old);
  end if;
  if tg_op <> 'INSERT' and old.role = 'owner' then
    raise exception 'The owner can''t be removed or given another role';
  end if;
  if tg_op <> 'DELETE' and new.role = 'owner' then
    raise exception 'Nobody can be made the owner here';
  end if;
  if not private.is_org_owner(org)
     and ((tg_op <> 'INSERT' and old.role = 'team') or (tg_op <> 'DELETE' and new.role = 'team')) then
    raise exception 'Only the owner can add or remove team members';
  end if;
  return coalesce(new, old);
end $$;

create trigger guard_roles before update or delete on public.org_members
  for each row execute function private.guard_roles();
create trigger guard_roles before insert or update or delete on public.org_invites
  for each row execute function private.guard_roles();

-- A new org's creator is its owner.
create or replace function public.create_org(p_name text, p_slug text, p_profile jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  org uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if not public.org_signup_open() then raise exception 'New organisations aren''t open yet'; end if;
  if jsonb_typeof(coalesce(p_profile, '{}')) <> 'object' then raise exception 'The profile must be an object'; end if;
  insert into public.orgs (name, slug, created_by) values (trim(p_name), p_slug, me) returning id into org;
  insert into public.org_members (org_id, user_id, role) values (org, me, 'owner');
  update public.profiles set active_org_id = org where id = me;
  insert into public.settings (org_id, org_profile) values (org, coalesce(p_profile, '{}'));
  insert into public.treatments (org_id, name, description, kind, placement, needs, component, settings, active, system, sort_order) values
    (org, 'Face to camera', 'The whole video with the speaker on camera: every VO beat shows them talking (a talking-head version). Skipped where a recipe already shows them throughout.', 'layout', 'video', array['speaker_video'], 'layout', '{"show": "face"}', true, true, 1),
    (org, 'Over b-roll', 'The whole video over b-roll: every VO beat is their voice over footage, none on camera. Skipped where a recipe already plays over b-roll throughout.', 'layout', 'video', '{}', 'layout', '{"show": "broll"}', true, true, 2);
  return org;
end $$;

-- --- cast don't plan ---------------------------------------------------------------------------
-- Every write that any member could make (the Library, Brands, products, shoots and what's in
-- them) is now the team's. Cast keep: ticking off their own shots, ticking off b-roll (nobody owns a
-- b-roll shot: whoever's on set films it), their own clips, and chat.
do $$
declare
  p record;
  member constant text := '(org_id = ( SELECT private.current_org_id() AS current_org_id))';
  team constant text := '((org_id = (select private.current_org_id())) and (select private.is_org_admin(private.current_org_id())))';
  q text;
  c text;
begin
  for p in
    select tablename, policyname, cmd, qual, with_check from pg_policies
    where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd <> 'SELECT'
      and (coalesce(qual, '') like '%' || member || '%' or coalesce(with_check, '') like '%' || member || '%')
      and coalesce(qual, '') not like '%is_org_admin%' and coalesce(with_check, '') not like '%is_org_admin%'
      and tablename not in ('org_messages', 'org_chat_reads', 'shoot_clips')
      and not (tablename in ('shoot_items', 'broll_shots') and cmd = 'UPDATE')
  loop
    q := replace(p.qual, member, team);
    c := replace(p.with_check, member, team);
    if p.cmd = 'DELETE' then
      execute format('alter policy %I on public.%I using (%s)', p.policyname, p.tablename, q);
    elsif p.cmd = 'INSERT' then
      execute format('alter policy %I on public.%I with check (%s)', p.policyname, p.tablename, c);
    else
      execute format('alter policy %I on public.%I using (%s) with check (%s)', p.policyname, p.tablename, q, c);
    end if;
    execute format('alter policy %I on public.%I rename to %I', p.policyname, p.tablename, replace(p.policyname, 'org members', 'the team'));
  end loop;
end $$;

-- Shots: the team edits any; cast tick off their own (status and take notes only).
alter policy "org members can update" on public.shoot_items
  using (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)))
  with check (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)));
alter policy "org members can update" on public.shoot_items rename to "the team, or cast on their own shots, can update";

create function private.guard_cast_shot_edits() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.is_org_admin(new.org_id) then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'take_notes', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'take_notes', 'updated_at']) then
    raise exception 'Cast can only tick off their shots and add take notes';
  end if;
  return new;
end $$;
create trigger guard_cast_shot_edits before update on public.shoot_items
  for each row execute function private.guard_cast_shot_edits();

-- B-roll: anyone can tick it off on set, but only the team changes what it is.
alter policy "org members can update" on public.broll_shots rename to "the team, or cast filming, can update";
create function private.guard_cast_broll_edits() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.is_org_admin(new.org_id) then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'clips_filmed', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'clips_filmed', 'updated_at']) then
    raise exception 'Cast can only tick off b-roll';
  end if;
  return new;
end $$;
create trigger guard_cast_broll_edits before update on public.broll_shots
  for each row execute function private.guard_cast_broll_edits();

-- Clips: the team handles any; cast add, fix and remove their own.
alter policy "org members can insert" on public.shoot_clips
  with check (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or created_by = (select auth.uid())));
alter policy "org members can update" on public.shoot_clips
  using (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or created_by = (select auth.uid())))
  with check (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or created_by = (select auth.uid())));
alter policy "org members can delete" on public.shoot_clips
  using (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or created_by = (select auth.uid())));
alter policy "org members can insert" on public.shoot_clips rename to "the team, or cast for their own clips, can insert";
alter policy "org members can update" on public.shoot_clips rename to "the team, or cast for their own clips, can update";
alter policy "org members can delete" on public.shoot_clips rename to "the team, or cast for their own clips, can delete";

-- nothing but chat and filming (b-roll, guarded above) may still be writable by any member
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd <> 'SELECT'
      and tablename not in ('org_messages', 'org_chat_reads')
      and not (tablename = 'broll_shots' and cmd = 'UPDATE')
      and (coalesce(qual, '') ~ 'current_org_id' or coalesce(with_check, '') ~ 'current_org_id')
      and coalesce(qual, '') !~ 'is_org_admin' and coalesce(with_check, '') !~ 'is_org_admin'
  ) then
    raise exception 'A policy still lets cast write';
  end if;
end $$;

-- --- Your account → Organisations: "admins" counts the team ------------------------------------
create or replace function public.my_org_summaries()
returns table (org_id uuid, members integer, admins integer, invites integer, channels integer, brands integer, products integer, hooks integer, ctas integer, draft_shoots integer, active_shoots integer, live_shoots integer, shoots_this_month integer, last_shoot_at timestamptz, billing_exempt boolean, subscription_status text, trial_end timestamptz, current_period_end timestamptz, cancel_at_period_end boolean, faces jsonb, chat_unread integer)
language sql stable security definer set search_path = '' as $$
  select o.id,
    (select count(*) from public.org_members x where x.org_id = o.id)::integer,
    (select count(*) from public.org_members x where x.org_id = o.id and x.role in ('owner', 'team'))::integer,
    (select count(*) from public.org_invites i where i.org_id = o.id)::integer,
    (select count(*) from public.channels c where c.org_id = o.id and c.active)::integer,
    (select count(*) from public.brands b where b.org_id = o.id)::integer,
    (select count(*) from public.products p where p.org_id = o.id)::integer,
    (select count(*) from public.hook_templates h where h.org_id = o.id)::integer,
    (select count(*) from public.cta_templates c where c.org_id = o.id)::integer,
    sh.drafts, sh.active, sh.live, sh.this_month, sh.last_at,
    o.billing_exempt,
    sub.status,
    sub.trial_end,
    sub.current_period_end,
    sub.cancel_at_period_end,
    (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'photo', f.photo) order by f.rank, f.joined), '[]'::jsonb)
     from (
       select coalesce(x.display_name, p.display_name, p.full_name, p.email) as name,
         coalesce(p.photo_url, p.avatar_url) as photo,
         case x.role when 'owner' then 0 when 'team' then 1 else 2 end as rank,
         x.created_at as joined
       from public.org_members x
       join public.profiles p on p.id = x.user_id
       where x.org_id = o.id
       order by case x.role when 'owner' then 0 when 'team' then 1 else 2 end, x.created_at
       limit 4
     ) f),
    (select count(*)::integer from public.org_messages cm
     where cm.org_id = o.id and cm.deleted_at is null
       and cm.author_id is distinct from m.user_id
       and cm.created_at > coalesce((select r.last_read_at from public.org_chat_reads r where r.org_id = o.id and r.user_id = m.user_id), '-infinity'::timestamptz))
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  cross join lateral (
    select
      (count(*) filter (where s.status = 'draft'))::integer as drafts,
      -- planned, being filmed, filmed or being edited: on its way to Live
      (count(*) filter (where s.status in ('planned', 'shooting', 'filmed', 'editing')))::integer as active,
      (count(*) filter (where s.status = 'edited'))::integer as live,
      (count(*) filter (where s.created_at >= date_trunc('month', now())))::integer as this_month,
      max(s.created_at) as last_at
    from public.shoots s
    where s.org_id = o.id
  ) sh
  left join lateral (
    select s.status, s.trial_end, s.current_period_end, s.cancel_at_period_end
    from public.org_subscriptions s
    where s.org_id = o.id
    order by s.created_at desc
    limit 1
  ) sub on true
  where m.user_id = (select auth.uid());
$$;
