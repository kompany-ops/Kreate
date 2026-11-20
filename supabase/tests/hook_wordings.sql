-- Hook and CTA wordings on a shoot: set while a draft, frozen once planned, never on a VO.
-- Raises on the first failure, and rolls everything back either way.

begin;

do $$
declare
  me uuid := gen_random_uuid();
  mine uuid;
  product uuid;
  shoot uuid;
  person uuid;
  hook uuid;
  item uuid;
  be_me text := json_build_object('sub', me, 'role', 'authenticated')::text;
begin
  insert into auth.users (id, email, aud, role) values (me, 'hook-wordings@example.com', 'authenticated', 'authenticated');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', be_me, true);
  mine := public.create_org('Hook Wordings', 'hook-wordings');
  insert into public.brands (name, slug) values ('Brand', 'brand-wordings');
  insert into public.products (brand_id, name, slug) values ((select id from public.brands where slug = 'brand-wordings' and org_id = mine), 'Chews', 'chews') returning id into product;
  insert into public.shoots (product_id) values (product) returning id into shoot;
  select id into person from public.people where user_id = me and org_id = mine;
  if person is null then
    insert into public.people (name, slug, user_id) values ('Me', 'me', me) returning id into person;
  end if;
  insert into public.shoot_people (shoot_id, person_id) values (shoot, person);
  insert into public.hook_templates (script) values ('Nobody told me') returning id into hook;
  insert into public.shoot_items (shoot_id, person_id, kind, hook_template_id, code, script_snapshot)
    values (shoot, person, 'hook', hook, 'H01', to_jsonb('Nobody told me'::text)) returning id into item;

  -- a draft's hook takes other wordings
  update public.shoot_items set alternates = '{"Nobody warned me", "I wish I knew"}' where id = item;
  if (select cardinality(alternates) from public.shoot_items where id = item) <> 2 then
    raise exception 'FAILED: the wordings were not saved';
  end if;

  -- a VO never has them (its beats do)
  begin
    perform set_config('role', 'postgres', true);
    insert into public.shoot_items (org_id, shoot_id, person_id, kind, body_template_id, code, script_snapshot, alternates)
      values (mine, shoot, person, 'body', null, 'V01', '[]'::jsonb, '{"x"}');
    raise exception 'FAILED: a VO took hook-style wordings';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- once planned they're frozen, like the codes
  perform set_config('role', 'postgres', true);
  update public.shoots set status = 'planned' where id = shoot;
  perform set_config('role', 'authenticated', true);
  begin
    update public.shoot_items set alternates = '{"Something else"}' where id = item;
    raise exception 'FAILED: wordings changed on a planned shoot';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
    if sqlerrm not like '%wordings are frozen%' then raise exception 'FAILED: wrong error: %', sqlerrm; end if;
  end;

  raise notice 'hook_wordings: all passed';
end $$;

rollback;
