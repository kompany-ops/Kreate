-- Hooks and CTAs are never over b-roll.
-- 1. The built-in Over b-roll treatment goes: on a recipe it's the untreated version again (the
--    middle beats are over b-roll already) plus a hook and CTA over b-roll. Face to camera stays
--    the one built-in treatment. Combinations that used it are archived, without it.
-- 2. A standalone format's hook and CTA beats are shown face to camera (or on screen, or as a voice
--    note), never over b-roll; any set to b-roll become face to camera. Library CTAs keep VO mode.

-- 1. the treatment, from every account (the trigger keeps built-ins from being deleted by people)
alter table public.treatments disable trigger treatments_protect_system;

update public.treatments c
set archived = true,
    parts = array(select part from unnest(c.parts) part where part not in (
      select t.id from public.treatments t where t.system and t.component = 'layout' and t.settings ->> 'show' = 'broll'))
where cardinality(c.parts) > 0
  and c.parts && array(select t.id from public.treatments t where t.system and t.component = 'layout' and t.settings ->> 'show' = 'broll');

delete from public.treatments where system and component = 'layout' and settings ->> 'show' = 'broll';

alter table public.treatments enable trigger treatments_protect_system;

-- new accounts get Face to camera only
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
      (org, 'Face to camera', 'The whole video with the speaker on camera: every VO beat shows them talking (a talking-head version). Skipped where a recipe already shows them throughout.', 'layout', 'video', array['speaker_video'], 'layout', '{"show": "face"}', true, true, 1);
  end if;
  return org;
end $$;

-- 2. formats: hook and CTA beats never over b-roll (linked copies too; the sync isn't involved)
update public.formats f
set beat_display = f.beat_display
  || case when f.beat_display ->> 'hook' = 'broll' then '{"hook": "face"}'::jsonb else '{}'::jsonb end
  || case when f.beat_display ->> 'cta' = 'broll' then '{"cta": "face"}'::jsonb else '{}'::jsonb end
where f.kind = 'standalone'
  and (f.beat_display ->> 'hook' = 'broll' or f.beat_display ->> 'cta' = 'broll');

alter table public.formats add constraint formats_hook_cta_not_broll
  check (kind <> 'standalone' or (coalesce(beat_display ->> 'hook', '') <> 'broll' and coalesce(beat_display ->> 'cta', '') <> 'broll'));
comment on column public.formats.beat_display is 'beat -> "face" (the speaker on camera), "broll" (their voice over b-roll), "screen" or "voice_note". Missing = broll, except a standalone format''s hook and cta beats (face), which are never broll.';
