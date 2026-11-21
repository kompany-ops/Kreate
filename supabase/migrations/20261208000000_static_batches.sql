-- Static ads, part 4 (docs/spec-statics.md §7): static batches, batched apart from video in the same
-- loop so their scores never mix; reviewing Kanvas's renders before a static batch is submitted.

-- 1. A batch is video (B01…) or static (SB01…)
alter table public.shoot_shortlists add column medium text not null default 'video',
  add constraint shoot_shortlists_medium_check check (medium in ('video', 'static')),
  add constraint shoot_shortlists_code_check check ((medium = 'video' and code ~ '^B[0-9]{2,}$') or (medium = 'static' and code ~ '^SB[0-9]{2,}$'));
comment on column public.shoot_shortlists.medium is 'video (B##, recipes.json) or static (SB##, statics.json), each its own loop.';

-- 2. Static elements to score and drop: the static format, the variant, the copy (with its
--    wordings) and the avatar (the person in a person variant; video's "person" stays video's,
--    since hand-drops are per shoot, not per batch)
alter table public.batch_scores drop constraint batch_scores_element_kind_check,
  add constraint batch_scores_element_kind_check check (element_kind in (
    'hook', 'vo', 'cta', 'format', 'hook_type', 'treatment', 'person', 'static_format', 'variant', 'static_copy', 'avatar'));
alter table public.shoot_element_overrides drop constraint shoot_element_overrides_element_kind_check,
  add constraint shoot_element_overrides_element_kind_check check (element_kind in (
    'hook', 'vo', 'cta', 'format', 'hook_type', 'treatment', 'person', 'static_format', 'variant', 'static_copy', 'avatar'));

-- 3. Undo and reset per medium: only the latest batch of its medium, since each was picked from
--    the scores before it. The one-argument forms stay video's, as the app has called them.
drop function public.undo_batch(uuid);
create function public.undo_batch(p_shoot_id uuid, p_medium text default 'video') returns text
language plpgsql security definer set search_path = '' as $$
declare
  shoot_org uuid;
  latest_id uuid;
  latest_code text;
begin
  select s.org_id into shoot_org from public.shoots s where s.id = p_shoot_id;
  if shoot_org is null or not private.is_org_admin(shoot_org) then
    raise exception 'Only the account''s owner or team can undo a batch';
  end if;
  select sl.id, sl.code into latest_id, latest_code
  from public.shoot_shortlists sl
  where sl.shoot_id = p_shoot_id and sl.medium = p_medium
  order by sl.created_at desc, sl.code desc
  limit 1;
  if latest_id is null then
    raise exception 'This shoot has no % batches', p_medium;
  end if;
  delete from public.shoot_shortlists where id = latest_id;
  return latest_code;
end $$;
comment on function public.undo_batch(uuid, text) is 'Deletes the shoot''s latest batch of a medium (video or static) and its scores; returns its code.';

drop function public.reset_batches(uuid);
create function public.reset_batches(p_shoot_id uuid, p_medium text default 'video') returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  shoot_org uuid;
  codes text[];
begin
  select s.org_id into shoot_org from public.shoots s where s.id = p_shoot_id;
  if shoot_org is null or not private.is_org_admin(shoot_org) then
    raise exception 'Only the account''s owner or team can reset batches';
  end if;
  with gone as (
    delete from public.shoot_shortlists where shoot_id = p_shoot_id and medium = p_medium returning code
  )
  select coalesce(array_agg(code order by code), '{}') into codes from gone;
  return codes;
end $$;
comment on function public.reset_batches(uuid, text) is 'Deletes every batch of a medium (video or static) on the shoot and their scores; returns their codes.';

revoke all on function public.undo_batch(uuid, text), public.reset_batches(uuid, text) from public, anon;
grant execute on function public.undo_batch(uuid, text), public.reset_batches(uuid, text) to authenticated, service_role;

-- 4. Reviewing a static batch's renders (§7): an ad whose product Kanvas drew has to be approved or
--    rejected before the batch is submitted; a rejected one is left out of the submission.
create table public.static_render_reviews (
  shortlist_id uuid not null,
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  recipe_id text not null,
  decision text not null,
  decided_by uuid default auth.uid(),
  decided_at timestamptz not null default now(),
  primary key (shortlist_id, recipe_id),
  foreign key (org_id, shortlist_id) references public.shoot_shortlists(org_id, id) on delete cascade,
  constraint static_render_reviews_decision_check check (decision in ('approved', 'rejected'))
);
comment on table public.static_render_reviews is 'Approvals of a static batch''s renders, e.g. one whose product Kanvas drew (docs/spec-statics.md §7).';

alter table public.static_render_reviews enable row level security;
create policy "org members can read" on public.static_render_reviews for select to authenticated
  using (org_id = (select private.current_org_id()) and (select not private.is_guest()));
create policy "the team can insert" on public.static_render_reviews for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can update" on public.static_render_reviews for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can delete" on public.static_render_reviews for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
grant select, insert, update, delete on public.static_render_reviews to authenticated;
