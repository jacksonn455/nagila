-- Migração dos cupons de desconto — rode no SQL Editor do Supabase ANTES do deploy dos cupons.
-- Idempotente: pode ser executada mais de uma vez. Não altera dados existentes.
-- Pedidos sem cupom não usam essas colunas; pedidos com cupom falham sem elas.

alter table public.orders add column if not exists coupon_code text;
alter table public.orders add column if not exists discount_cents bigint not null default 0
  check (discount_cents >= 0);

-- ==================================================================
-- VERIFICAÇÃO — rode depois (selecione e execute separadamente)
-- ==================================================================

-- select column_name, data_type from information_schema.columns
-- where table_schema = 'public' and table_name = 'orders'
--   and column_name in ('coupon_code', 'discount_cents');
