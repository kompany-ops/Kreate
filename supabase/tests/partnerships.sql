-- Partnerships: a brand invites a creator by email; accepting links the brand's profile, products,
-- features and Library into the creator's account as read-only copies, kept in sync; the creator's
-- deal and channels are theirs; partner brands don't count as their own; a brand_only brand's
-- shoots take only its hooks; ending archives the copy and leaves the shoots.
-- Raises on the first failure, and rolls everything back either way.
-- Run it in the Supabase SQL editor, or with psql against the project.

begin;

do $$
declare
  brand_user uuid := gen_random_uuid();
  creator_user uuid := gen_random_uuid();
  brand_org uuid;
  creator_org uuid;
  the_brand uuid;
  the_product uuid;
  brand_hook uuid;
  channel uuid;
  invite uuid;
  linked uuid;
  linked_product uuid;
  linked_hook uuid;
  own_hook uuid;
  person uuid;
  shoot uuid;
  n bigint;
  be_brand text := json_build_object('sub', brand_user, 'role', 'authenticated')::text;
  be_creator text := json_build_object('sub', creator_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    (brand_user, 'partner-brand@example.com', 'authenticated', 'authenticated', now()),
    (creator_user, 'partner-creator@example.com', 'authenticated', 'authenticated', now());
  perform set_config('role', 'authenticated', true);

  -- the brand: a product with a feature, a hook, a CTA for the product, a format
  perform set_config('request.jwt.claims', be_brand, true);
  brand_org := public.create_org('Calm Co', 'calm-co', '{}', 'brand');
  select id into the_brand from public.brands where org_id = brand_org;
  update public.brands set about = 'Calming chews', guidelines = 'Never say cure' where id = the_brand;
  insert into public.products (brand_id, name, slug) values (the_brand, 'Calm Chews', 'calm-chews') returning id into the_product;
  insert into public.product_features (product_id, name) values (the_product, 'Works in 20 minutes');
  insert into public.hook_templates (script) values ('My dog used to shake at the vet') returning id into brand_hook;
  insert into public.cta_templates (script, mode, product_id) values ('Grab Calm Chews', 'sync', the_product);
  insert into public.formats (code, name) values ('F01', 'Before and after');

  -- the creator: a channel, their own F01 and a hook of their own
  perform set_config('request.jwt.claims', be_creator, true);
  creator_org := public.create_org('Creator Partner', 'creator-partner');
  insert into public.channels (name, slug, folder_slug) values ('One', 'one', 'one') returning id into channel;
  insert into public.formats (code, name) values ('F01', 'My own format');
  insert into public.hook_templates (script) values ('My own hook') returning id into own_hook;

  -- only the brand invites; the creator sees it waiting for their email
  begin
    perform public.invite_partner(the_brand, 'partner-creator@example.com');
    raise exception 'FAILED: a creator invited for someone else''s brand';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  perform set_config('request.jwt.claims', be_brand, true);
  invite := public.invite_partner(the_brand, 'Partner-Creator@example.com');
  perform set_config('request.jwt.claims', be_creator, true);
  if (select count(*) from public.my_partner_invites()) <> 1 then raise exception 'FAILED: the creator doesn''t see the invitation'; end if;

  -- accepting links the brand in, on the channel chosen
  linked := public.accept_partnership(invite, creator_org, array[channel]);
  if (select source_brand_id from public.brands where id = linked) <> the_brand then raise exception 'FAILED: the copy isn''t linked'; end if;
  if (select about from public.brands where id = linked) <> 'Calming chews' then raise exception 'FAILED: the profile wasn''t copied'; end if;
  if (select array_agg(channel_id) from public.brand_channels where brand_id = linked) <> array[channel] then raise exception 'FAILED: not on the channel chosen'; end if;
  select id into linked_product from public.products where brand_id = linked;
  if linked_product is null then raise exception 'FAILED: the product wasn''t copied'; end if;
  if (select count(*) from public.product_features where product_id = linked_product) <> 1 then raise exception 'FAILED: the feature wasn''t copied'; end if;
  select id into linked_hook from public.hook_templates where source_id = brand_hook;
  if (select brand_id from public.hook_templates where id = linked_hook) <> linked then raise exception 'FAILED: the hook isn''t for the linked brand'; end if;
  if (select product_id from public.cta_templates where source_id is not null) <> linked_product then raise exception 'FAILED: the CTA isn''t for the linked product'; end if;
  if (select code from public.formats where source_id is not null) <> 'F01-CALM-CO' then raise exception 'FAILED: the format code clashed'; end if;
  if (select status from public.partnerships where id = invite) <> 'active' then raise exception 'FAILED: the partnership isn''t active'; end if;

  -- a partner brand isn't one of the creator's own
  if (select brands_used from public.my_plan()) <> 0 then raise exception 'FAILED: a partner brand counted as one of the creator''s own'; end if;

  -- the brand's edits flow through
  perform set_config('request.jwt.claims', be_brand, true);
  update public.products set name = 'Calm Chews Plus' where id = the_product;
  update public.hook_templates set script = 'My dog used to shake at the vet. Not any more.' where id = brand_hook;
  insert into public.product_features (product_id, name) values (the_product, 'Vet approved');
  perform set_config('request.jwt.claims', be_creator, true);
  if (select name from public.products where id = linked_product) <> 'Calm Chews Plus' then raise exception 'FAILED: a product edit didn''t sync'; end if;
  if (select script from public.hook_templates where id = linked_hook) <> 'My dog used to shake at the vet. Not any more.' then raise exception 'FAILED: a hook edit didn''t sync'; end if;
  if (select count(*) from public.product_features where product_id = linked_product) <> 2 then raise exception 'FAILED: a new feature didn''t sync'; end if;

  -- the copies are read-only; the deal is the creator's
  begin
    update public.products set name = 'Renamed' where id = linked_product;
    raise exception 'FAILED: the creator renamed a partner''s product';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.brands set about = 'Changed' where id = linked;
    raise exception 'FAILED: the creator changed a partner''s profile';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    insert into public.products (brand_id, name, slug) values (linked, 'Sneaky', 'sneaky');
    raise exception 'FAILED: the creator added a product to a partner''s brand';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  update public.brands set status = 'piloting', notes = 'Great so far', starred = true, pay_types = array['flat'], flat_fee = 50 where id = linked;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: the creator couldn''t keep their deal'; end if;

  -- brand_only: the brand's shoots take only its hooks
  perform set_config('request.jwt.claims', be_brand, true);
  update public.brands set library_rule = 'brand_only' where id = the_brand;
  perform set_config('request.jwt.claims', be_creator, true);
  if (select library_rule from public.brands where id = linked) <> 'brand_only' then raise exception 'FAILED: the library rule didn''t sync'; end if;
  perform public.set_channel_members(channel, array[creator_user]);
  select id into person from public.people where org_id = creator_org and user_id = creator_user;
  insert into public.shoots (product_id) values (linked_product) returning id into shoot;
  insert into public.shoot_people (shoot_id, person_id) values (shoot, person);
  begin
    insert into public.shoot_items (shoot_id, person_id, kind, hook_template_id, code, script_snapshot)
    values (shoot, person, 'hook', own_hook, 'H01', '"My own hook"');
    raise exception 'FAILED: the creator''s own hook went on a brand_only shoot';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  insert into public.shoot_items (shoot_id, person_id, kind, hook_template_id, code, script_snapshot)
  values (shoot, person, 'hook', linked_hook, 'H01', '"the brand''s hook"');

  -- nobody outside sees the partnership
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  if exists (select 1 from public.partnerships where id = invite) then raise exception 'FAILED: an outsider sees the partnership'; end if;

  -- ending it archives the copy; the shoot stays
  perform set_config('request.jwt.claims', be_brand, true);
  perform public.end_partnership(invite);
  perform set_config('request.jwt.claims', be_creator, true);
  if (select archived_at from public.brands where id = linked) is null then raise exception 'FAILED: the copy wasn''t archived'; end if;
  if not exists (select 1 from public.shoots where id = shoot) then raise exception 'FAILED: the shoot went with the partnership'; end if;

  perform set_config('role', 'postgres', true);
end $$;

select 'partnerships: all checks passed' as result;
rollback;
