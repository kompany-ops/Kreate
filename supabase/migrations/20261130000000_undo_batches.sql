-- Batches can be taken back (spec §14b): the owner or team can undo a shoot's latest batch, or
-- reset all of them. Its scores go with it (batch_scores cascades), so its recipes can be batched
-- again and the next batch reuses its code. The app removes its files from Dropbox.
-- Only the latest at a time: every batch was picked using the scores of the ones before it.
-- A Live shoot can go back to editing, but only once it has no batches: they name recipes by id,
-- and going Live again rebuilds the recipes.

create function public.undo_batch(p_shoot_id uuid) returns text
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
  where sl.shoot_id = p_shoot_id
  order by sl.created_at desc, sl.code desc
  limit 1;
  if latest_id is null then
    raise exception 'This shoot has no batches';
  end if;
  delete from public.shoot_shortlists where id = latest_id;
  return latest_code;
end $$;
comment on function public.undo_batch(uuid) is 'Deletes the shoot''s latest batch and its scores; returns its code.';

create function public.reset_batches(p_shoot_id uuid) returns text[]
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
    delete from public.shoot_shortlists where shoot_id = p_shoot_id returning code
  )
  select coalesce(array_agg(code order by code), '{}') into codes from gone;
  return codes;
end $$;
comment on function public.reset_batches(uuid) is 'Deletes every batch on the shoot and their scores; returns their codes.';

revoke all on function public.undo_batch(uuid), public.reset_batches(uuid) from public, anon;
grant execute on function public.undo_batch(uuid), public.reset_batches(uuid) to authenticated, service_role;

-- Leaving Live needs the batches gone first.
create function private.guard_leave_live() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'edited' and new.status is distinct from 'edited'
    and exists (select 1 from public.shoot_shortlists sl where sl.shoot_id = new.id) then
    raise exception 'This shoot has batches: reset them before taking it back to editing';
  end if;
  return new;
end $$;
create trigger guard_leave_live before update of status on public.shoots
  for each row execute function private.guard_leave_live();

revoke all on function private.guard_leave_live() from public, anon;
grant execute on function private.guard_leave_live() to authenticated, service_role;
