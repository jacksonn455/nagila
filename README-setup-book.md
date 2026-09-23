# Setup — venda do livro

Site estático + Netlify Functions (`functions/`) + Supabase (banco) + Mercado Pago (Checkout Pro) + Melhor Envio (frete).

ATENÇÃO: nunca commitar `.env`. Em produção as variáveis ficam no painel do Netlify.

## 1. Supabase
- Rodar `scripts/supabase-schema.sql` no SQL Editor (com RLS habilitado).
- `SUPABASE_URL`: Project Settings → Data API → Project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API Keys → Legacy API Keys → `service_role`.

## 2. Mercado Pago
- `MERCADOPAGO_ACCESS_TOKEN`: credenciais de produção da aplicação.
- Webhooks: Suas integrações → aplicação → Webhooks → URL de produção
  `https://<dominio>/.netlify/functions/paymentWebhook`, evento **Pagamentos**.
  Copiar a assinatura secreta para `MERCADOPAGO_WEBHOOK_SECRET`.
- `PAYMENT_WEBHOOK_URL`: a mesma URL acima (enviada em cada preferência).

## 3. Melhor Envio
- `MELHOR_ENVIO_TOKEN`: Integrações → Permissões de acesso → gerar token (escopo mínimo `shipping-calculate`).
- `ORIGIN_CEP`: CEP de onde os livros saem.
- Opcional: `MELHOR_ENVIO_ENV=sandbox` para testes; `MELHOR_ENVIO_USER_AGENT="Nome do app (email técnico)"`.
- Transportadoras oferecidas: Correios PAC (1), SEDEX (2) e Jadlog .Package (3). Para mudar, `MELHOR_ENVIO_SERVICES=1,2,3`.
- Retirada no local (frete grátis, sem endereço): ativa por padrão na NZ Beauty Clinic.
  `PICKUP_ADDRESS` troca o endereço exibido; `PICKUP_ENABLED=false` desativa.
  Pedidos de retirada ficam em `shipments` com `provider = pickup` e `status = awaiting_pickup`.

## 4. Livro
- `BOOK_TITLE`, `BOOK_PRICE_CENTS` (ex.: `8990` = R$ 89,90), `BOOK_WEIGHT_GRAMS`,
  `BOOK_LENGTH_CM`, `BOOK_WIDTH_CM`, `BOOK_HEIGHT_CM` (livro embalado), opcional `BOOK_MAX_QUANTITY`.
- Enquanto faltarem, a página mostra "Venda do livro ainda não configurada".

## 5. Netlify
- Add new site → Import an existing project → GitHub → este repositório. `netlify.toml` já define publish `.` e functions.
- Site configuration → Environment variables: cadastrar as variáveis acima.
  Não é preciso cadastrar `MERCADOPAGO_PUBLIC_KEY`, `MERCADOPAGO_CLIENT_ID` nem `MERCADOPAGO_CLIENT_SECRET`
  (as functions não usam; o limite total de variáveis das functions é 4 KB).
- `URL` é definida pelo Netlify e usada para as páginas de retorno (`livro.html?pagamento=aprovado|pendente|falhou`).
  Para sobrescrever, use `SITE_URL`.
- Testar no endereço `*.netlify.app` e só então apontar o DNS do domínio para o Netlify.

## 6. Teste em produção
- Colocar temporariamente `BOOK_PRICE_CENTS=100`, comprar, conferir no Supabase `orders.status = paid`,
  estornar no Mercado Pago e restaurar o preço.

## Pedidos
- `orders` (status: pending, paid, failed, cancelled, shipped), `order_items`, `addresses`,
  `shipments` (serviço de frete escolhido em `raw`), `payments` (retorno do Mercado Pago em `raw`).

## Testes
- `npm run test:mobile` roda os testes Playwright com as APIs mockadas.
  Os testes em `tests/livro.createOrder.spec.js` que chamam as functions de verdade e `tests/livro.paymentWebhook.spec.js`
  precisam de `netlify dev` (com `.env`) no lugar do servidor estático.
