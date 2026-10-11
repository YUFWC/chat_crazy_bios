export const MAX_BODY_BYTES = 65_536;
export const MAX_REPLY_BYTES = 1_048_576;
export const MAX_OUTPUT_TOKENS = 4_096;
export const MAX_RESERVED_TOKENS = 80_000;
export const CHAT_MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];

export function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function validateChatPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'messages' && key !== 'turnstileToken' && key !== 'pace' && key !== 'model')) return null;
  if (typeof value.turnstileToken !== 'string' || value.turnstileToken.length < 1 || value.turnstileToken.length > 2048) return null;
  if (value.pace !== undefined && value.pace !== 'fast' && value.pace !== 'reason') return null;
  if (value.model !== undefined && !CHAT_MODELS.includes(value.model)) return null;
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 24) return null;
  let total = 0;
  const messages = [];
  for (const item of value.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (Object.keys(item).some((key) => key !== 'role' && key !== 'content')) return null;
    if (item.role !== 'user' && item.role !== 'assistant') return null;
    if (typeof item.content !== 'string' || item.content.trim().length === 0 || item.content.length > 16_000) return null;
    total += item.content.length;
    if (total > 48_000) return null;
    messages.push({ role: item.role, content: item.content });
  }
  if (messages.at(-1).role !== 'user') return null;
  return { messages, turnstileToken: value.turnstileToken, pace: value.pace || 'fast', ...(value.model ? { model: value.model } : {}) };
}

export function reserveTokens(messages) {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  return bytes + 2_048 + MAX_OUTPUT_TOKENS;
}

export function quotaDecision(actorRequests, globalRequests, globalTokens, reservation, actorLimit, globalLimit, tokenLimit) {
  const args = [actorRequests, globalRequests, globalTokens, reservation, actorLimit, globalLimit, tokenLimit];
  if (!args.every((n) => Number.isSafeInteger(n) && n >= 0)) return 'invalid';
  if (reservation < 1 || reservation > MAX_RESERVED_TOKENS || actorLimit < 1 || globalLimit < 1 || tokenLimit < 1) return 'invalid';
  if (actorRequests + 1 > actorLimit) return 'actor_limit';
  if (globalRequests + 1 > globalLimit) return 'global_limit';
  if (globalTokens + reservation > tokenLimit) return 'token_limit';
  return 'allow';
}

export function validOrigin(origin, allowedOrigin) {
  try {
    const given = new URL(origin);
    const allowed = new URL(allowedOrigin);
    return given.origin === allowed.origin && origin === given.origin && allowedOrigin === allowed.origin;
  } catch {
    return false;
  }
}
