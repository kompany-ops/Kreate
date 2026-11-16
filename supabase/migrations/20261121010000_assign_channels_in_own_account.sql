-- A new brand starts on its own account's active channels only. The trigger didn't say whose
-- channels: under row level security that was the user's account anyway, but when a brand is made
-- by a security definer function (create_org, for a brand account) it saw every account's channels
-- and failed on the same-account foreign key. It now names the brand's account throughout.
create or replace function private.assign_all_channels() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.brand_channels (org_id, brand_id, channel_id)
  select new.org_id, new.id, c.id from public.channels c where c.org_id = new.org_id and c.active
  on conflict do nothing;
  return new;
end $$;
