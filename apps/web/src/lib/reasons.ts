/**
 * The server keeps triage and safety reasons as stable English codes (they
 * key stats and tests); these are the words the studio shows for them.
 */
const RULES: Record<string, string> = {
  empty: "mensagem vazia",
  "too long": "mensagem longa demais",
  noise: "spam de letras",
  "link or contact info": "link ou contato",
  "prompt injection": "tentativa de manipular o apresentador",
  "blocked term": "palavra bloqueada",
};

const SKIPPED: Record<string, string> = {
  ...RULES,
  "repeated message": "mensagem repetida",
  flooding: "mandando mensagens rápido demais",
  "duplicate of queued message": "já está na fila para resposta",
};

const BLOCKED: Record<string, string> = {
  ...RULES,
  "moderator unavailable": "moderação indisponível",
  "moderator declined to review": "a moderação recusou revisar",
};

/** Why a chat message was skipped. Unknown codes show as they are. */
export function skipReason(code: string): string {
  return SKIPPED[code] ?? code;
}

/** Why a host line was blocked: a rule code, or the moderator's own words. */
export function blockReason(reason: string): string {
  return BLOCKED[reason] ?? reason;
}
