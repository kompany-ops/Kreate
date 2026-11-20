-- Only an admin (the team, the owner included) skips shots or unskips them, on the checklist or
-- anywhere else. Cast still tick their own shots off by adding clips (planned <-> filmed), and the
-- shoot's status was already the team's alone (private.guard_shoot_status).

create or replace function private.guard_skip() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.is_org_admin(new.org_id) then
    return new;
  end if;
  if (new.status = 'skipped') is distinct from (old.status = 'skipped') then
    raise exception 'Only an admin can skip a shot';
  end if;
  return new;
end $$;

create trigger guard_skip before update of status on public.shoot_items
  for each row execute function private.guard_skip();
create trigger guard_skip before update of status on public.broll_shots
  for each row execute function private.guard_skip();
