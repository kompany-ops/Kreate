-- Brands: income becomes any mix of four types (a flat fee per video, a monthly retainer,
-- commission on sales, a share of ad spend) instead of one pay model; a star for the
-- particularly good brands; and archiving (hidden everywhere, kept with its products and
-- shoots, restorable).
alter table public.brands
  add column pay_types text[] not null default '{}'
    check (pay_types <@ array['flat', 'retainer', 'commission', 'ad_spend']::text[]),
  add column retainer_fee numeric(10, 2) check (retainer_fee >= 0),
  add column ad_spend_pct numeric(5, 2) check (ad_spend_pct between 0 and 100),
  add column starred boolean not null default false,
  add column archived_at timestamptz;

comment on column public.brands.pay_types is 'How the brand pays: any of flat (per video), retainer (monthly), commission (on sales), ad_spend (share of ad spend)';
comment on column public.brands.flat_fee is 'Flat fee per approved video, in currency';
comment on column public.brands.retainer_fee is 'Retainer per month, in currency';
comment on column public.brands.ad_spend_pct is 'Share of the brand''s ad spend on our videos, as a percentage';
comment on column public.brands.starred is 'Marked as a particularly good brand';
comment on column public.brands.archived_at is 'When the brand was archived; null while it''s in use';

-- the old single choice
update public.brands set pay_types = case pay_model
  when 'flat' then array['flat']
  when 'commission' then array['commission']
  when 'both' then array['flat', 'commission']
  else '{}'::text[] end;

-- Imported brands kept Trybe's retainer and ad-spend figures in trybe_data only (a retainer
-- was counted as a flat fee, ad spend as commission): give them their own columns and types.
update public.brands
set retainer_fee = (trybe_data ->> 'retainer')::numeric
where jsonb_typeof(trybe_data -> 'retainer') = 'number' and (trybe_data ->> 'retainer')::numeric >= 0;

update public.brands
set ad_spend_pct = (trybe_data ->> 'ad_spend_pct')::numeric
where jsonb_typeof(trybe_data -> 'ad_spend_pct') = 'number'
  and (trybe_data ->> 'ad_spend_pct')::numeric between 0 and 100;

update public.brands
set pay_types = array(
  select distinct t from unnest(
    case when flat_fee is null and retainer_fee is not null then array_remove(pay_types, 'flat') else pay_types end
    || case when retainer_fee is not null then array['retainer'] else '{}'::text[] end
    || case when ad_spend_pct is not null then array['ad_spend'] else '{}'::text[] end
  ) t
  where t <> 'commission' or commission_pct is not null or ad_spend_pct is null
)
where retainer_fee is not null or ad_spend_pct is not null;

alter table public.brands drop column pay_model;
