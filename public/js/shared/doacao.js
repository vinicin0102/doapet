// Valores pré-definidos do quadro de doações (em reais) e validação dos dados
// do doador. Usado pelo servidor e pela página, para que nunca fiquem diferentes.

export const DONATION_PRESETS = [5, 10, 15, 25, 30, 50, 100];

// Valor destacado como "Mais escolhido" e já selecionado ao abrir a página.
export const MOST_CHOSEN = 50;

const digits = (v) => String(v ?? '').replace(/\D+/g, '');

/** CPF com dígitos verificadores válidos (rejeita sequências como 111.111.111-11). */
export function isValidCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(cpf[len])) return false;
  }
  return true;
}

/**
 * Valida e normaliza os dados do doador exigidos pelo processador de pagamentos.
 * Com emailOptional, o e-mail pode ficar vazio (não é enviado à ZuckPay).
 * Retorna { dados } ou { erros: { campo: mensagem } }.
 */
export function validateDonor(input = {}, { emailOptional = false } = {}) {
  const erros = {};
  const nome = String(input.nome ?? '').replace(/\s+/g, ' ').trim();
  const cpf = digits(input.cpf);
  const email = String(input.email ?? '').trim().toLowerCase();
  let telefone = digits(input.telefone);
  if (telefone.length === 13 && telefone.startsWith('55')) telefone = telefone.slice(2);

  if (nome.length < 3 || nome.length > 120) erros.nome = 'Informe o nome.';
  if (!isValidCpf(cpf)) erros.cpf = 'CPF inválido.';
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 160;
  if (!emailOk && !(emailOptional && email === '')) erros.email = 'E-mail inválido.';
  if (telefone.length < 10 || telefone.length > 11) erros.telefone = 'Informe o celular com DDD.';

  return Object.keys(erros).length ? { erros } : { dados: { nome, cpf, email, telefone } };
}
