-- Supabase schema for Nagila Zortéa — Book sales (MVP)
-- DO NOT RUN until you review and adjust values marked as NEEDS_CONFIRMATION

-- Extensions
create extension if not exists "uuid-ossp";

-- customers
create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text not null,
  phone text,
  created_at timestamptz default now(),
  constraint customers_email_unique unique (email)
);

-- orders
-- order of creation ensures FKs reference existing tables
create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  mercadopago_preference_id text,
  client_token text, -- idempotency token from client
  customer_id uuid references customers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','shipped')),
  total_cents bigint not null check (total_cents >= 0),
  shipping_cents bigint not null default 0 check (shipping_cents >= 0),
  currency text not null default 'BRL',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint orders_client_token_unique unique (client_token)
);

create index if not exists idx_orders_customer_id on orders(customer_id);
create index if not exists idx_orders_client_token on orders(client_token);
create index if not exists idx_orders_mercadopago_pref on orders(mercadopago_preference_id);

-- order_items
create table if not exists order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  product_id text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  subtotal_cents bigint not null check (subtotal_cents >= 0)
);

create index if not exists idx_order_items_order_id on order_items(order_id);

-- addresses (created after orders)
create table if not exists addresses (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  cep text not null,
  street text,
  number text,
  complement text,
  neighborhood text,
  city text,
  state text,
  country text default 'BR'
);

-- payments
create table if not exists payments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
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

create index if not exists idx_payments_order_id on payments(order_id);
create index if not exists idx_payments_mercadopago_payment_id on payments(mercadopago_payment_id);

-- shipments
create table if not exists shipments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  provider text,
  tracking_code text,
  status text,
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_shipments_order_id on shipments(order_id);

-- processed_notifications: store provider webhook ids to ensure idempotency
create table if not exists processed_notifications (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,
  provider_notification_id text not null,
  payload jsonb,
  created_at timestamptz default now(),
  constraint processed_notifications_provider_id_unique unique (provider, provider_notification_id)
);

create index if not exists idx_processed_notifications_provider_id on processed_notifications(provider, provider_notification_id);

-- trigger to update orders.updated_at
create or replace function trigger_set_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger orders_set_timestamp
before update on orders
for each row
execute procedure trigger_set_timestamp();

-- NOTES:
-- 1) product catalog is not modelled here (single product). For MVP product data is configured server-side (BOOK).
-- 2) Replace/adjust RLS policies in Supabase UI: allow only server service_role to write sensitive tables; frontend should NOT have write access.
-- 3) Fields marked as NEEDS_CONFIRMATION must be provided before running migrations.

-- ==================================================================
-- RLS POLICIES SUGGESTED (NEEDS CONFIRMATION / DO NOT APPLY YET)
-- ==================================================================
-- The following are example Row Level Security (RLS) policies to apply
-- via the Supabase Console SQL editor or UI. DO NOT execute until you
-- have verified roles and tested in a non-production environment.
-- These policies intentionally restrict frontend (anon/public) from
-- performing writes to sensitive tables. The service_role key bypasses
-- RLS and must be kept secret on the server.

-- 1) enable RLS on sensitive tables
-- ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE processed_notifications ENABLE ROW LEVEL SECURITY;

-- 2) allow public (unauthenticated) users to read limited order info
-- (example: allow public SELECT on orders but only non-sensitive columns)
-- CREATE POLICY "public_read_orders_limited" ON orders
--   FOR SELECT USING (true);

-- 3) deny public INSERT/UPDATE/DELETE on orders/payments/shipments
-- (explicit deny is achieved by not creating permissive policies)
-- If you need the frontend to create a draft or quote, create a specific
-- endpoint on the server that performs the insert using service_role.

-- 4) example policies for authenticated users (optional)
-- These examples assume you use Supabase Auth and want to allow users
-- to read their own orders by matching customers.email = auth.email()
-- -- allow users to read their own orders (if customers.email is set)
-- CREATE POLICY "users_select_own_orders" ON orders
--   FOR SELECT USING (
--     EXISTS (SELECT 1 FROM customers WHERE customers.id = orders.customer_id AND customers.email = auth.email())
--   );

-- 5) policies for processed_notifications and payments should be server-only
-- Example: no public policies; only service_role may insert/select

-- 6) service_role bypass note (DO NOT SEND TO FRONTEND)
-- The SUPABASE_SERVICE_ROLE_KEY bypasses RLS entirely. Never embed this
-- key in client-side code or commit it to version control. Use provider
-- secrets / environment variables for serverless functions.

-- END RLS SUGGESTIONS
