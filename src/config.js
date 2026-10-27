import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  return {
    root,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DATABASE_PATH || path.join(root, 'data', 'doapet.db'),
    publicDir: path.join(root, 'public'),
    // Meta inicial usada apenas na primeira execução (depois é editada pelo painel).
    initialGoal: env.CAMPAIGN_GOAL || '5000,00',
    // Segredo compartilhado com o provedor Pix para assinar os webhooks (HMAC-SHA256).
    // Sem ele, o webhook fica desativado e nenhuma doação é registrada automaticamente.
    pixWebhookSecret: env.PIX_WEBHOOK_SECRET || '',
    // Cookies "Secure" (somente HTTPS). Desative apenas em desenvolvimento local.
    secureCookies: env.SECURE_COOKIES !== 'false' && env.NODE_ENV === 'production',
    // Confiar no cabeçalho X-Forwarded-For (quando atrás de proxy reverso).
    trustProxy: env.TRUST_PROXY === 'true',
    sessionHours: Number(env.SESSION_HOURS || 8),
    bootstrapAdmin:
      env.ADMIN_USERNAME && env.ADMIN_PASSWORD
        ? { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }
        : null,
  };
}
