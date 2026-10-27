-- Supabase schema v2 — venda do livro (Netlify Functions)
-- Cole no SQL Editor do Supabase e rode. Idempotente: pode ser executado mais de uma vez.
-- As Functions usam a service_role, que ignora o RLS; anon/authenticated ficam sem acesso.

-- customers — createOrder faz upsert por e-mail (on_conflict=email)
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  created_at timestamptz default now(),
  constraint customers_email_unique unique (email)
);

-- orders — createOrder (insert, busca por client_token, PATCH de preferência/status),
-- paymentWebhook e orderStatus (select id,status,total_cents)
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  mercadopago_preference_id text,
  client_token text, -- token de idempotência enviado pelo navegador
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','shipped')),
  total_cents bigint not null check (total_cents >= 0),
  shipping_cents bigint not null default 0 check (shipping_cents >= 0),
  currency text not null default 'BRL',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint orders_client_token_unique unique (client_token)
);

create index if not exists idx_orders_customer_id on public.orders(customer_id);
create index if not exists idx_orders_mercadopago_pref on public.orders(mercadopago_preference_id);

-- order_items
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  product_id text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  subtotal_cents bigint not null check (subtotal_cents >= 0)
);

create index if not exists idx_order_items_order_id on public.order_items(order_id);

-- addresses — só para entrega (retirada no local não grava endereço)
create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  cep text not null,
  street text,
  number text,
  complement text,
  neighborhood text,
  city text,
  state text,
  country text default 'BR'
);

create index if not exists idx_addresses_order_id on public.addresses(order_id);

-- payments — createOrder grava a preferência; paymentWebhook faz upsert por
-- mercadopago_payment_id (on_conflict=mercadopago_payment_id)
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  mercadopago_payment_id text,
  mercadopago_preference_id text,
  provider text,
  method text,
  status text,
  amount_cents bigint check (amount_cents >= 0),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint payments_mercadopago_payment_id_unique unique (mercadopago_payment_id)
);

create index if not exists idx_payments_order_id on public.payments(order_id);

-- shipments — serviço de entrega escolhido (PAC, SEDEX, retirada...)
create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  provider text,
  tracking_code text,
  status text,
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_shipments_order_id on public.shipments(order_id);

-- processed_notifications — ids de notificação do Mercado Pago
-- (on_conflict=provider,provider_notification_id)
create table if not exists public.processed_notifications (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_notification_id text not null,
  payload jsonb,
  created_at timestamptz default now(),
  constraint processed_notifications_provider_id_unique unique (provider, provider_notification_id)
);

-- Atualiza orders.updated_at a cada UPDATE
create or replace function public.trigger_set_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_timestamp on public.orders;
create trigger orders_set_timestamp
before update on public.orders
for each row
execute function public.trigger_set_timestamp();

-- RLS ligado, sem políticas: só a service_role (Functions) lê e grava
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.addresses enable row level security;
alter table public.payments enable row level security;
alter table public.shipments enable row level security;
alter table public.processed_notifications enable row level security;

-- Garante acesso da service_role pela API REST, mesmo se o projeto não expuser
-- tabelas novas automaticamente
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.customers, public.orders, public.order_items, public.addresses,
  public.payments, public.shipments, public.processed_notifications
to service_role;

-- ==================================================================
-- VERIFICAÇÃO — rode depois (selecione e execute separadamente)
-- ==================================================================

-- 1) As 7 tabelas existem e estão com RLS ativo (rowsecurity = true)
-- select tablename, rowsecurity
-- from pg_tables
-- where schemaname = 'public'
--   and tablename in ('customers','orders','order_items','addresses','payments','shipments','processed_notifications')
-- order by tablename;

-- 2) Nenhuma política criada (deve voltar vazio)
-- select tablename, policyname from pg_policies where schemaname = 'public';

-- 3) Trigger de updated_at instalado em orders
-- select tgname from pg_trigger where tgrelid = 'public.orders'::regclass and not tgisinternal;

-- 4) Constraints únicas usadas pelos upserts das Functions
-- select conrelid::regclass as tabela, conname
-- from pg_constraint
-- where conname in ('customers_email_unique','orders_client_token_unique',
--                   'payments_mercadopago_payment_id_unique','processed_notifications_provider_id_unique');
