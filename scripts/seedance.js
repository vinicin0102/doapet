// Gera um vídeo com o Seedance 2.5 (texto para vídeo) pela API da Higgsfield.
// Uso: npm run seedance
// As credenciais vêm de HF_CREDENTIALS (formato key-id:key-secret) em .env.local.
// Esta chamada é cobrada pela Higgsfield.
import { higgsfield, config, APIError, HiggsfieldError } from '@higgsfield/client/v2';

try {
  process.loadEnvFile(new URL('../.env.local', import.meta.url));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

if (!process.env.HF_CREDENTIALS) {
  console.error('Defina HF_CREDENTIALS (key-id:key-secret) em .env.local.');
  process.exit(1);
}

config({
  credentials: process.env.HF_CREDENTIALS,
  // Vídeos podem levar mais que os 5 minutos padrão do SDK.
  maxPollTime: 15 * 60 * 1000,
  pollInterval: 5000,
});

try {
  const result = await higgsfield.subscribe('bytedance/seedance-2.5/text-to-video', {
    input: {
      prompt: 'A cinematic scene at sunset',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
    withPolling: true,
  });

  if (result.status === 'completed' && result.video?.url) {
    console.log(`Vídeo gerado (pedido ${result.request_id}):`);
    console.log(result.video.url);
  } else {
    const motivo = {
      completed: 'concluído, mas sem URL de vídeo na resposta',
      failed: 'a geração falhou (créditos devolvidos)',
      nsfw: 'o conteúdo foi barrado pela moderação (créditos devolvidos)',
      canceled: 'o pedido foi cancelado',
    }[result.status] ?? `status inesperado "${result.status}"`;
    console.error(`Sem vídeo para o pedido ${result.request_id}: ${motivo}.`);
    process.exitCode = 1;
  }
} catch (err) {
  // Mostra só nome, mensagem e status: o objeto de erro completo pode
  // carregar os cabeçalhos da requisição, inclusive a credencial.
  if (err instanceof HiggsfieldError) {
    const status = err instanceof APIError && err.statusCode ? ` (HTTP ${err.statusCode})` : '';
    console.error(`${err.name}${status}: ${err.message}`);
  } else {
    console.error(`Falha na requisição: ${err.name}: ${err.message}`);
  }
  process.exitCode = 1;
}
