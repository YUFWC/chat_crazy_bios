import { IMAGE_BODY_BYTES, IMAGE_RESERVED_TOKENS, IMAGE_MODELS, imageKeys, validateImagePayload, proxyImage } from './images.js';
import { DurableObject } from 'cloudflare:workers';
import { CHAT_MODELS, MAX_BODY_BYTES, MAX_REPLY_BYTES, MAX_OUTPUT_TOKENS, MAX_RESERVED_TOKENS, positiveInteger, quotaDecision, reserveTokens, validateChatPayload, validOrigin } from './policy.js';
import { CHAT_URL, credentialFingerprint, parseCodeArtsReply, refreshCredential, signCodeArts } from './codearts.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(value, status, origin, extra = {}) {
  const headers = { ...JSON_HEADERS, ...extra, vary: 'Origin' };
  if (origin) headers['access-control-allow-origin'] = origin;
  return new Response(JSON.stringify(value), { status, headers });
}

async function readLimitedText(body, maxBytes) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    reader.releaseLock();
  }
}

async function actorHash(ip, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function configured(env, images = false) {
  try {
    const origin = new URL(env.ALLOWED_ORIGIN);
    const credential = images ? null : JSON.parse(env.CODEARTS_CREDENTIAL_JSON);
    return Boolean(
      env.TURNSTILE_SECRET && env.QUOTA_SALT && env.QUOTA_SALT.length >= 16 &&
      (images
        ? Boolean(imageKeys(env).length && IMAGE_MODELS.includes(env.SENSENOVA_MODEL || 'sensenova-u1.5-lite'))
        : Boolean(credential.access_key && credential.secret_key &&
          (!credential.expired || (Number.isFinite(Date.parse(credential.expired)) && credential.refresh_token && credential.dpop_private_key && credential.dpop_public_key)) &&
          CHAT_MODELS.includes(env.UPSTREAM_MODEL))) &&
      origin.protocol === 'https:' && origin.origin === env.ALLOWED_ORIGIN &&
      env.ALLOWED_HOSTNAME === origin.hostname && env.TURNSTILE_ACTION &&
      positiveInteger(env.PER_IP_DAILY_REQUESTS, 0) > 0 &&
      positiveInteger(env.GLOBAL_DAILY_REQUESTS, 0) > 0 &&
      positiveInteger(env.GLOBAL_DAILY_TOKENS, 0) > 0 &&
      env.IP_BURST && env.QUOTA
    );
  } catch {
    return false;
  }
}

async function verifyTurnstile(token, ip, env) {
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip });
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true && result.hostname === env.ALLOWED_HOSTNAME && result.action === env.TURNSTILE_ACTION;
  } catch {
    return false;
  }
}

async function proxyChat(messages, pace, model, env, credential) {
  try {
    const upstreamModel = model || env.UPSTREAM_MODEL;
    const body = JSON.stringify({
      model: upstreamModel,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      // GLM 5.3 Flash rejects requests that disable thinking, even in fast mode.
      enable_thinking: upstreamModel === 'glm-5.3-flash' || pace === 'reason',
      tool_stream: false,
      stream: false,
    });
    const headers = await signCodeArts(body, credential);
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    const raw = await readLimitedText(response.body, MAX_REPLY_BYTES);
    return parseCodeArtsReply(raw);
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/status' && !url.search && request.method === 'GET') {
      const origin = request.headers.get('origin');
      if (origin && !validOrigin(origin, env.ALLOWED_ORIGIN)) return json({ error: 'forbidden' }, 403);
      return json({
        ready: configured(env),
        images: {
          ready: configured(env, true), provider: 'SenseNova',
          model: env.SENSENOVA_MODEL || 'sensenova-u1.5-lite',
          visitorRequestsPerDay: positiveInteger(env.PER_IP_DAILY_IMAGES, 10),
          siteRequestsPerDay: positiveInteger(env.GLOBAL_DAILY_IMAGES, 100),
        },
        provider: 'CodeArts',
        model: env.UPSTREAM_MODEL || null,
        models: CHAT_MODELS,
        limits: {
          visitorRequestsPerDay: positiveInteger(env.PER_IP_DAILY_REQUESTS, 100),
          siteRequestsPerDay: positiveInteger(env.GLOBAL_DAILY_REQUESTS, 1000),
          siteTokensPerDay: positiveInteger(env.GLOBAL_DAILY_TOKENS, 50_000_000),
        },
      }, 200, origin);
    }
    const isImage = url.pathname === '/api/images';
    if ((!isImage && url.pathname !== '/api/chat') || url.search) return json({ error: 'not_found' }, 404);
    const requestOrigin = request.headers.get('origin');
    if (!requestOrigin || !validOrigin(requestOrigin, env.ALLOWED_ORIGIN)) return json({ error: 'forbidden' }, 403);
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers.get('access-control-request-method');
      if (requestedMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405, requestOrigin);
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': requestOrigin,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type',
          'access-control-max-age': '600',
          vary: 'Origin',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, requestOrigin);
    if (!configured(env, isImage)) return json({ error: 'configuration_incomplete' }, 503, requestOrigin);

    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || ip.length > 64) return json({ error: 'visitor_ip_unavailable' }, 403, requestOrigin);
    const actor = await actorHash(ip, env.QUOTA_SALT);
    try {
      const burst = await env.IP_BURST.limit({ key: actor });
      if (!burst.success) return json({ error: 'rate_limited' }, 429, requestOrigin, { 'retry-after': '60' });
    } catch {
      return json({ error: 'rate_limit_unavailable' }, 503, requestOrigin);
    }

    const bodyLimit = isImage ? IMAGE_BODY_BYTES : MAX_BODY_BYTES;
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > bodyLimit) return json({ error: 'body_too_large' }, 413, requestOrigin);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'invalid_json' }, 400, requestOrigin);
    let payload;
    try {
      payload = (isImage ? validateImagePayload : validateChatPayload)(JSON.parse(await readLimitedText(request.body, bodyLimit)));
    } catch (error) {
      return json({ error: error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' }, error.message === 'body_too_large' ? 413 : 400, requestOrigin);
    }
    if (!payload) return json({ error: 'invalid_request' }, 400, requestOrigin);
    if (!(await verifyTurnstile(payload.turnstileToken, ip, env))) return json({ error: 'verification_failed' }, 403, requestOrigin);

    const reservationId = crypto.randomUUID();
    const reservedTokens = isImage ? IMAGE_RESERVED_TOKENS : reserveTokens(payload.messages);
    if (reservedTokens > MAX_RESERVED_TOKENS) return json({ error: 'request_too_large' }, 413, requestOrigin);
    let quota;
    let quotaStub;
    let chatCredential;
    try {
      const id = env.QUOTA.idFromName('global-budget');
      quotaStub = env.QUOTA.get(id);
      if (!isImage) {
        const credentialResponse = await quotaStub.fetch('https://quota.internal/credential', { method: 'POST' });
        if (!credentialResponse.ok) return json({ error: 'credential_unavailable' }, 503, requestOrigin);
        chatCredential = await credentialResponse.json();
      }
      const response = await quotaStub.fetch('https://quota.internal/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor, reservationId, reservedTokens, kind: isImage ? 'image' : 'chat' }),
      });
      quota = await response.json();
      if (!response.ok && response.status !== 429) throw new Error('quota_unavailable');
      if (!quota || typeof quota.allowed !== 'boolean') throw new Error('quota_unavailable');
    } catch {
      return json({ error: 'quota_unavailable' }, 503, requestOrigin);
    }
    if (!quota.allowed) {
      const seconds = Math.max(1, Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1000));
      return json({ error: quota.reason || 'daily_limit', resetAt: quota.resetAt }, 429, requestOrigin, { 'retry-after': String(seconds) });
    }

    let result;
    try {
      result = isImage ? await proxyImage(payload, env, readLimitedText, actor) : await proxyChat(payload.messages, payload.pace, payload.model, env, chatCredential);
    } catch (error) {
      const limited = error.message === 'image_rate_limited';
      return json({ error: limited ? 'image_rate_limited' : 'image_upstream_unavailable' }, limited ? 429 : 502, requestOrigin);
    }
    if (result === null) return json({ error: 'upstream_unavailable' }, 502, requestOrigin);
    if (result.usedTokens !== null) {
      try {
        await quotaStub.fetch('https://quota.internal/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reservationId, usedTokens: result.usedTokens }),
        });
      } catch {
        // The conservative reservation remains charged if settlement fails.
      }
    }
    return json({ ...(isImage ? { image: result.image, model: result.model } : { reply: result.reply }), usage: result.usedTokens === null ? null : { total_tokens: result.usedTokens } }, 200, requestOrigin);
  },
};

export class Quota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, actor TEXT NOT NULL, requests INTEGER NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (day, actor))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved_tokens INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/credential' && request.method === 'POST') {
      try {
        if (!this.credentialPromise) {
          this.credentialPromise = this.getCredential().finally(() => { this.credentialPromise = null; });
        }
        return json(await this.credentialPromise, 200);
      } catch {
        return json({ error: 'credential_unavailable' }, 503);
      }
    }
    if (!['/reserve', '/settle'].includes(path) || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: 'invalid_request' }, 400);
    }
    if (!/^[0-9a-f-]{36}$/.test(input?.reservationId || '')) return json({ error: 'invalid_request' }, 400);
    if (path === '/settle') {
      if (!Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 || input.usedTokens > 1_000_000) return json({ error: 'invalid_request' }, 400);
      try {
        const outcome = this.ctx.storage.transactionSync(() => {
          const row = this.ctx.storage.sql.exec('SELECT day, reserved_tokens, settled FROM reservations WHERE id = ?', input.reservationId).toArray()[0];
          if (!row) return 'missing';
          if (row.settled) return 'already_settled';
          this.ctx.storage.sql.exec('UPDATE daily SET tokens = tokens + ? WHERE day = ? AND actor = ?', input.usedTokens - row.reserved_tokens, row.day, '@global');
          this.ctx.storage.sql.exec('UPDATE reservations SET settled = 1 WHERE id = ?', input.reservationId);
          return 'settled';
        });
        return json({ outcome }, outcome === 'missing' ? 404 : 200);
      } catch {
        return json({ error: 'quota_unavailable' }, 503);
      }
    }

    if (!/^[a-f0-9]{64}$/.test(input?.actor || '') || !Number.isSafeInteger(input?.reservedTokens) || input.reservedTokens < 1 || input.reservedTokens > MAX_RESERVED_TOKENS) return json({ error: 'invalid_request' }, 400);
    if (input.kind !== undefined && input.kind !== 'chat' && input.kind !== 'image') return json({ error: 'invalid_request' }, 400);
    const isImage = input.kind === 'image';
    const actorLimit = positiveInteger(this.env.PER_IP_DAILY_REQUESTS, 100);
    const globalLimit = positiveInteger(this.env.GLOBAL_DAILY_REQUESTS, 1000);
    const tokenLimit = positiveInteger(this.env.GLOBAL_DAILY_TOKENS, 50_000_000);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    try {
      const decision = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM daily WHERE day < ?', day);
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE day < ?', day);
        if (isImage) {
          const visitorImages = this.ctx.storage.sql.exec('SELECT requests FROM daily WHERE day = ? AND actor = ?', day, `image:${input.actor}`).toArray()[0]?.requests ?? 0;
          const siteImages = this.ctx.storage.sql.exec('SELECT requests FROM daily WHERE day = ? AND actor = ?', day, '@images').toArray()[0]?.requests ?? 0;
          if (visitorImages >= positiveInteger(this.env.PER_IP_DAILY_IMAGES, 10)) return 'image_actor_limit';
          if (siteImages >= positiveInteger(this.env.GLOBAL_DAILY_IMAGES, 100)) return 'image_global_limit';
        }
        const actorUsed = this.ctx.storage.sql.exec('SELECT requests FROM daily WHERE day = ? AND actor = ?', day, input.actor).toArray()[0]?.requests ?? 0;
        const globalRow = this.ctx.storage.sql.exec('SELECT requests, tokens FROM daily WHERE day = ? AND actor = ?', day, '@global').toArray()[0];
        const result = quotaDecision(actorUsed, globalRow?.requests ?? 0, globalRow?.tokens ?? 0, input.reservedTokens, actorLimit, globalLimit, tokenLimit);
        if (result !== 'allow') return result;
        this.ctx.storage.sql.exec('INSERT INTO daily (day, actor, requests, tokens) VALUES (?, ?, 1, 0) ON CONFLICT(day, actor) DO UPDATE SET requests = requests + 1', day, input.actor);
        this.ctx.storage.sql.exec('INSERT INTO daily (day, actor, requests, tokens) VALUES (?, ?, 1, ?) ON CONFLICT(day, actor) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens', day, '@global', input.reservedTokens);
        if (isImage) {
          for (const key of [`image:${input.actor}`, '@images']) this.ctx.storage.sql.exec('INSERT INTO daily (day, actor, requests, tokens) VALUES (?, ?, 1, 0) ON CONFLICT(day, actor) DO UPDATE SET requests = requests + 1', day, key);
        }
        this.ctx.storage.sql.exec('INSERT INTO reservations (id, day, reserved_tokens) VALUES (?, ?, ?)', input.reservationId, day, input.reservedTokens);
        return result;
      });
      return decision === 'allow'
        ? json({ allowed: true, resetAt, reservedTokens: input.reservedTokens }, 200)
        : json({ allowed: false, reason: decision, resetAt }, decision === 'invalid' ? 500 : 429);
    } catch {
      return json({ error: 'quota_unavailable' }, 503);
    }
  }

  async getCredential() {
    const source = this.env.CODEARTS_CREDENTIAL_JSON;
    const seedId = await credentialFingerprint(source);
    let stored = await this.ctx.storage.get('codearts_credential');
    if (!stored || stored.seedId !== seedId) {
      const initial = JSON.parse(source);
      stored = { seedId, credential: {
        access_key: initial.access_key,
        secret_key: initial.secret_key,
        security_token: initial.security_token || '',
        refresh_token: initial.refresh_token || '',
        expired: initial.expired || '',
        code_verifier: initial.code_verifier || '',
        user_id: initial.user_id || '',
      } };
      await this.ctx.storage.put('codearts_credential', stored);
    }
    let credential = stored.credential;
    if (credential.expired && Date.parse(credential.expired) - Date.now() <= 300_000) {
      if (!credential.refresh_token) throw new Error('refresh_unavailable');
      const initial = JSON.parse(source);
      credential = await refreshCredential(
        credential,
        JSON.parse(initial.dpop_private_key),
        JSON.parse(initial.dpop_public_key),
      );
      await this.ctx.storage.put('codearts_credential', { seedId, credential });
    }
    if (credential.expired && Date.parse(credential.expired) <= Date.now()) throw new Error('credential_expired');
    return credential;
  }

}

