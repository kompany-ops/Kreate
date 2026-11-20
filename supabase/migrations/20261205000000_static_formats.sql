-- Static ads, part 1 (docs/spec-statics.md §2): the Library's static formats. A static format is a
-- reusable, brand-agnostic structure for a static ad (Notes app, Offer-first banner…): its copy
-- slots, the variants it can be made in, its always / never rules, and example ads (references)
-- in the private static-references bucket at <org id>/<format id>/<file>. Kanvas makes the ads;
-- Kreate decides which get made.

create table public.static_formats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  mechanism text,
  slots jsonb not null default '[]',
  variants text[] not null default '{text}',
  rules jsonb not null default '{"always": [], "never": []}',
  reference_images jsonb not null default '[]',
  plate boolean not null default false,
  text_render text not null default 'ai',
  sizes text[] not null default '{4x5,1x1,9x16}',
  tags text[] not null default '{}',
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint static_formats_org_code_key unique (org_id, code),
  constraint static_formats_org_id_id_key unique (org_id, id),
  constraint static_formats_code_check check (code ~ '^SF[0-9]{2,}$'),
  constraint static_formats_name_check check (length(trim(name)) > 0),
  constraint static_formats_slots_check check (jsonb_typeof(slots) = 'array'),
  constraint static_formats_variants_check check (
    cardinality(variants) > 0 and variants <@ array['text', 'text_product', 'text_avatar', 'text_product_avatar']),
  constraint static_formats_rules_check check (
    jsonb_typeof(rules) = 'object' and jsonb_typeof(coalesce(rules -> 'always', '[]')) = 'array' and jsonb_typeof(coalesce(rules -> 'never', '[]')) = 'array'),
  constraint static_formats_references_check check (jsonb_typeof(reference_images) = 'array'),
  constraint static_formats_text_render_check check (text_render in ('ai', 'overlay')),
  constraint static_formats_sizes_check check (cardinality(sizes) > 0 and sizes <@ array['4x5', '1x1', '9x16'])
);
comment on table public.static_formats is 'Static ad formats (Library → Statics): brand-agnostic structures for static ads, made by Kanvas. docs/spec-statics.md §2.';
comment on column public.static_formats.slots is '[{key, label, max_words, guidance, example, required}], in order; keys are lowercase snake case, unique in the format.';
comment on column public.static_formats.variants is 'Which of text, text_product, text_avatar, text_product_avatar the format can be made in.';
comment on column public.static_formats.reference_images is '[{path, source_url}]: example ads in the static-references bucket (<org id>/<format id>/<file>), in order.';
comment on column public.static_formats.plate is 'Kanvas works from a blank plate of the reference.';
comment on column public.static_formats.text_render is 'ai: the image model writes the copy; overlay: Kanvas sets it in type over the image.';

-- slot keys: lowercase snake case, unique within the format
create or replace function private.check_static_slots() returns trigger
language plpgsql set search_path = '' as $$
declare
  keys text[];
begin
  select array_agg(slot ->> 'key') into keys from jsonb_array_elements(new.slots) slot;
  if exists (select 1 from unnest(coalesce(keys, '{}')) k where k is null or k !~ '^[a-z][a-z0-9_]*$') then
    raise exception 'Each slot needs a key in lowercase snake case (headline, sub_head…)';
  end if;
  if cardinality(coalesce(keys, '{}')) <> (select count(distinct k) from unnest(coalesce(keys, '{}')) k) then
    raise exception 'Two slots have the same key';
  end if;
  return new;
end $$;

create trigger check_slots before insert or update of slots on public.static_formats
  for each row execute function private.check_static_slots();
create trigger set_updated_at before update on public.static_formats
  for each row execute function private.set_updated_at();
create trigger stamp_creator before insert or update on public.static_formats
  for each row execute function private.stamp_creator();

alter table public.static_formats enable row level security;
create policy "org members can read" on public.static_formats for select to authenticated
  using (org_id = (select private.current_org_id()) and (select not private.is_guest()));
create policy "the team can insert" on public.static_formats for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can update" on public.static_formats for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
grant select, insert, update on public.static_formats to authenticated;

-- the example ads: private (Kanvas gets signed links through the manifest), by account
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('static-references', 'static-references', false, 20971520,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do nothing;

create policy "members read their static references" on storage.objects for select to authenticated
  using (bucket_id = 'static-references' and ((storage.foldername(name))[1])::uuid = (select private.current_org_id()) and (select not private.is_guest()));
create policy "the team adds static references" on storage.objects for insert to authenticated
  with check (bucket_id = 'static-references' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));
create policy "the team replaces static references" on storage.objects for update to authenticated
  using (bucket_id = 'static-references' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));
create policy "the team removes static references" on storage.objects for delete to authenticated
  using (bucket_id = 'static-references' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));

-- The static formats a shoot uses (§4), like shoot_formats: added and taken off while it's a draft.
create table public.shoot_static_formats (
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  shoot_id uuid not null,
  static_format_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (shoot_id, static_format_id),
  foreign key (org_id, shoot_id) references public.shoots(org_id, id) on delete cascade,
  foreign key (org_id, static_format_id) references public.static_formats(org_id, id) on delete restrict
);
create index shoot_static_formats_format_idx on public.shoot_static_formats (static_format_id);
comment on table public.shoot_static_formats is 'Static formats added to a shoot; its static copy is written for these (docs/spec-statics.md §4).';

alter table public.shoot_static_formats enable row level security;
create policy "org members can read" on public.shoot_static_formats for select to authenticated
  using (org_id = (select private.current_org_id()) and ((select not private.is_guest()) or private.guest_sees_shoot(shoot_id)));
create policy "the team can add to draft shoots" on public.shoot_static_formats for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())) and private.shoot_is_draft(shoot_id));
create policy "the team can delete from draft shoots" on public.shoot_static_formats for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())) and private.shoot_is_draft(shoot_id));
grant select, insert, delete on public.shoot_static_formats to authenticated;
