import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const { server } = createApp(config);

server.listen(config.port, config.host, () => {
  console.log(`DoaPet rodando em http://localhost:${config.port}`);
  console.log(`Painel administrativo: http://localhost:${config.port}/admin/`);
  if (!config.pixWebhookSecret) {
    console.log('Aviso: PIX_WEBHOOK_SECRET não definido — webhook Pix desativado.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
