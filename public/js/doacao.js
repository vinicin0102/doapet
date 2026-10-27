// Quadro de doações com valores pré-definidos. Ao escolher um valor, o servidor
// gera o QR Code e o "Pix Copia e Cola" com o valor já preenchido. Com a ZuckPay,
// a página acompanha o pagamento e avisa quando ele é confirmado.
import { DONATION_PRESETS, MOST_CHOSEN, validateDonor } from './shared/doacao.js';

const $ = (id) => document.getElementById(id);
const form = $('form-doacao');
const grid = $('opcoes-doacao');
const donorBox = $('dados-doador');
const button = $('botao-doar');
const message = $('mensagem-doacao');
const payment = $('pagamento-pix');
const qr = $('qr-pix');
const code = $('copia-cola');
const copyButton = $('botao-copiar');
const paymentTitle = $('titulo-pagamento');
const paymentStatus = $('status-pagamento');
const confirmed = $('pagamento-confirmado');

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60_000;

const brl = (reais) => reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlShort = (reais) => `R$ ${reais.toLocaleString('pt-BR')}`;

let provider = null; // 'zuckpay' | 'pix' | null
let pollTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderOptions() {
  grid.replaceChildren(
    ...DONATION_PRESETS.map((valor) => {
      const destaque = valor === MOST_CHOSEN;
      const label = el('label', `valor-doacao${destaque ? ' valor-doacao--destaque' : ''}`);
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'valor';
      input.value = String(valor);
      input.checked = destaque;
      label.appendChild(input);
      if (destaque) label.appendChild(el('span', 'valor-doacao__selo', 'Mais escolhido'));
      label.appendChild(el('span', 'valor-doacao__valor', brlShort(valor)));
      return label;
    }),
  );
}

const selectedValue = () => Number(form.querySelector('input[name=valor]:checked')?.value);

function updateButton() {
  button.textContent = `Doar ${brl(selectedValue())} via Pix`;
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `mensagem-doacao${type ? ` mensagem-doacao--${type}` : ''}`;
}

function showFieldErrors(errors = {}) {
  for (const small of donorBox.querySelectorAll('[data-erro]')) {
    const field = small.dataset.erro;
    small.textContent = errors[field] ?? '';
    form.elements[field].setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
  }
  const first = Object.keys(errors)[0];
  if (first) form.elements[first].focus();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function resetPayment() {
  stopPolling();
  payment.hidden = true;
  confirmed.hidden = true;
  paymentStatus.hidden = true;
}

// Máscaras simples para CPF e celular enquanto o doador digita.
function mask(input, format) {
  input.addEventListener('input', () => {
    input.value = format(input.value.replace(/\D+/g, ''));
  });
}
mask(form.elements.cpf, (d) =>
  d
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2'),
);
mask(form.elements.telefone, (d) => {
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
});

form.addEventListener('change', (e) => {
  if (e.target.name !== 'valor') return;
  updateButton();
  // Trocar de valor esconde o Pix anterior para não pagar o valor errado.
  resetPayment();
  setMessage('');
});

/** Consulta o status até o pagamento ser confirmado (ou desistir após 30 minutos). */
function pollStatus(id, valor, startedAt = Date.now()) {
  pollTimer = setTimeout(async () => {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      paymentStatus.hidden = true;
      return;
    }
    try {
      const res = await fetch(`/api/doacoes/status?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'confirmada') {
        stopPolling();
        payment.hidden = true;
        $('titulo-confirmado').textContent = `Pagamento de ${brl(valor)} confirmado!`;
        confirmed.hidden = false;
        confirmed.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // Atualiza a barra de progresso desta página na hora.
        if ('BroadcastChannel' in window) new BroadcastChannel('doapet-campanha').postMessage('atualizado');
        return;
      }
    } catch {
      /* falha temporária: tenta de novo */
    }
    pollStatus(id, valor, startedAt);
  }, POLL_INTERVAL_MS);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const valor = selectedValue();
  const body = { valor };

  if (provider === 'zuckpay') {
    const donor = {
      nome: form.elements.nome.value,
      cpf: form.elements.cpf.value,
      email: form.elements.email.value,
      telefone: form.elements.telefone.value,
    };
    const { erros } = validateDonor(donor);
    showFieldErrors(erros);
    if (erros) {
      setMessage('Confira os dados destacados.', 'erro');
      return;
    }
    Object.assign(body, donor);
  }

  resetPayment();
  button.disabled = true;
  setMessage('Gerando seu Pix…');
  try {
    const res = await fetch('/api/doacoes/pix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.campos) showFieldErrors(data.campos);
      throw new Error(data.erro || 'Não foi possível gerar o Pix agora. Tente novamente.');
    }
    qr.src = data.qrCode;
    code.value = data.copiaECola;
    paymentTitle.textContent = `Pix de ${brl(data.valor)}`;
    payment.hidden = false;
    setMessage('');
    if (data.id) {
      paymentStatus.hidden = false;
      pollStatus(data.id, data.valor);
    }
    payment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    setMessage(err.message, 'erro');
  } finally {
    button.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(code.value);
  } catch {
    code.select();
    document.execCommand('copy');
  }
  copyButton.textContent = 'Código copiado!';
  setTimeout(() => (copyButton.textContent = 'Copiar código Pix'), 2500);
});

$('botao-nova-doacao').addEventListener('click', () => {
  resetPayment();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

renderOptions();
updateButton();

// Descobre se as doações passam pela ZuckPay (que pede os dados do doador).
fetch('/api/doacoes/config', { cache: 'no-store' })
  .then((r) => r.json())
  .then((cfg) => {
    provider = cfg.provedor;
    donorBox.hidden = provider !== 'zuckpay';
  })
  .catch(() => {});
