-- A shoot can't end until its organisation has Dropbox connected. Ending opens the upload, and
-- clips only ever go to Dropbox (the old "test mode", which pretended to upload and let the clips
-- go from the phone, is gone). Until then the clips wait on each phone.
create or replace function private.require_dropbox_to_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'filmed' and old.status = 'shooting'
     and not exists (select 1 from public.dropbox_connection d where d.org_id = new.org_id) then
    raise exception 'Connect Dropbox (Settings → Dropbox) before ending the shoot: clips upload to it once the shoot ends.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.require_dropbox_to_end() from public, anon, authenticated;

create trigger require_dropbox_to_end
  before update of status on public.shoots
  for each row execute function private.require_dropbox_to_end();
