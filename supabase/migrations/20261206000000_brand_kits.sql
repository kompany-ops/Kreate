-- Static ads, part 2 (docs/spec-statics.md §3): a design kit per brand, for Kanvas. Colours,
-- fonts (by family, or an uploaded file for overlay formats), logos, style notes and rules applied
-- on top of every static format's. Files go in the private brand-kits bucket at
-- <org id>/<brand id>/<logos|fonts>/<file>; packshots live in the brand's Dropbox _kit/ folder,
-- whose path is kept here once the shoot folders are built. A brand with no kit still gets statics.

create table public.brand_kits (
  brand_id uuid primary key,
  org_id uuid not null default private.current_org_id() references public.orgs(id) on delete cascade,
  colors jsonb not null default '[]',
  fonts jsonb not null default '[]',
  logos jsonb not null default '[]',
  style_notes text,
  rules jsonb not null default '{"always": [], "never": []}',
  dropbox_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, brand_id) references public.brands(org_id, id) on delete cascade,
  constraint brand_kits_colors_check check (jsonb_typeof(colors) = 'array'),
  constraint brand_kits_fonts_check check (jsonb_typeof(fonts) = 'array'),
  constraint brand_kits_logos_check check (jsonb_typeof(logos) = 'array'),
  constraint brand_kits_rules_check check (
    jsonb_typeof(rules) = 'object' and jsonb_typeof(coalesce(rules -> 'always', '[]')) = 'array' and jsonb_typeof(coalesce(rules -> 'never', '[]')) = 'array')
);
comment on table public.brand_kits is 'A brand''s design kit for static ads (docs/spec-statics.md §3). One per brand.';
comment on column public.brand_kits.colors is '[{name, hex}]';
comment on column public.brand_kits.fonts is '[{role: headline | body, family, file}]: file is a path in the brand-kits bucket, or null to pass the family name to Kanvas.';
comment on column public.brand_kits.logos is '[{path, use: light | dark | mark}]: files in the brand-kits bucket.';
comment on column public.brand_kits.dropbox_path is 'The brand''s _kit/ folder in Dropbox (logo/, fonts/, packshots/), set when shoot folders are built.';

create trigger set_updated_at before update on public.brand_kits
  for each row execute function private.set_updated_at();

alter table public.brand_kits enable row level security;
create policy "org members can read" on public.brand_kits for select to authenticated
  using (org_id = (select private.current_org_id()) and (select not private.is_guest()));
create policy "the team can insert" on public.brand_kits for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can update" on public.brand_kits for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())))
  with check (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
create policy "the team can delete" on public.brand_kits for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_org_admin(private.current_org_id())));
grant select, insert, update, delete on public.brand_kits to authenticated;

-- logos and font files: private (Kanvas gets signed links through the manifest), by account
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-kits', 'brand-kits', false, 10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'font/ttf', 'font/otf', 'font/woff', 'font/woff2'])
on conflict (id) do nothing;

create policy "members read their brand kits" on storage.objects for select to authenticated
  using (bucket_id = 'brand-kits' and ((storage.foldername(name))[1])::uuid = (select private.current_org_id()) and (select not private.is_guest()));
create policy "the team adds brand kit files" on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-kits' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));
create policy "the team replaces brand kit files" on storage.objects for update to authenticated
  using (bucket_id = 'brand-kits' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));
create policy "the team removes brand kit files" on storage.objects for delete to authenticated
  using (bucket_id = 'brand-kits' and (select private.is_org_admin(((storage.foldername(name))[1])::uuid)));
