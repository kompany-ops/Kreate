-- Static batches: coded SB##, apart from video's B##; undo and reset each medium on its own;
-- static elements can be scored; renders are reviewed by the team. Raises on the first failure,
-- and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  cast_user uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  video uuid;
  sb1 uuid;
  code text;
  codes text[];
  n bigint;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_cast text := json_build_object('sub', cast_user, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'static-batches@example.com', 'authenticated', 'authenticated'),
    (cast_user, 'static-batches-cast@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Static Batches', 'static-batches');
  perform set_config('role', 'postgres', true);
  insert into public.org_members (org_id, user_id, role) values (mine, cast_user, 'cast');
  update public.profiles set active_org_id = mine where id = cast_user;
  perform set_config('role', 'authenticated', true);

  insert into public.brands (name, slug) values ('Brand', 'brand-static-batches');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-static-batches' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into shoot;

  -- video and static batches side by side, each with its own codes
  insert into public.shoot_shortlists (shoot_id, code, size, entry_ids) values (shoot, 'B01', 1, '{v1}') returning id into video;
  insert into public.shoot_shortlists (shoot_id, code, size, entry_ids, medium) values (shoot, 'SB01', 2, '{s1,s2}', 'static') returning id into sb1;
  insert into public.shoot_shortlists (shoot_id, code, size, entry_ids, medium) values (shoot, 'SB02', 1, '{s3}', 'static');
  begin
    insert into public.shoot_shortlists (shoot_id, code, size, entry_ids, medium) values (shoot, 'B09', 1, '{x}', 'static');
    raise exception 'FAILED: a static batch took a video code';
  exception when check_violation then null;
  end;

  -- static elements are scored like video's
  insert into public.batch_scores (shortlist_id, element_kind, element_key, score) values
    (sb1, 'static_format', 'SF01', 'winner'), (sb1, 'variant', 'text_product', 'mid'), (sb1, 'static_copy', 'A01', 'loser'), (sb1, 'avatar', 'joe', 'mid');
  insert into public.shoot_element_overrides (shoot_id, element_kind, element_key, dropped) values (shoot, 'avatar', 'joe', true);

  -- the team reviews renders; cast can't
  insert into public.static_render_reviews (shortlist_id, recipe_id, decision) values (sb1, 'S001_nix_SF01.text_product_A01_abc', 'approved');
  perform set_config('request.jwt.claims', be_cast, true);
  begin
    insert into public.static_render_reviews (shortlist_id, recipe_id, decision) values (sb1, 'other', 'rejected');
    raise exception 'FAILED: cast reviewed a render';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', be_me, true);

  -- undo takes the latest static batch, and leaves video's alone
  code := public.undo_batch(shoot, 'static');
  if code <> 'SB02' then raise exception 'FAILED: undo took % not SB02', code; end if;
  if not exists (select 1 from public.shoot_shortlists where id = video) then raise exception 'FAILED: undoing statics took a video batch'; end if;
  -- the one-argument form is still video's
  code := public.undo_batch(shoot);
  if code <> 'B01' then raise exception 'FAILED: plain undo took % not B01', code; end if;

  -- reset the statics: their scores and reviews go too
  codes := public.reset_batches(shoot, 'static');
  if codes <> array['SB01'] then raise exception 'FAILED: reset returned %', codes; end if;
  select count(*) into n from public.static_render_reviews where shortlist_id = sb1;
  if n <> 0 then raise exception 'FAILED: reviews outlived their batch'; end if;

  perform set_config('role', 'postgres', true);
  raise notice 'static_batches: all passed';
end $$;

rollback;
