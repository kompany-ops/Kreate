-- Hooks and CTAs can have more than one wording on a shoot, as VO beats can: the first is the
-- line itself (script_snapshot, with each person's own override on top), and `alternates` holds
-- wordings 2, 3… for everyone on the shoot. Each wording is its own take (H01, H01-2…), so like
-- the codes they're frozen once the shoot leaves draft. Planning fills their slots in.

alter table public.shoot_items add column alternates text[] not null default '{}';
alter table public.shoot_items add constraint shoot_items_alternates_not_vo
  check (kind <> 'body' or cardinality(alternates) = 0);
comment on column public.shoot_items.alternates is
  'Hooks and CTAs: wordings 2, 3… of the line, for everyone on the shoot, each filmed as its own take (<code>-<n>). VOs keep theirs on each beat.';

-- Codes, and the wordings that make takes, are frozen once a shoot leaves draft.
create or replace function private.guard_shoot_item() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.code, new.kind, new.person_id, new.shoot_id) is distinct from (old.code, old.kind, old.person_id, old.shoot_id)
    or new.hook_template_id is distinct from old.hook_template_id
    or new.body_template_id is distinct from old.body_template_id
    or new.cta_template_id is distinct from old.cta_template_id
    or new.alternates is distinct from old.alternates
  then
    if (select s.status from public.shoots s where s.id = old.shoot_id) <> 'draft' then
      raise exception 'Shoot is no longer a draft: item codes and wordings are frozen';
    end if;
  end if;
  return new;
end $$;
