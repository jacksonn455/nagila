-- Migração da área administrativa — rode no SQL Editor do Supabase ANTES do deploy do admin.
-- Idempotente: pode ser executada mais de uma vez. Não altera dados existentes.
-- Tudo continua com RLS ligado e sem políticas: só a service_role (Functions) acessa.

-- 1) Registro do envio/retirada em shipments
alter table public.shipments add column if not exists shipped_at timestamptz;
alter table public.shipments add column if not exists marked_by text;

-- 2) Tentativas de login no admin (limite contra força bruta)
--    key_hash = HMAC do IP ou do e-mail (nunca o valor puro)
create table if not exists public.admin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_login_attempts_key_created
  on public.admin_login_attempts(key_hash, created_at);

alter table public.admin_login_attempts enable row level security;

grant select, insert, update, delete on public.admin_login_attempts to service_role;

-- ==================================================================
-- VERIFICAÇÃO — rode depois (selecione e execute separadamente)
-- ==================================================================

-- 1) Colunas novas em shipments
-- select column_name, data_type from information_schema.columns
-- where table_schema = 'public' and table_name = 'shipments'
--   and column_name in ('shipped_at', 'marked_by');

-- 2) Tabela de tentativas com RLS ativo (rowsecurity = true) e sem políticas
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'admin_login_attempts';
-- select policyname from pg_policies where schemaname = 'public' and tablename = 'admin_login_attempts';
