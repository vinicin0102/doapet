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
    // Dados do recebedor usados no quadro de doações (QR Code / Pix Copia e Cola).
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
