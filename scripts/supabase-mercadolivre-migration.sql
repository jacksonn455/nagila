-- Migração da integração com o Mercado Livre — rode no SQL Editor do Supabase ANTES do deploy.
-- Idempotente: pode ser executada mais de uma vez. Não altera dados existentes:
-- pedidos do site continuam com channel = 'site' e as mesmas colunas de antes.
-- Tudo continua com RLS ligado e sem políticas: só a service_role (Functions) acessa.
--
-- ANTES de rodar, confira a consulta "PRÉ-VERIFICAÇÃO" no fim do arquivo (deve voltar vazia).

-- ------------------------------------------------------------------
-- 1) orders — canal de venda e identificadores do Mercado Livre
-- ------------------------------------------------------------------
alter table public.orders add column if not exists channel text not null default 'site';
alter table public.orders add column if not exists external_order_id text;
alter table public.orders add column if not exists external_pack_id text;
-- Subconjunto do pedido externo usado no painel e no Discord (comprador, status original).
-- Nunca guarda tokens; não guarda endereço nem documento do comprador.
alter table public.orders add column if not exists external_data jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_channel_check') then
    alter table public.orders add constraint orders_channel_check check (channel in ('site', 'mercadolivre'));
  end if;
  -- Pedidos do site têm external_order_id nulo (nulos não conflitam na unique)
  if not exists (select 1 from pg_constraint where conname = 'orders_channel_external_order_unique') then
    alter table public.orders add constraint orders_channel_external_order_unique unique (channel, external_order_id);
  end if;
end $$;

create index if not exists idx_orders_channel on public.orders(channel);

-- ------------------------------------------------------------------
-- 2) order_items — título do anúncio e upsert idempotente por (pedido, produto)
--    Site: product_id = 'book-nagila-zortea' (uma linha por pedido).
--    Mercado Livre: product_id = id do anúncio (MLB...) ou 'MLB...:<variation_id>'.
-- ------------------------------------------------------------------
alter table public.order_items add column if not exists title text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_order_product_unique') then
    alter table public.order_items add constraint order_items_order_product_unique unique (order_id, product_id);
  end if;
end $$;

-- ------------------------------------------------------------------
-- 3) payments — reutilizada sem mudanças de coluna.
--    Pagamentos do Mercado Livre são pagamentos do Mercado Pago: ficam em
--    mercadopago_payment_id (unique) com provider = 'mercadolivre'.
-- ------------------------------------------------------------------

-- ------------------------------------------------------------------
-- 4) shipments — envio do Mercado Livre (provider = 'mercadolivre')
-- ------------------------------------------------------------------
alter table public.shipments add column if not exists external_shipment_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipments_provider_external_unique') then
    alter table public.shipments add constraint shipments_provider_external_unique unique (provider, external_shipment_id);
  end if;
end $$;

-- ------------------------------------------------------------------
-- 5) processed_notifications — vira também a fila de notificações do Mercado Livre.
--    As linhas do Mercado Pago (paymentWebhook) continuam iguais: as colunas novas
--    ficam nulas/zeradas para elas e o processador só lê provider = 'mercadolivre'.
-- ------------------------------------------------------------------
alter table public.processed_notifications add column if not exists topic text;
alter table public.processed_notifications add column if not exists resource text;
alter table public.processed_notifications add column if not exists status text;
alter table public.processed_notifications add column if not exists attempts integer not null default 0;
alter table public.processed_notifications add column if not exists last_error text;
alter table public.processed_notifications add column if not exists next_attempt_at timestamptz;
alter table public.processed_notifications add column if not exists locked_at timestamptz;
alter table public.processed_notifications add column if not exists processed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'processed_notifications_status_check') then
    alter table public.processed_notifications add constraint processed_notifications_status_check
      check (status is null or status in ('pending', 'processing', 'done', 'ignored', 'failed'));
  end if;
end $$;

create index if not exists idx_processed_notifications_queue
  on public.processed_notifications(provider, status, next_attempt_at);

-- ------------------------------------------------------------------
-- 6) marketplace_integrations — conta de vendedor conectada por OAuth
--    Tokens só criptografados (AES-256-GCM, formato "v1.<iv>.<tag>.<dados>").
-- ------------------------------------------------------------------
create table if not exists public.marketplace_integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  seller_id text not null,
  seller_nickname text,
  access_token_enc text not null,
  refresh_token_enc text not null,
  token_expires_at timestamptz not null,
  scopes text,
  status text not null default 'active',
  version integer not null default 1,
  -- "lease" da renovação: só quem pegou o lease chama o Mercado Livre
  refresh_lock_until timestamptz not null default 'epoch',
  last_refreshed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_integrations_provider_seller_unique unique (provider, seller_id),
  constraint marketplace_integrations_status_check check (status in ('active', 'reauthorization_required', 'disconnected'))
);

drop trigger if exists marketplace_integrations_set_timestamp on public.marketplace_integrations;
create trigger marketplace_integrations_set_timestamp
before update on public.marketplace_integrations
for each row
execute function public.trigger_set_timestamp();

alter table public.marketplace_integrations enable row level security;

grant select, insert, update, delete on public.marketplace_integrations to service_role;

-- ==================================================================
-- PRÉ-VERIFICAÇÃO — rode ANTES (deve voltar vazio; se voltar linhas,
-- a constraint order_items_order_product_unique não pode ser criada)
-- ==================================================================
-- select order_id, product_id, count(*) from public.order_items
-- group by order_id, product_id having count(*) > 1;

-- ==================================================================
-- VERIFICAÇÃO — rode depois (selecione e execute separadamente)
-- ==================================================================

-- 1) Colunas novas
-- select table_name, column_name from information_schema.columns
-- where table_schema = 'public'
--   and ((table_name = 'orders' and column_name in ('channel','external_order_id','external_pack_id','external_data'))
--     or (table_name = 'order_items' and column_name = 'title')
--     or (table_name = 'shipments' and column_name = 'external_shipment_id')
--     or (table_name = 'processed_notifications' and column_name in ('topic','resource','status','attempts','last_error','next_attempt_at','locked_at','processed_at')))
-- order by table_name, column_name;

-- 2) Constraints únicas usadas pelos upserts
-- select conrelid::regclass as tabela, conname from pg_constraint
-- where conname in ('orders_channel_external_order_unique','order_items_order_product_unique',
--                   'shipments_provider_external_unique','marketplace_integrations_provider_seller_unique');

-- 3) Pedidos existentes continuam no canal do site
-- select channel, count(*) from public.orders group by channel;

-- 4) RLS ativo e sem políticas na tabela nova
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'marketplace_integrations';
-- select policyname from pg_policies where schemaname = 'public' and tablename = 'marketplace_integrations';
