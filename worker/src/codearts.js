const encoder = new TextEncoder();
export const CHAT_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions';
const STS_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}

export async function credentialFingerprint(value) {
  return sha256(value);
}

export async function signCodeArts(body, credential, date = new Date()) {
  const sdkDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const host = new URL(CHAT_URL).host;
  const signEntries = [['host', host], ['x-sdk-date', sdkDate]];
  if (credential.security_token) signEntries.push(['x-security-token', credential.security_token]);
  const signedHeaders = signEntries.map(([key]) => key).join(';');
  const canonicalHeaders = signEntries.map(([key, value]) => `${key}:${value.trim()}\n`).join('');
  const canonicalRequest = ['POST', '/api/v2/chat/completions/', '', canonicalHeaders, signedHeaders, await sha256(body)].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', sdkDate, await sha256(canonicalRequest)].join('\n');
  const key = await crypto.subtle.importKey('raw', encoder.encode(credential.secret_key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign)));
  return {
    'X-Sdk-Date': sdkDate,
    ...(credential.security_token ? { 'X-Security-Token': credential.security_token, 'x-auth-token': credential.security_token } : {}),
    Authorization: `SDK-HMAC-SHA256 Access=${credential.access_key}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    maas_type: 'benefit',
    'user-session-id': (await sha256(`${credential.user_id || ''}|${credential.access_key}`)).slice(0, 16),
  };
}

function base64url(input) {
  const bytes = input instanceof Uint8Array ? input : encoder.encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function dpopProof(privateJwk, publicJwk, date = new Date()) {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk };
  const payload = { htm: 'POST', htu: STS_URL, iat: Math.floor(date.getTime() / 1000), jti: crypto.randomUUID().replace(/-/g, '') };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(input)));
  if (signature.length !== 64) throw new Error('invalid_dpop_signature');
  return `${input}.${base64url(signature)}`;
}

export async function refreshCredential(credential, privateJwk, publicJwk) {
  const body = new URLSearchParams({ client_id: 'codearts', code_verifier: credential.code_verifier || '', grant_type: 'refresh_token', refresh_token: credential.refresh_token });
  const proof = await dpopProof(privateJwk, publicJwk);
  const response = await fetch(STS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', DPoP: proof }, body, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('codearts_refresh_failed');
  const data = await response.json();
  const creds = data?.credentials;
  if (!creds?.access_key_id || !creds?.secret_access_key || !creds?.expiration) throw new Error('codearts_refresh_invalid');
  return {
    ...credential,
    access_key: creds.access_key_id,
    secret_key: creds.secret_access_key,
    security_token: creds.security_token || '',
    refresh_token: data.refresh_token || credential.refresh_token,
    expired: creds.expiration,
  };
}

export function parseCodeArtsReply(raw) {
  let data;
  try { data = JSON.parse(raw); } catch {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const fragment = line.slice(5).trim();
      if (!fragment || fragment === '[DONE]') continue;
      try { data = JSON.parse(fragment); } catch { /* Ignore incomplete SSE events. */ }
    }
  }
  const content = data?.choices?.[0]?.message?.content;
  const reported = data?.usage?.total_tokens;
  return typeof content === 'string' && content.length > 0
    ? { reply: content, usedTokens: Number.isSafeInteger(reported) && reported >= 0 ? reported : null }
    : null;
}
