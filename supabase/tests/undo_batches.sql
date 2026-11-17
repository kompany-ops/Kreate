-- Undoing and resetting batches, and taking a Live shoot back to editing.
-- Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  b1 uuid;
  b2 uuid;
  undone text;
  reset text[];
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  be_stranger text := json_build_object('sub', stranger, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values
    (me, 'undo-batches@example.com', 'authenticated', 'authenticated'),
    (stranger, 'undo-batches-stranger@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Undo Batches', 'undo-batches');
  insert into public.brands (name, slug) values ('Brand', 'brand-undo');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-undo' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into shoot;

  -- a Live shoot with two batches, the first measured and scored
  perform set_config('role', 'postgres', true);
  update public.shoots set status = 'planned' where id = shoot;
  update public.shoots set status = 'edited' where id = shoot;
  insert into public.shoot_shortlists (org_id, shoot_id, code, size, entry_ids, status, created_at)
    values (mine, shoot, 'B01', 1, '{r1}', 'measured', now() - interval '1 day') returning id into b1;
  insert into public.shoot_shortlists (org_id, shoot_id, code, size, entry_ids)
    values (mine, shoot, 'B02', 1, '{r2}') returning id into b2;
  insert into public.batch_scores (org_id, shortlist_id, element_kind, element_key, score) values
    (mine, b1, 'hook', 'H01', 'winner'), (mine, b2, 'hook', 'H02', 'loser');

  -- someone outside the account can't
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_stranger, true);
  begin
    perform public.undo_batch(shoot);
    raise exception 'FAILED: a stranger undid a batch';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    perform public.reset_batches(shoot);
    raise exception 'FAILED: a stranger reset the batches';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- the owner undoes the latest: B02 and its scores go, B01 stays
  perform set_config('request.jwt.claims', be_me, true);
  undone := public.undo_batch(shoot);
  perform set_config('role', 'postgres', true);
  if undone <> 'B02' then raise exception 'FAILED: undid % instead of B02', undone; end if;
  if exists (select 1 from public.shoot_shortlists where id = b2) then raise exception 'FAILED: B02 is still there'; end if;
  if exists (select 1 from public.batch_scores where shortlist_id = b2) then raise exception 'FAILED: B02''s scores are still there'; end if;
  if not exists (select 1 from public.batch_scores where shortlist_id = b1) then raise exception 'FAILED: B01''s scores went too'; end if;

  -- can't leave Live while it has batches
  perform set_config('role', 'authenticated', true);
  begin
    update public.shoots set status = 'editing' where id = shoot;
    raise exception 'FAILED: left Live with a batch';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- reset: every batch goes, then it can go back to editing
  reset := public.reset_batches(shoot);
  if reset <> array['B01'] then raise exception 'FAILED: reset returned %', reset; end if;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.shoot_shortlists where shoot_id = shoot) then raise exception 'FAILED: batches left after reset'; end if;
  perform set_config('role', 'authenticated', true);
  update public.shoots set status = 'editing' where id = shoot;
  if (select status from public.shoots where id = shoot) <> 'editing' then raise exception 'FAILED: didn''t go back to editing'; end if;

  -- nothing left to undo
  begin
    perform public.undo_batch(shoot);
    raise exception 'FAILED: undid a batch that wasn''t there';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
end $$;

select 'undo batches: all checks passed' as result;
rollback;
