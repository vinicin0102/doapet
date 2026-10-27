# DoaPet — Barra de progresso editável da campanha

Site da Nossa ONG com uma **barra de progresso da meta de arrecadação** (R$ 5.000,00 para a compra de ração para mais de 10 mil animais resgatados) e um **painel administrativo** para gerenciar a meta e o valor arrecadado, sem precisar alterar o código do site.

- Node.js ≥ 22.13, **sem dependências externas** (`node:http` + `node:sqlite`).
- Os dados ficam em um banco SQLite (`data/doapet.db` por padrão).

## Como rodar

```bash
cp .env.example .env          # ajuste os valores
# crie o primeiro administrador (a senha é pedida no terminal)
npm run criar-admin -- maria
npm start                     # http://localhost:3000
```

- Página pública: `http://localhost:3000/`
- Painel administrativo: `http://localhost:3000/admin/`

Em desenvolvimento local (sem HTTPS), use `npm run dev`. Os testes rodam com `npm test`.

> Variáveis de ambiente não são lidas automaticamente do `.env`. Exporte-as no ambiente do servidor ou rode `node --env-file=.env --disable-warning=ExperimentalWarning server.js`.

## Exibição pública

A seção "Campanha da Ração" da página inicial mostra:

- **Meta**: "Nossa meta é R$ 5.000,00"
- **Valor arrecadado**: "R$ 1.750,00 arrecadados de R$ 5.000,00"
- **Barra visual**, preenchida proporcionalmente (sempre entre 0% e 100%)
- **Percentual atingido**, calculado automaticamente: "35% da meta alcançada!"
- **Quanto falta**, nunca menor que zero: "Faltam R$ 3.250,00 para atingir nossa meta."

Quando a arrecadação passa da meta, a página mostra o valor real e a mensagem **"Meta atingida!"**, e a barra fica limitada a 100%.

A barra é atualizada **na hora** (Server-Sent Events) sempre que o administrador salva ou um Pix é confirmado, sem precisar recarregar a página.

### Usar a barra em outro site da ONG

```html
<link rel="stylesheet" href="https://SEU-DOMINIO/css/barra-meta.css" />
<div data-meta-campanha></div>
<script src="https://SEU-DOMINIO/js/barra-meta.js" defer></script>
```

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
- O login é bloqueado por 15 minutos após 5 tentativas erradas.
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
src/progress.js         cálculo do percentual/barra (compartilhado com o navegador)
src/money.js            conversão e validação de valores em R$ (compartilhado com o navegador)
src/pix.js              verificação e normalização do webhook Pix
src/auth.js             administradores, senhas, sessões, limite de login
src/db.js               esquema SQLite
public/index.html       página inicial da ONG
public/js/barra-meta.js widget da barra de progresso
public/admin/           painel administrativo
scripts/create-admin.js criação de administradores
test/                   testes (node --test)
```
