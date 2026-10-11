export const IMAGE_BODY_BYTES = 16 * 1024;
export const IMAGE_REPLY_BYTES = 8 * 1024 * 1024;
export const IMAGE_RESERVED_TOKENS = 80_000;
export const IMAGE_MODELS = ['sensenova-u1.5-lite'];

export function imageKeys(env) {
  try {
    const keys = JSON.parse(env.SENSENOVA_API_KEYS);
    return Array.isArray(keys) && keys.length > 0 && keys.every(key => typeof key === 'string' && key.startsWith('sk-') && key.length <= 256)
      ? [...new Set(keys)] : [];
  } catch { return []; }
}

export function validImageData(value) {
  if (typeof value !== 'string' || value.length > 5_600_000) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  try {
    const prefix = atob(match[2].slice(0, 32));
    return match[1] === 'png' ? prefix.startsWith('\x89PNG\r\n\x1a\n')
      : match[1] === 'jpeg' ? prefix.startsWith('\xff\xd8\xff')
      : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP';
  } catch { return false; }
}

export function validateImagePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !['prompt', 'turnstileToken'].includes(key))) return null;
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000) return null;
  if (typeof value.turnstileToken !== 'string' || !value.turnstileToken || value.turnstileToken.length > 2048) return null;
  return { prompt: value.prompt.trim(), turnstileToken: value.turnstileToken };
}

export async function proxyImage(payload, env, readText, actor = '') {
  const body = {
    model: env.SENSENOVA_MODEL || 'sensenova-u1.5-lite', prompt: payload.prompt,
    n: 1, size: '1024x1024', output_format: 'png', response_format: 'b64_json',
    watermark: true, prompt_extend: false,
  };
  const keys = imageKeys(env);
  if (!keys.length) throw new Error('image_upstream_unavailable');
  const start = actor ? Number.parseInt(actor.slice(0, 8), 16) % keys.length : 0;
  let rateLimited = true;
  for (let offset = 0; offset < keys.length; offset++) {
    const key = keys[(start + offset) % keys.length];
    const response = await fetch('https://token.sensenova.cn/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: 'manual',
    });
    if (!response.ok) {
      if (![401, 403, 429].includes(response.status)) throw new Error('image_upstream_unavailable');
      if (response.status !== 429) rateLimited = false;
      continue;
    }
    const result = JSON.parse(await readText(response.body, IMAGE_REPLY_BYTES));
    const base64 = result.data?.length === 1 && result.data[0]?.b64_json;
    const image = `data:image/png;base64,${base64}`;
    if (!validImageData(image)) throw new Error('image_upstream_unavailable');
    const used = result.usage?.total_tokens;
    return { image, model: body.model, usedTokens: Number.isSafeInteger(used) && used >= 0 && used <= 1_000_000 ? used : null };
  }
  throw new Error(rateLimited ? 'image_rate_limited' : 'image_upstream_unavailable');
}
