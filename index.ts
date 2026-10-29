// Exemplo: gera um vídeo com o Seedance 2.5 (texto → vídeo) pela API da Higgsfield.
// Executar (Node 22.18+ roda TypeScript direto): npm run higgsfield:exemplo
// Credenciais: HF_CREDENTIALS=key-id:key-secret no .env.local (fora do Git).
// Cada execução é uma geração cobrada pela Higgsfield.
import { createHiggsfieldClient, NotEnoughCreditsError, type V2Response } from '@higgsfield/client/v2';

const MODEL = 'bytedance/seedance-2.5/text-to-video';

// Lê o .env.local se existir; variáveis já definidas no ambiente têm prioridade.
try {
  process.loadEnvFile('.env.local');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

if (!process.env.HF_CREDENTIALS) {
  console.error('HF_CREDENTIALS não definida. Coloque HF_CREDENTIALS=key-id:key-secret no .env.local.');
  process.exit(1);
}

const client = createHiggsfieldClient({
  credentials: process.env.HF_CREDENTIALS,
  // Vídeos podem levar vários minutos; o padrão do SDK desiste após 5.
  maxPollTime: 20 * 60 * 1000,
  pollInterval: 5000,
});

let result: V2Response;
try {
  result = await client.subscribe(MODEL, {
    input: {
      prompt: 'A cinematic scene at sunset',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
    withPolling: true,
  });
} catch (err) {
  // Os erros do SDK não incluem as credenciais; mostra só o tipo e a mensagem.
  const { name, message } = err as Error;
  console.error(`Falha na requisição (${name}): ${message}`);
  if (err instanceof NotEnoughCreditsError) {
    console.error('O SDK chama qualquer HTTP 403 de falta de créditos: também pode ser chave sem permissão ou rede bloqueando api.higgsfield.ai.');
  }
  process.exit(1);
}

// "canceled" não está nos tipos do SDK, mas a API pode devolvê-lo.
const status: string = result.status;
switch (status) {
  case 'completed': {
    const url = result.video?.url;
    if (!url) {
      console.error(`Concluído sem URL de vídeo (request ${result.request_id}).`);
      process.exit(1);
    }
    console.log(url);
    break;
  }
  case 'nsfw':
    console.error(`Barrado pela moderação; créditos devolvidos (request ${result.request_id}).`);
    process.exit(1);
  case 'failed':
    console.error(`A geração falhou; créditos devolvidos (request ${result.request_id}).`);
    process.exit(1);
  case 'canceled':
    console.error(`A geração foi cancelada (request ${result.request_id}).`);
    process.exit(1);
  default:
    console.error(`Status inesperado "${status}" (request ${result.request_id}).`);
    process.exit(1);
}
