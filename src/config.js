import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  return {
    root,
    onVercel,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    // Postgres de produção (a integração Neon da Vercel cria DATABASE_URL e POSTGRES_URL).
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
    // Sem DATABASE_URL (desenvolvimento local), os dados ficam no PGlite nesta pasta.
    localDataDir: env.LOCAL_DATA_DIR || path.join(root, 'data', 'pglite'),
    publicDir: path.join(root, 'public'),
    // Meta inicial usada apenas na primeira execução (depois é editada pelo painel).
    initialGoal: env.CAMPAIGN_GOAL || '5000,00',
    // Segredo compartilhado com o provedor Pix para assinar os webhooks (HMAC-SHA256).
    // Sem ele, o webhook fica desativado e nenhuma doação é registrada automaticamente.
    pixWebhookSecret: env.PIX_WEBHOOK_SECRET || '',
    // Processador de pagamentos ZuckPay (credenciais em Desenvolvedores > Credenciais API).
    // Quando configurado, o quadro de doações cria cobranças Pix pela ZuckPay e os
    // pagamentos confirmados entram na campanha automaticamente.
    zuckpay:
      env.ZUCKPAY_CLIENT_ID && env.ZUCKPAY_CLIENT_SECRET
        ? {
            clientId: env.ZUCKPAY_CLIENT_ID.trim(),
            clientSecret: env.ZUCKPAY_CLIENT_SECRET.trim(),
            webhookSecret: (env.ZUCKPAY_WEBHOOK_SECRET || '').trim(),
            baseUrl: env.ZUCKPAY_BASE_URL || undefined,
            // Dados fixos do pagador usados em TODAS as cobranças (a API exige nome,
            // CPF, e-mail e telefone; o doador não precisa informar nada).
            payer: {
              nome: env.ZUCKPAY_PAGADOR_NOME || '',
              cpf: env.ZUCKPAY_PAGADOR_CPF || '',
              email: env.ZUCKPAY_PAGADOR_EMAIL || '',
              telefone: env.ZUCKPAY_PAGADOR_TELEFONE || '',
            },
          }
        : null,
    // Endereço público do site (para a ZuckPay avisar os pagamentos). Na Vercel é detectado sozinho.
    siteUrl: (
      env.SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
    ).replace(/\/+$/, ''),
    // Vercel Blob (imagens e vídeos da página). Criado ao conectar um Blob Store ao projeto.
    blobToken: env.BLOB_READ_WRITE_TOKEN || '',
    // Pix estático (sem processador): dados do recebedor usados no quadro de doações (QR Code / Pix Copia e Cola).
    // Sem a chave, o quadro aparece mas informa que o Pix ainda não está disponível.
    pixReceiver: env.PIX_CHAVE
      ? { key: env.PIX_CHAVE, name: env.PIX_NOME_RECEBEDOR || '', city: env.PIX_CIDADE || '' }
      : null,
    // Cookies "Secure" (somente HTTPS). Desative apenas em desenvolvimento local.
    secureCookies: env.SECURE_COOKIES !== 'false' && (onVercel || env.NODE_ENV === 'production'),
    // Confiar no cabeçalho X-Forwarded-For (a Vercel sempre o define com o IP real).
    trustProxy: onVercel || env.TRUST_PROXY === 'true',
    sessionHours: Number(env.SESSION_HOURS || 8),
    bootstrapAdmin:
      env.ADMIN_USERNAME && env.ADMIN_PASSWORD
        ? { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }
        : null,
  };
}
