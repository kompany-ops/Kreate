-- Seats: a brand pays a seat for a partnered Free creator; that creator's shoots for the brand skip
-- the shoots-a-month limit (and still count), their own brand's don't; Klip comes with the seat;
-- without a live subscription, or once ended, the seat does nothing.
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
  invite uuid;
  linked uuid;
  linked_product uuid;
  own_product uuid;
  a uuid;
  b uuid;
  c uuid;
  seat uuid;
  be_brand text := json_build_object('sub', brand_user, 'role', 'authenticated')::text;
  be_creator text := json_build_object('sub', creator_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    (brand_user, 'seat-brand@example.com', 'authenticated', 'authenticated', now()),
    (creator_user, 'seat-creator@example.com', 'authenticated', 'authenticated', now());
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', be_brand, true);
  brand_org := public.create_org('Seat Co', 'seat-co', '{}', 'brand');
  select id into the_brand from public.brands where org_id = brand_org;
  insert into public.products (brand_id, name, slug) values (the_brand, 'Seat Chews', 'seat-chews');
  invite := public.invite_partner(the_brand, 'seat-creator@example.com');

  -- a Free creator: one shoot a month
  perform set_config('request.jwt.claims', be_creator, true);
  creator_org := public.create_org('Seat Creator', 'seat-creator');
  linked := public.accept_partnership(invite, creator_org, '{}');
  select id into linked_product from public.products where brand_id = linked;
  insert into public.brands (name, slug) values ('Own', 'own');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where org_id = creator_org and slug = 'own'), 'Own Thing', 'own-thing') returning id into own_product;
  insert into public.shoots (product_id) values (linked_product) returning id into a;
  insert into public.shoots (product_id) values (linked_product) returning id into b;
  insert into public.shoots (product_id) values (own_product) returning id into c;

  -- the server records a seat, pending until the brand's subscription is live
  perform set_config('role', 'postgres', true);
  insert into public.seats (publisher_org_id, creator_org_id, publisher_name, creator_name)
  values (brand_org, creator_org, 'Seat Co', 'Seat Creator') returning id into seat;
  perform set_config('role', 'authenticated', true);
  if (select klip_access from public.my_orgs() where id = creator_org) <> 'none' then raise exception 'FAILED: a pending seat gave Klip'; end if;

  -- planning: the first shoot fits Free; the second, for the brand, doesn't yet
  update public.shoots set status = 'planned' where id = a;
  begin
    update public.shoots set status = 'planned' where id = b;
    raise exception 'FAILED: a second shoot fitted Free without a seat';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- the brand's subscription goes live and the seat with it
  perform set_config('role', 'postgres', true);
  insert into public.org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, seats)
  values (brand_org, 'cus_seat_test', 'sub_seat_test', 'active', 1);
  update public.seats set status = 'active' where id = seat;
  perform set_config('role', 'authenticated', true);

  if (select klip_access from public.my_orgs() where id = creator_org) <> 'seat' then raise exception 'FAILED: the seat didn''t give Klip'; end if;
  if (select count(*) from public.seats) <> 1 then raise exception 'FAILED: the creator can''t see their seat'; end if;
  update public.shoots set status = 'planned' where id = b;
  if (select shoots_used from public.my_plan()) <> 2 then raise exception 'FAILED: a covered shoot didn''t count'; end if;
  -- their own brand's shoot is still over the limit
  begin
    update public.shoots set status = 'planned' where id = c;
    raise exception 'FAILED: the seat lifted the limit on the creator''s own brand';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- the brand's subscription lapses: the seat stops working, nothing is removed
  perform set_config('role', 'postgres', true);
  update public.org_subscriptions set status = 'canceled' where org_id = brand_org;
  perform set_config('role', 'authenticated', true);
  if (select klip_access from public.my_orgs() where id = creator_org) <> 'none' then raise exception 'FAILED: a lapsed seat still gave Klip'; end if;
  if (select status from public.shoots where id = b) <> 'planned' then raise exception 'FAILED: a covered shoot was undone'; end if;

  -- nobody writes seats but the server
  begin
    insert into public.seats (publisher_org_id, creator_org_id, publisher_name, creator_name) values (brand_org, creator_org, 'x', 'y');
    raise exception 'FAILED: someone wrote a seat';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);
end $$;

select 'seats: all checks passed' as result;
rollback;
