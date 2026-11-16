-- Account kinds: a brand account starts with its one brand, can't add another or plan shoots, has
-- no plan limits, and every Library item it writes is its brand's; creator accounts are unchanged.
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
  a_product uuid;
  hook uuid;
  be_brand text := json_build_object('sub', brand_user, 'role', 'authenticated')::text;
  be_creator text := json_build_object('sub', creator_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (brand_user, 'brand-kind@example.com', 'authenticated', 'authenticated'),
    (creator_user, 'creator-kind@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);

  -- a brand account, with its one brand
  perform set_config('request.jwt.claims', be_brand, true);
  brand_org := public.create_org('Calm Co', 'calm-co', '{"about": "calming chews for anxious dogs"}', 'brand');
  if (select kind from public.my_orgs() where id = brand_org) <> 'brand' then raise exception 'FAILED: not a brand account'; end if;
  select id into the_brand from public.brands where org_id = brand_org;
  if the_brand is null then raise exception 'FAILED: the brand account has no brand'; end if;
  if (select about from public.brands where id = the_brand) <> 'calming chews for anxious dogs' then raise exception 'FAILED: the brand''s about wasn''t kept'; end if;

  -- its profile, products and Library
  update public.brands set guidelines = 'Never say cure', library_rule = 'brand_only', website_url = 'https://calm.example' where id = the_brand;
  insert into public.products (brand_id, name, slug) values (the_brand, 'Calm Chews', 'calm-chews') returning id into a_product;
  insert into public.hook_templates (script) values ('My dog used to shake at the vet') returning id into hook;
  if (select brand_id from public.hook_templates where id = hook) is distinct from the_brand then raise exception 'FAILED: a brand account''s hook isn''t its brand''s'; end if;

  -- one brand only, and no shoots
  begin
    insert into public.brands (name, slug) values ('Second', 'second');
    raise exception 'FAILED: a brand account added a second brand';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    insert into public.shoots (product_id) values (a_product);
    raise exception 'FAILED: a brand account planned a shoot';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- a creator account is as before: its hooks are general unless scoped
  perform set_config('request.jwt.claims', be_creator, true);
  creator_org := public.create_org('Creator Kind', 'creator-kind');
  if (select kind from public.my_orgs() where id = creator_org) <> 'creator' then raise exception 'FAILED: not a creator account'; end if;
  insert into public.hook_templates (script) values ('General hook') returning id into hook;
  if (select brand_id from public.hook_templates where id = hook) is not null then raise exception 'FAILED: a creator''s hook got a brand'; end if;
  -- and it can't see the brand account's brand
  if exists (select 1 from public.brands where id = the_brand) then raise exception 'FAILED: a creator sees another account''s brand'; end if;

  perform set_config('role', 'postgres', true);
end $$;

select 'account kinds: all checks passed' as result;
rollback;
