// Quadro de doações com valores pré-definidos. Ao escolher um valor, o servidor
// gera o QR Code e o "Pix Copia e Cola" com o valor já preenchido.
import { DONATION_PRESETS, MOST_CHOSEN } from './shared/doacao.js';

const form = document.getElementById('form-doacao');
const grid = document.getElementById('opcoes-doacao');
const button = document.getElementById('botao-doar');
const message = document.getElementById('mensagem-doacao');
const payment = document.getElementById('pagamento-pix');
const qr = document.getElementById('qr-pix');
const code = document.getElementById('copia-cola');
const copyButton = document.getElementById('botao-copiar');
const paymentTitle = document.getElementById('titulo-pagamento');

const brl = (reais) => reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlShort = (reais) => `R$ ${reais.toLocaleString('pt-BR')}`;

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

form.addEventListener('change', () => {
  updateButton();
  // Trocar de valor esconde o Pix anterior para não pagar o valor errado.
  payment.hidden = true;
  setMessage('');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const valor = selectedValue();
  button.disabled = true;
  setMessage('Gerando seu Pix…');
  try {
    const res = await fetch('/api/doacoes/pix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ valor }),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || 'Não foi possível gerar o Pix agora. Tente novamente.');
    qr.src = data.qrCode;
    code.value = data.copiaECola;
    paymentTitle.textContent = `Pix de ${brl(data.valor)}`;
    payment.hidden = false;
    setMessage('');
    payment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    payment.hidden = true;
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

renderOptions();
updateButton();
