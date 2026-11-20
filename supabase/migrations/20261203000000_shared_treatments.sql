-- Treatments are one set for every account, no longer each account's own: the account with the
-- most treatments (the one that set them up) gives its set to everyone, every other account's
-- copies go (they were only the built-in Face to camera), and nobody changes them from the app.
-- Each shoot can switch any of them off for itself (shoots.treatments_off), until it's sent for
-- editing: from there Klip's manifest holds the treatments it was given.

alter table public.treatments disable trigger treatments_protect_system;

delete from public.treatments
where org_id is distinct from (
  select org_id from public.treatments group by org_id order by count(*) desc, min(created_at) limit 1
);

drop policy if exists "org members can read" on public.treatments;
drop policy if exists "the team can insert" on public.treatments;
drop policy if exists "the team can update" on public.treatments;
drop policy if exists "the team can delete their own" on public.treatments;

alter table public.treatments drop column org_id;
alter table public.treatments add constraint treatments_name_key unique (name);

-- a fresh database has none: the built-in one
insert into public.treatments (name, description, kind, placement, needs, component, settings, active, system, sort_order)
select 'Face to camera', 'The whole video with the speaker on camera: every VO beat shows them talking (a talking-head version). Skipped where a recipe already shows them throughout.', 'layout', 'video', array['speaker_video'], 'layout', '{"show": "face"}', true, true, 1
where not exists (select 1 from public.treatments where system);

alter table public.treatments enable trigger treatments_protect_system;

-- everyone signed in reads them; only migrations change them
revoke insert, update, delete on public.treatments from authenticated;
create policy "signed-in users can read" on public.treatments for select to authenticated using (true);
comment on table public.treatments is 'Ways a finished recipe is presented, the same for every account. Changed by migrations only; each shoot can switch any off (shoots.treatments_off).';

-- per shoot: the treatments it leaves out (new ones are on everywhere)
alter table public.shoots add column treatments_off uuid[] not null default '{}';
comment on column public.shoots.treatments_off is 'Treatments this shoot leaves out of its recipes. Can change until the shoot is sent for editing; from there the manifest holds what Klip was given.';

create or replace function private.guard_shoot_treatments() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.treatments_off is distinct from old.treatments_off and old.status in ('editing', 'edited') then
    raise exception 'The shoot has gone to editing: its treatments are the ones Klip was given';
  end if;
  return new;
end $$;

create trigger shoots_guard_treatments before update of treatments_off on public.shoots
  for each row execute function private.guard_shoot_treatments();

-- new accounts no longer get their own treatments
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
  end if;
  return org;
end $$;
