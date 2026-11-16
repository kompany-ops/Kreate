-- Shoot status changes in the chat: forward and back, each once; back moves can be turned off.
-- Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  code text;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
  posted text[];
begin
  insert into auth.users (id, email, aud, role) values (me, 'chat-status@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Chat Status', 'chat-status');
  insert into public.brands (name, slug) values ('Brand', 'brand-chat');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-chat' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id, shoots.code into shoot, code;

  perform set_config('role', 'postgres', true);
  delete from public.org_messages where org_id = mine;
  update public.shoots set status = 'planned' where id = shoot;
  update public.shoots set status = 'shooting' where id = shoot;
  update public.shoots set status = 'planned' where id = shoot;
  update public.shoots set status = 'draft' where id = shoot;

  select array_agg(body order by created_at, id) into posted from public.org_messages where org_id = mine and kind = 'event';
  if coalesce(array_length(posted, 1), 0) <> 4 then raise exception 'FAILED: expected 4 updates, got %: %', coalesce(array_length(posted, 1), 0), posted; end if;
  if not exists (select 1 from public.org_messages where org_id = mine and body = code || ' is back to draft (Brand · Chews).' and ref ->> 'event' = 'shoot_back') then
    raise exception 'FAILED: the move back to draft wasn''t posted as shoot_back: %', posted;
  end if;
  if not exists (select 1 from public.org_messages where org_id = mine and body like code || ' is back to planned%') then raise exception 'FAILED: back to planned missing: %', posted; end if;
  if not exists (select 1 from public.org_messages where org_id = mine and body like code || ' is being filmed%' and ref ->> 'event' = 'shoot_shooting') then raise exception 'FAILED: forward move missing: %', posted; end if;

  -- turned off: back moves go quiet, forward ones still post
  update public.settings set chat_events = '{"shoot_back": false}' where org_id = mine;
  delete from public.org_messages where org_id = mine;
  update public.shoots set status = 'planned' where id = shoot;
  update public.shoots set status = 'draft' where id = shoot;
  if (select count(*) from public.org_messages where org_id = mine) <> 1 then raise exception 'FAILED: with shoot_back off, expected only the forward update'; end if;
end $$;

select 'chat status: all checks passed' as result;
rollback;
