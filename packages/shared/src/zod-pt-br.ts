import { z } from "zod";

/**
 * Zod's messages in Brazilian Portuguese, for the issues people actually hit
 * in forms. Schemas with their own message keep it. Installed once, on import
 * of the shared package, so the server and the dashboard say the same thing.
 */
function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("pt-BR")} ${count === 1 ? one : many}`;
}

export const ptBR: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") return min <= 1 ? "Não pode ficar vazio." : `Escreva pelo menos ${plural(min, "caractere", "caracteres")}.`;
      if (issue.origin === "array" || issue.origin === "set") return min <= 1 ? "Adicione pelo menos um." : `Adicione pelo menos ${min}.`;
      return `Use um número a partir de ${min.toLocaleString("pt-BR")}.`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return `Use no máximo ${plural(max, "caractere", "caracteres")}.`;
      if (issue.origin === "array" || issue.origin === "set") return `No máximo ${plural(max, "item", "itens")}.`;
      return `Use um número até ${max.toLocaleString("pt-BR")}.`;
    }
    case "invalid_type":
      return issue.input === undefined ? "Campo obrigatório." : issue.expected === "number" ? "Use um número." : "Valor inválido.";
    case "invalid_value":
      return "Escolha uma das opções.";
    case "invalid_format":
      if (issue.format === "email") return "Esse e-mail não parece válido.";
      if (issue.format === "url") return "Esse link não parece válido.";
      return "Formato inválido.";
    case "not_multiple_of":
      return "Use um número inteiro.";
    case "unrecognized_keys":
      return "Há campos que não reconhecemos.";
    default:
      return undefined;
  }
};

z.config({ customError: ptBR });
