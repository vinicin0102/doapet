// Cálculo do progresso da campanha. Função pura, sem acesso a banco.

export const MODES = ['automatico', 'manual', 'hibrido'];

/**
 * Valor arrecadado conforme o modo de gerenciamento:
 *  - automatico: somente doações Pix confirmadas pelo provedor
 *  - manual:     total informado pelo administrador
 *  - hibrido:    Pix confirmados + contribuições externas registradas
 */
export function raisedForMode(mode, { pixCents, manualCents, externalCents }) {
  switch (mode) {
    case 'automatico':
      return pixCents;
    case 'manual':
      return manualCents;
    case 'hibrido':
      return pixCents + externalCents;
    default:
      throw new Error(`Modo desconhecido: ${mode}`);
  }
}

/**
 * Calcula os números exibidos na barra. Garante:
 *  - "falta" nunca é negativo;
 *  - percentual nunca é negativo;
 *  - preenchimento visual (barPercent) fica sempre entre 0 e 100.
 * O percentual é arredondado PARA BAIXO com 1 casa decimal, para nunca exibir
 * 100% antes de a meta realmente ser atingida.
 */
export function computeProgress(goalCents, raisedCents) {
  const goal = Math.max(0, Math.trunc(goalCents) || 0);
  const raised = Math.max(0, Math.trunc(raisedCents) || 0);
  const remaining = Math.max(0, goal - raised);
  const percent = goal > 0 ? Math.floor((raised * 1000) / goal) / 10 : 0;
  const barPercent = Math.min(100, Math.max(0, percent));
  return {
    goalCents: goal,
    raisedCents: raised,
    remainingCents: remaining,
    percent,
    barPercent,
    goalReached: goal > 0 && raised >= goal,
  };
}
