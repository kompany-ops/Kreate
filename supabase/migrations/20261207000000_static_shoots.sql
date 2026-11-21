-- Static ads, part 3 (docs/spec-statics.md §4, §5): a shoot's static copy, its static settings, and
-- the stills filmed on set for product and avatar variants.

-- 1. Shoot setup: wording mixes for static copy, and the share of static recipes each static batch
--    submits (from Settings, as submission_rate).
alter table public.shoots
  add column static_wording_variations integer not null default 1,
  add column static_submission_rate numeric not null default 0.05,
  add constraint shoots_static_wording_variations_check check (static_wording_variations >= 0),
  add constraint shoots_static_submission_rate_check check (static_submission_rate >= 0 and static_submission_rate <= 1);
comment on column public.shoots.static_wording_variations is 'Extra static recipes per copy from combining its slots'' other wordings (0 = first wordings only).';
comment on column public.shoots.static_submission_rate is 'The share of valid static recipes each static batch (SB##) submits.';
alter table public.settings add column default_static_submission_rate numeric not null default 0.05,
  add constraint settings_default_static_submission_rate_check check (default_static_submission_rate >= 0 and default_static_submission_rate <= 1);

-- 2. Static copy: written in a shoot for its product, one or more per static format on the shoot
--    (like VOs). Codes A01, A02… per shoot. Changed while the shoot is a draft; frozen once planned.
create table public.static_copies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  shoot_id uuid not null,
  static_format_id uuid not null,
  product_id uuid not null,
  feature_id uuid,
  person_id uuid,
  cast_channel_id uuid,
  code text not null,
  slots jsonb not null default '[]',
  tags text[] not null default '{}',
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint static_copies_shoot_code_key unique (shoot_id, code),
  constraint static_copies_code_check check (code ~ '^A[0-9]{2,}$'),
  constraint static_copies_slots_check check (jsonb_typeof(slots) = 'array'),
  foreign key (org_id, shoot_id) references public.shoots(org_id, id) on delete cascade,
  -- the format must be on the shoot: taking it off takes its copy with it
  foreign key (shoot_id, static_format_id) references public.shoot_static_formats(shoot_id, static_format_id) on delete cascade,
  foreign key (org_id, product_id) references public.products(org_id, id) on delete restrict,
  foreign key (org_id, feature_id) references public.product_features(org_id, id) on delete set null (feature_id),
  foreign key (org_id, person_id) references public.people(org_id, id) on delete set null (person_id),
  foreign key (org_id, cast_channel_id) references public.channels(org_id, id) on delete set null (cast_channel_id)
);
create index static_copies_shoot_idx on public.static_copies (shoot_id);
comment on table public.static_copies is 'Static ad copy written in a shoot for its product, per static format (docs/spec-statics.md §4).';
comment on column public.static_copies.slots is '[{slot, text, alternates: [{text}]}]: the format''s slot keys; alternates are other wordings, mixed like a VO''s.';
comment on column public.static_copies.person_id is 'Who wrote it.';
comment on column public.static_copies.cast_channel_id is 'Who it''s for, as VOs: null for every channel on the shoot.';

create or replace function private.guard_static_copy() returns trigger
language plpgsql set search_path = '' as $$
declare
  shoot uuid := coalesce(new.shoot_id, old.shoot_id);
begin
  -- (a shoot being deleted takes its copy with it)
  if exists (select 1 from public.shoots s where s.id = shoot and s.status <> 'draft') then
    raise exception 'The shoot is planned: its static copy is frozen';
  end if;
  return coalesce(new, old);
end $$;
create trigger guard_static_copy before insert or update or delete on public.static_copies
  for each row execute function private.guard_static_copy();
create trigger set_updated_at before update on public.static_copies
  for each row execute function private.set_updated_at();
create trigger stamp_creator before insert or update on public.static_copies
  for each row execute function private.stamp_creator();

alter table public.static_copies enable row level security;
create policy "org members can read" on public.static_copies for select to authenticated
  using (org_id = (select private.current_org_id()) and ((select not private.is_guest()) or private.guest_sees_shoot(shoot_id)));
create policy "the team, or its writer, can insert" on public.static_copies for insert to authenticated
  with check (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)));
create policy "the team, or its writer, can update" on public.static_copies for update to authenticated
  using (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)))
  with check (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)));
create policy "the team, or its writer, can delete" on public.static_copies for delete to authenticated
  using (org_id = (select private.current_org_id()) and ((select private.is_org_admin(private.current_org_id())) or private.is_me(person_id)));
grant select, insert, update, delete on public.static_copies to authenticated;

-- 3. Stills: photos filmed on set for product variants (per channel) and avatar variants (per
--    person), like b-roll. Cast tick them off by adding photos; only admins skip.
create table public.still_shots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  shoot_id uuid not null,
  kind text not null,
  description text not null default '',
  feature_id uuid,
  count integer not null default 3,
  status text not null default 'planned',
  photos_filmed integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint still_shots_kind_check check (kind in ('product', 'avatar')),
  constraint still_shots_status_check check (status in ('planned', 'filmed', 'skipped')),
  constraint still_shots_count_check check (count between 1 and 20),
  constraint still_shots_feature_check check (kind = 'product' or feature_id is null),
  foreign key (org_id, shoot_id) references public.shoots(org_id, id) on delete cascade,
  foreign key (org_id, feature_id) references public.product_features(org_id, id) on delete set null (feature_id)
);
create index still_shots_shoot_idx on public.still_shots (shoot_id);
comment on table public.still_shots is 'Photos to take on set for static ads: product stills per channel, avatar stills per person (docs/spec-statics.md §5).';
comment on column public.still_shots.count is 'Photos wanted per channel (product) or per person (avatar).';

-- cast only tick stills off (status and the photo count), and only once the shoot has started;
-- everything else is the team's
create or replace function private.guard_cast_still_edits() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.is_org_admin(new.org_id) then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'photos_filmed', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'photos_filmed', 'updated_at']) then
    raise exception 'Cast can only tick off stills';
  end if;
  if (new.status = 'filmed' or new.photos_filmed > old.photos_filmed)
    and (select s.status from public.shoots s where s.id = new.shoot_id) in ('draft', 'planned') then
    raise exception 'An admin has to start the shoot before filming';
  end if;
  return new;
end $$;
create trigger guard_cast_still_edits before update on public.still_shots
  for each row execute function private.guard_cast_still_edits();
create trigger guard_skip before update of status on public.still_shots
  for each row execute function private.guard_skip();
create trigger set_updated_at before update on public.still_shots
  for each row execute function private.set_updated_at();
create trigger stamp_creator before insert or update on public.still_shots
  for each row execute function private.stamp_creator();

alter table public.still_shots enable row level security;
create policy "org members can read" on public.still_shots for select to authenticated
  using (org_id = (select private.current_org_id()) and ((select not private.is_guest()) or private.guest_sees_shoot(shoot_id)));
create policy "the team can insert into draft shoots" on public.still_shots for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())) and private.shoot_is_draft(shoot_id));
create policy "the team, or cast filming, can update" on public.still_shots for update to authenticated
  using (org_id = (select private.current_org_id()))
  with check (org_id = (select private.current_org_id()));
create policy "the team can delete from draft shoots" on public.still_shots for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())) and private.shoot_is_draft(shoot_id));
grant select, insert, update, delete on public.still_shots to authenticated;

-- live on every phone, like the rest of the checklist
alter publication supabase_realtime add table public.still_shots;
