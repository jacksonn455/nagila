# Setup — venda do livro

Site estático + Netlify Functions (`functions/`) + Supabase (banco) + Mercado Pago (Checkout Pro) + Melhor Envio (frete).

ATENÇÃO: nunca commitar `.env`. Em produção as variáveis ficam no painel do Netlify.

## 1. Supabase
- Rodar `scripts/supabase-schema-v2.sql` no SQL Editor (idempotente; já liga o RLS nas 7 tabelas).
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
- Opcional `BOOK_STOCK`: exemplares disponíveis para venda. Vazio = sem controle de estoque; `0` = esgotado.
  Disponível = estoque − pedidos `paid`/`shipped` − pedidos `pending` das últimas 48 h.
- Enquanto faltarem, a página mostra "Venda do livro ainda não configurada".

## 4.1 Aviso de venda no Discord
- Opcional `DISCORD_WEBHOOK_URL`: no Discord, Configurações do canal → Integrações → Webhooks → copiar URL.
  A cada pedido que passa a `paid`, o `paymentWebhook` manda uma mensagem com cliente, exemplares,
  total, entrega e meio de pagamento (sem e-mail nem telefone). Falha no Discord não afeta o pedido.
- A URL é um segredo: só no `.env` e no painel do Netlify, nunca no repositório.

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

## 7. Mercado Livre (vendas do marketplace no painel e no Discord)

Integração oficial: OAuth Authorization Code + PKCE (obrigatório) + Refresh Token, notificações `orders_v2` e `shipments`.
Os pedidos do Mercado Livre entram nas mesmas tabelas (`orders.channel = 'mercadolivre'`) e aparecem no painel.

### 7.1 Banco
- Rodar `scripts/supabase-mercadolivre-migration.sql` no SQL Editor **antes do deploy** (idempotente).
  Antes, rodar a "PRÉ-VERIFICAÇÃO" do fim do arquivo (deve voltar vazia).

### 7.2 Aplicação no Mercado Livre Developers (conferir)
- Redirect URI: `https://nagilazortea.com.br/.netlify/functions/mercadoLivreOAuthCallback` (exatamente assim; sem `www`, sem barra final).
- Fluxos: Authorization Code e Refresh Token; PKCE ativado.
- Escopos: leitura (`read`) e `offline_access` (sem ele não há refresh token). `write` não é necessário.
- Permissões funcionais: leitura de vendas/pedidos, envios e usuários.
- URL de notificações: `https://nagilazortea.com.br/.netlify/functions/mercadoLivreWebhook`.
- Tópicos: `orders_v2` e, se usar Mercado Envios, `shipments`.

### 7.3 Variáveis no Netlify
- `MERCADO_LIVRE_CLIENT_ID`, `MERCADO_LIVRE_CLIENT_SECRET` (da aplicação).
- `MERCADO_LIVRE_REDIRECT_URI` = a Redirect URI acima; `MERCADO_LIVRE_WEBHOOK_URL` = a URL de notificações (informativa).
- `MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY`: gerar uma vez e guardar só no Netlify:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Trocar a chave torna os tokens gravados ilegíveis: depois de trocar, reconectar a conta.
- Opcionais: `MERCADO_LIVRE_DISCORD_WEBHOOK_URL` (canal próprio; sem ela usa `DISCORD_WEBHOOK_URL`),
  `MERCADO_LIVRE_BOOK_ITEM_IDS` (ver 7.6), `MERCADO_LIVRE_BACKGROUND_PROCESSING=true` (ver 7.5).
- Lembrar do limite de 4 KB das variáveis das functions.

### 7.4 Conectar a conta do vendedor
- Painel `/admin/pedidos.html` → bloco "Mercado Livre" → **Conectar conta**. Entrar no Mercado Livre com a conta
  **vendedora principal** (não colaborador) e autorizar. O retorno mostra "Conta do Mercado Livre conectada."
- O botão vira **Reconectar conta**: use quando o painel mostrar "Precisa reconectar".
- O fluxo só funciona no domínio de produção (a Redirect URI precisa ser idêntica).

### 7.5 Processamento e renovação do token
- O webhook só grava a notificação e responde 200; o pedido é buscado na API do Mercado Livre depois.
- `mercadoLivreScheduler` (a cada 5 min, `netlify.toml`) processa a fila, refaz o que falhou (espera crescente,
  até 8 tentativas) e renova o access token quando faltam menos de 10 min (dura ~6 h).
- O refresh token é de uso único: cada renovação grava um par novo (com controle de versão para duas renovações
  simultâneas não se atrapalharem). Se o Mercado Livre recusar (`invalid_grant`), a integração fica
  "Precisa reconectar", chega um alerta no Discord e as vendas novas ficam na fila até reconectar.
- Opcional: com `MERCADO_LIVRE_BACKGROUND_PROCESSING=true` o webhook aciona `mercadoLivreProcess-background` na hora
  (requer Background Functions no plano do Netlify). Sem isso, o atraso máximo é ~5 min.

### 7.6 Estoque e envio — decisões de negócio
- Estoque: por padrão as vendas do Mercado Livre **não** descontam o `BOOK_STOCK` do site (comportamento anterior).
  Se o livro do Mercado Livre sai do mesmo estoque físico, listar os anúncios em `MERCADO_LIVRE_BOOK_ITEM_IDS`
  (`MLB123456789`, ou `MLB123456789:<variation_id>` para variações), separados por vírgula.
- Envio: pedidos do Mercado Livre são enviados pelo próprio Mercado Livre. O painel mostra a situação, mas não deixa
  "marcar como enviado" (isso exigiria escopo `write` e regras diferentes por modalidade: Full, Flex, coleta, envio próprio).

### 7.7 Problemas comuns
- Painel mostra "Integração não configurada": falta variável (o painel lista os nomes) ou a chave não tem 32 bytes.
- Retorno `?ml=estado_invalido`: a conexão não começou pelo botão do painel, ou começou em outro navegador/domínio.
- Retorno `?ml=expirado`: mais de 10 min entre clicar em Conectar e autorizar.
- Retorno `?ml=sem_offline_access`: a aplicação não tem o escopo `offline_access`.
- Retorno `?ml=erro`: ver o log da function `mercadoLivreOAuthCallback` (redirect_uri diferente da cadastrada,
  credenciais erradas, código já usado).
- Vendas não aparecem: conferir no log do `mercadoLivreWebhook` se as notificações chegam (403 = application_id ou
  vendedor diferente da conta conectada) e, no Supabase, `processed_notifications` com `provider = 'mercadolivre'`
  (`status`, `attempts`, `last_error`). Os logs nunca mostram tokens.

## Pedidos
- `orders` (status: pending, paid, failed, cancelled, shipped), `order_items`, `addresses`,
  `shipments` (serviço de frete escolhido em `raw`), `payments` (retorno do Mercado Pago em `raw`).
- `orders.channel`: `site` ou `mercadolivre` (com `external_order_id`, `external_pack_id`, `external_data`).
  `marketplace_integrations` guarda a conta conectada (tokens só criptografados).
  `processed_notifications` é também a fila das notificações do Mercado Livre.

## Testes
- `npm run test:mobile` roda os testes Playwright com as APIs mockadas.
  Os testes em `tests/livro.createOrder.spec.js` que chamam as functions de verdade e `tests/livro.paymentWebhook.spec.js`
  precisam de `netlify dev` (com `.env`) no lugar do servidor estático.
