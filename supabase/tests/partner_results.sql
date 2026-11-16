-- Results for brands: the brand sees its partners' shoots for it and how its own hooks scored there,
-- and nothing of the creator's own Library or other brands; nobody else sees any of it.
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
  own_product uuid;
  own_hook uuid;
  person uuid;
  shoot uuid;
  other_shoot uuid;
  shortlist uuid;
  be_brand text := json_build_object('sub', brand_user, 'role', 'authenticated')::text;
  be_creator text := json_build_object('sub', creator_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    (brand_user, 'results-brand@example.com', 'authenticated', 'authenticated', now()),
    (creator_user, 'results-creator@example.com', 'authenticated', 'authenticated', now());
  perform set_config('role', 'authenticated', true);

  -- a brand with a product and a hook, partnered with a creator
  perform set_config('request.jwt.claims', be_brand, true);
  brand_org := public.create_org('Results Co', 'results-co', '{}', 'brand');
  select id into the_brand from public.brands where org_id = brand_org;
  insert into public.products (brand_id, name, slug) values (the_brand, 'Calm Chews', 'calm-chews') returning id into the_product;
  insert into public.hook_templates (script) values ('The brand''s hook') returning id into brand_hook;
  invite := public.invite_partner(the_brand, 'results-creator@example.com');

  perform set_config('request.jwt.claims', be_creator, true);
  creator_org := public.create_org('Results Creator', 'results-creator');
  insert into public.channels (name, slug, folder_slug) values ('One', 'one', 'one') returning id into channel;
  linked := public.accept_partnership(invite, creator_org, array[channel]);
  select id into linked_product from public.products where brand_id = linked;
  perform public.set_channel_members(channel, array[creator_user]);
  select id into person from public.people where org_id = creator_org and user_id = creator_user;
  insert into public.hook_templates (script) values ('The creator''s own hook') returning id into own_hook;

  -- a shoot for the brand, with its hook and one of the creator's own
  insert into public.shoots (product_id) values (linked_product) returning id into shoot;
  insert into public.shoot_channels (shoot_id, channel_id) values (shoot, channel);
  insert into public.shoot_people (shoot_id, person_id) values (shoot, person);
  insert into public.shoot_items (shoot_id, person_id, kind, hook_template_id, code, script_snapshot) values
    (shoot, person, 'hook', (select id from public.hook_templates where source_id = brand_hook), 'H01', '"The brand''s hook"'),
    (shoot, person, 'hook', own_hook, 'H02', '"The creator''s own hook"');
  -- and a shoot for a brand of the creator's own
  insert into public.brands (name, slug) values ('Own Brand', 'own-brand');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where org_id = creator_org and slug = 'own-brand'), 'Own Thing', 'own-thing') returning id into own_product;
  insert into public.shoots (product_id) values (own_product) returning id into other_shoot;

  -- a measured batch: the brand's hook won, the creator's lost
  perform set_config('role', 'postgres', true);
  insert into public.shoot_shortlists (org_id, shoot_id, code, size, entry_ids, status)
  values (creator_org, shoot, 'B01', 10, '{r1}', 'measured') returning id into shortlist;
  insert into public.batch_scores (org_id, shortlist_id, element_kind, element_key, score) values
    (creator_org, shortlist, 'hook', 'H01', 'winner'),
    (creator_org, shortlist, 'hook', 'H02', 'loser');
  perform set_config('role', 'authenticated', true);

  -- the brand sees its shoot (not the creator's own one) and its hook's win
  perform set_config('request.jwt.claims', be_brand, true);
  if (select count(*) from public.partner_shoots(the_brand)) <> 1 then raise exception 'FAILED: the brand doesn''t see just its own shoot'; end if;
  if (select shoot_id from public.partner_shoots(the_brand)) <> shoot then raise exception 'FAILED: the brand sees the wrong shoot'; end if;
  if (select creator_name from public.partner_shoots(the_brand)) <> 'Results Creator' then raise exception 'FAILED: the creator''s name isn''t shown'; end if;
  if (select channels from public.partner_shoots(the_brand)) <> array['One'] then raise exception 'FAILED: the channels aren''t shown'; end if;
  if (select batches from public.partner_shoots(the_brand)) <> 1 or (select batches_measured from public.partner_shoots(the_brand)) <> 1 or (select renders from public.partner_shoots(the_brand)) <> 10 then
    raise exception 'FAILED: the batch isn''t counted';
  end if;
  if (select shoots from public.partner_item_results(the_brand) where item_id = brand_hook) <> 1 then raise exception 'FAILED: the hook''s use isn''t counted'; end if;
  if (select winners from public.partner_item_results(the_brand) where item_id = brand_hook) <> 1 then raise exception 'FAILED: the hook''s win isn''t counted'; end if;
  if (select losers from public.partner_item_results(the_brand) where item_id = brand_hook) <> 0 then raise exception 'FAILED: the creator''s hook''s loss counted for the brand''s'; end if;
  if exists (select 1 from public.partner_item_results(the_brand) where item_id = own_hook or label like '%creator''s own%') then raise exception 'FAILED: the brand sees the creator''s own hook'; end if;

  -- nobody else gets anything, the creator included
  perform set_config('request.jwt.claims', be_creator, true);
  begin
    perform public.partner_shoots(the_brand);
    raise exception 'FAILED: the creator read the brand''s results';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    perform public.partner_item_results(linked);
    raise exception 'FAILED: results for a linked copy were given';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  perform set_config('role', 'postgres', true);
end $$;

select 'partner results: all checks passed' as result;
rollback;
