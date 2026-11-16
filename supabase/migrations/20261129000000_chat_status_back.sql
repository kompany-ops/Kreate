-- Every shoot status change goes to the account's chat: moving forward as before (planned,
-- being filmed, filmed, in editing, Live) and now moving back too ("S008 is back to draft"),
-- under its own kind, shoot_back (Settings → Defaults → "A shoot moves back"; on unless turned off).

comment on column public.settings.chat_events is 'Which of Kreate''s updates go to the chat, by kind (shoot_planned, shoot_shooting, shoot_filmed, shoot_editing, shoot_live, shoot_back, member_joined, ai_drafts); missing means on.';

create or replace function private.chat_shoot_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  steps constant text[] := array['draft', 'planned', 'shooting', 'filmed', 'editing', 'edited'];
  back boolean;
  what text;
  label text;
begin
  if new.status is not distinct from old.status then return new; end if;
  back := coalesce(array_position(steps, new.status), 0) < coalesce(array_position(steps, old.status), 0);
  label := case
    when back then case new.status
      when 'draft' then 'is back to draft'
      when 'planned' then 'is back to planned'
      when 'shooting' then 'is back to filming'
      when 'filmed' then 'is back to filmed'
      when 'editing' then 'is back in editing'
    end
    else case new.status
      when 'planned' then 'is planned'
      when 'shooting' then 'is being filmed'
      when 'filmed' then 'is filmed'
      when 'editing' then 'is in editing'
      when 'edited' then 'is Live'
    end
  end;
  if label is null then return new; end if;
  select case when lower(b.name) = lower(p.name) then b.name else concat_ws(' · ', b.name, p.name) end into what
  from public.products p join public.brands b on b.id = p.brand_id
  where p.id = new.product_id;
  perform private.post_org_event(
    new.org_id,
    case when back then 'shoot_back' else 'shoot_' || case new.status when 'edited' then 'live' else new.status end end,
    concat(new.code, ' ', label, case when what is not null then ' (' || what || ')' end, '.'),
    jsonb_build_object('shoot_code', new.code, 'shoot_id', new.id, 'status', new.status, 'from', old.status)
  );
  return new;
end $$;
