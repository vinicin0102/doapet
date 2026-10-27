# DoaPet — Barra de progresso editável da campanha

Site da Nossa ONG com uma **barra de progresso da meta de arrecadação** (R$ 5.000,00 para a compra de ração para mais de 10 mil animais resgatados) e um **painel administrativo** para gerenciar a meta e o valor arrecadado, sem precisar alterar o código do site.

- Node.js 22 ou 24, servidor HTTP nativo (`node:http`), banco **PostgreSQL** (driver `pg`).
- Em produção os dados ficam no Postgres apontado por `DATABASE_URL` (ex.: Neon na Vercel).
- Em desenvolvimento, sem `DATABASE_URL`, os dados ficam em um Postgres embutido (PGlite) em `data/pglite`.

## Publicar na Vercel

1. Importe o repositório na Vercel (o `server.js` é detectado automaticamente).
2. Em **Storage → Create Database → Neon**, crie o banco e conecte ao projeto. Isso cria `DATABASE_URL`.
3. Em **Settings → Environment Variables**, cadastre `ADMIN_USERNAME` e `ADMIN_PASSWORD` (mínimo 10 caracteres). O primeiro administrador é criado no primeiro acesso, se ainda não houver nenhum.
4. Para o quadro de doações, cadastre as credenciais da ZuckPay: `ZUCKPAY_CLIENT_ID`, `ZUCKPAY_CLIENT_SECRET` e `ZUCKPAY_WEBHOOK_SECRET` (veja abaixo).
5. (Opcional) Cadastre `PIX_WEBHOOK_SECRET` quando configurar o provedor Pix.
6. Faça um novo deploy. As tabelas são criadas automaticamente.

## Rodar localmente

```bash
npm install
npm run criar-admin -- maria  # a senha é pedida no terminal
npm run dev                   # http://localhost:3000
```

- Página pública: `http://localhost:3000/`
- Painel administrativo: `http://localhost:3000/admin/`

Os testes rodam com `npm test`. Para rodá-los contra um Postgres real, use `TEST_DATABASE_URL=postgres://… npm test`.

> As variáveis não são lidas automaticamente do `.env`. Use `node --env-file=.env server.js` ou exporte-as no ambiente.

## Exibição pública

A seção "Campanha da Ração" da página inicial mostra:

- **Meta**: "Nossa meta é R$ 5.000,00"
- **Valor arrecadado**: "R$ 1.750,00 arrecadados de R$ 5.000,00"
- **Barra visual**, preenchida proporcionalmente (sempre entre 0% e 100%)
- **Percentual atingido**, calculado automaticamente: "35% da meta alcançada!"
- **Quanto falta**, nunca menor que zero: "Faltam R$ 3.250,00 para atingir nossa meta."

Quando a arrecadação passa da meta, a página mostra o valor real e a mensagem **"Meta atingida!"**, e a barra fica limitada a 100%.

Os valores são lidos da API sem cache. Quem abre a página vê sempre o valor salvo mais recente. Uma página que já está aberta se atualiza sozinha a cada 15 segundos e ao voltar para a aba. No mesmo navegador do painel, a atualização é imediata após "Salvar alterações".

### Usar a barra em outro site da ONG

```html
<link rel="stylesheet" href="https://SEU-DOMINIO/css/barra-meta.css" />
<div data-meta-campanha></div>
<script src="https://SEU-DOMINIO/js/barra-meta.js" defer></script>
```

## Quadro de doações

Logo abaixo da barra, a seção **"Faça sua doação"** oferece os valores **R$ 5, 10, 15, 25, 30, 50 e 100**. O de **R$ 50** aparece destacado como **"Mais escolhido"** e já vem selecionado. Os valores ficam em `public/js/shared/doacao.js`, e o servidor só aceita esses.

### Pagamentos pela ZuckPay (recomendado)

Com as credenciais da ZuckPay configuradas:

1. O doador escolhe o valor e informa nome, CPF, e-mail e celular. São campos obrigatórios da API da ZuckPay: os dados vão só para a ZuckPay e não são guardados no site.
2. O site cria a cobrança (`POST /v3/pix/qrcode`) com um `external_id_client` único (`DOAPET…`). Ele serve de chave de idempotência e de identificação da doação.
3. A página mostra o QR Code e o Pix Copia e Cola, depois acompanha o pagamento.
4. A confirmação chega de dois jeitos, e qualquer um basta:
   - **Postback** da ZuckPay em `/api/zuckpay/webhook` (enviado para a `urlnoty` da cobrança). A assinatura `X-ZuckPay-Signature` é validada quando `ZUCKPAY_WEBHOOK_SECRET` está definido, com tolerância de 5 minutos.
   - **Consulta de status** feita enquanto a página do doador está aberta.
5. Em ambos os casos o site **confirma o status e o valor direto na API da ZuckPay** (`GET /v3/pix/status`). Um aviso falso não consegue aumentar a arrecadação.
6. Só pagamentos `PAID` entram na barra (modos automático e híbrido), uma única vez. Estornos (`REFUNDED`, `CHARGEBACK`) são descontados. Vendas da conta ZuckPay que não foram geradas por este site são ignoradas.

Variáveis:

| Variável | Onde obter |
|---|---|
| `ZUCKPAY_CLIENT_ID` e `ZUCKPAY_CLIENT_SECRET` | Painel ZuckPay → Desenvolvedores → Credenciais API |
| `ZUCKPAY_WEBHOOK_SECRET` | Painel ZuckPay → `keys.php` → card "Webhook Secret" |
| `SITE_URL` (opcional) | Endereço público do site. Na Vercel é detectado automaticamente |

Observações:

- Algumas adquirentes exigem valor mínimo de R$ 10,00. Se a ZuckPay recusar o valor de R$ 5, o doador vê a mensagem da ZuckPay.
- Para evitar abuso, cada IP pode gerar até 10 Pix a cada 10 minutos.
- Cobranças geradas e não pagas não contam na meta e não aparecem na lista de Pix do painel.

### Alternativa: Pix estático (sem processador)

Sem ZuckPay, o site pode gerar um Pix Copia e Cola (BR Code do Banco Central) direto para a chave da ONG. Para isso, defina:

- `PIX_CHAVE`: e-mail, `+55DDDNÚMERO`, CPF, CNPJ ou chave aleatória;
- `PIX_NOME_RECEBEDOR`: até 25 caracteres;
- `PIX_CIDADE`: até 15 caracteres.

Nesse modo não há confirmação automática: os valores recebidos entram pelo painel (modo manual ou contribuições externas).

Sem nenhuma das duas configurações, o quadro aparece, mas avisa que o Pix está em configuração.

## Painel administrativo: "Gerenciar Meta da Campanha"

No painel, o administrador pode:

1. Editar o **valor total da meta**.
2. Escolher o **modo de gerenciamento** (veja abaixo).
3. No modo manual, preencher o campo **"Valor arrecadado informado manualmente"** (ex.: `1.750,00`) e a **origem** do valor.
4. Ver a **pré-visualização** com o percentual e quanto falta, calculados com as mesmas regras do servidor.
5. Clicar em **"Salvar alterações"**. A barra pública é atualizada imediatamente.
6. Registrar/remover **contribuições externas** (modo híbrido).
7. Ver as **doações Pix recentes** e o **histórico de alterações** (data, administrador, valores anteriores e novos, observação).

### Modos de gerenciamento

| Modo | Valor arrecadado exibido | Edição manual do total |
|---|---|---|
| **Automático** | Soma das doações Pix **confirmadas** pelo provedor | Bloqueada (o servidor recusa com erro 422) |
| **Manual** | Valor informado pelo administrador, com origem obrigatória | Permitida e registrada no histórico |
| **Híbrido** | Pix confirmados **+** contribuições externas registradas | Bloqueada: cada contribuição é registrada individualmente |

Regras de proteção:

- **Automático**: uma edição manual nunca sobrescreve o total de Pix confirmados.
- **Manual**: ao trocar para o modo manual, o painel pede confirmação explícita e mostra o total de Pix que deixará de ser somado automaticamente. A origem do valor é obrigatória e fica no histórico.
- **Híbrido, sem duplicidade**:
  - cada Pix é identificado pelo `txid` (único) e nunca é somado duas vezes, mesmo que o provedor reenvie o webhook;
  - uma contribuição externa não pode repetir a referência de outra, nem usar a referência (txid ou ID E2E) de um Pix já contado;
  - as remoções são lógicas (o registro continua guardado para auditoria) e exigem um motivo.

## Integração com o provedor Pix

Endpoint: `POST /api/pix/webhook`

- **Autenticação**: assinatura HMAC-SHA256 do corpo bruto com o segredo `PIX_WEBHOOK_SECRET`, enviada no cabeçalho `X-Pix-Signature: sha256=<hex>`. Sem o segredo configurado, o webhook fica desativado.
- **Formato padrão do Banco Central** (Efí, Itaú, Inter, Sicoob…):
  `{ "pix": [ { "endToEndId": "E…", "txid": "…", "valor": "25.00", "horario": "…", "devolucoes": [...] } ] }`
  Cada item é um Pix liquidado. Devoluções com status `DEVOLVIDO` são descontadas.
- **Formato genérico** (para um adaptador de outro provedor):
  `{ "txid": "…", "valor": "25.00", "status": "CONCLUIDA" }`
  Só `CONCLUIDA`/`confirmed`/`approved`/`paid` contam. Qualquer outro status fica como pendente e **não** soma na meta.

Se o seu provedor assina os webhooks de outro jeito (mTLS, token próprio etc.), basta adaptar `verifySignature`/`normalizePixPayload` em `src/pix.js`. O resto do sistema não muda.

## Segurança e transparência

- Somente administradores autenticados alteram a meta e o progresso. A página pública e a API pública (`GET /api/campanha`) são somente leitura.
- Senhas com hash `scrypt`. A sessão fica em um cookie `HttpOnly` + `SameSite=Strict` (`Secure` em produção). Toda alteração exige também um token CSRF.
- O login é bloqueado por 15 minutos após 5 tentativas erradas (controle guardado no banco).
- **Todos os valores são validados no servidor**: sem negativos, no máximo 2 casas decimais, meta maior que zero, limite de sanidade e datas que não podem estar no futuro.
- Os valores são guardados em centavos (inteiros), sem erros de arredondamento.
- Edições simultâneas: se outro administrador salvou antes, o painel avisa e pede para recarregar, em vez de sobrescrever.
- Toda alteração administrativa vai para o histórico (que só recebe inserções).
- **Nenhum valor fictício**: a campanha começa em R$ 0,00 no modo automático, e o total só muda com um Pix confirmado ou uma ação registrada de um administrador.

## Estrutura

```
server.js               inicialização do servidor HTTP
src/app.js              rotas, autenticação das rotas, arquivos estáticos
src/campaign.js         regras da campanha (modos, histórico, contribuições, Pix)
src/pix.js              verificação e normalização do webhook Pix
src/zuckpay.js          cliente da API ZuckPay e validação do postback assinado
src/donations.js        doações pela ZuckPay: cobrança, consulta de status e confirmação
src/brcode.js           Pix Copia e Cola estático (BR Code), alternativa sem processador
src/auth.js             administradores, senhas, sessões, limite de login
src/db.js               esquema e conexão PostgreSQL (pg em produção, PGlite local)
public/index.html       página inicial da ONG
public/js/barra-meta.js widget da barra de progresso
public/js/doacao.js     quadro de doações (valores pré-definidos, QR Code e Copia e Cola)
public/js/shared/       cálculo do progresso, validação de valores e valores de doação (servidor e navegador)
vercel.json             cabeçalhos de segurança na Vercel
public/admin/           painel administrativo
scripts/create-admin.js criação de administradores
test/                   testes (node --test)
```
