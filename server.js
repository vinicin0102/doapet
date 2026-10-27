import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const { server, ready } = createApp(config);

server.listen(config.port, config.host, () => {
  console.log(`DoaPet rodando em http://localhost:${config.port}`);
  console.log(`Painel administrativo: http://localhost:${config.port}/admin/`);
  if (!config.databaseUrl) console.log(`Sem DATABASE_URL: usando banco local em ${config.localDataDir}`);
  if (!config.pixWebhookSecret) {
    console.log('Aviso: PIX_WEBHOOK_SECRET não definido — webhook Pix desativado.');
  }
  // Prepara o banco já na inicialização (fora da Vercel); erros aparecem no log.
  if (!config.onVercel) ready().catch((err) => console.error('Falha ao abrir o banco:', err.message));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
