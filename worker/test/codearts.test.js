import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialFingerprint, parseCodeArtsReply, refreshCredential, signCodeArts } from '../src/codearts.js';

test('CodeArts SDK signature matches the local gateway', async () => {
  const signed = await signCodeArts('abc', {
    access_key: 'AKTEST', secret_key: 'SKTEST', security_token: 'STTEST',
  }, new Date('2026-01-02T03:04:05Z'));
  assert.equal(signed.Authorization,
    'SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=host;x-sdk-date;x-security-token, Signature=5fb448845c157ffc102d4ca55e30301cc81b3c8c7dfb3e64455a348bccbdf093');
  assert.equal(signed.maas_type, 'benefit');
  assert.equal((await credentialFingerprint('same')).length, 64);
});

test('refresh rotates temporary CodeArts credentials', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens');
    assert.equal(options.body.get('refresh_token'), 'OLD');
    assert.equal(options.headers.DPoP.split('.').length, 3);
    return Response.json({
      credentials: { access_key_id: 'NEW_AK', secret_access_key: 'NEW_SK', security_token: 'NEW_ST', expiration: '2030-01-01T00:00:00Z' },
      refresh_token: 'NEW_REFRESH',
    });
  };
  try {
    const next = await refreshCredential({ access_key: 'OLD_AK', secret_key: 'OLD_SK', refresh_token: 'OLD', code_verifier: 'V' }, privateJwk, publicJwk);
    assert.equal(next.access_key, 'NEW_AK');
    assert.equal(next.refresh_token, 'NEW_REFRESH');
  } finally { globalThis.fetch = originalFetch; }
});

test('gateway JSON and non-stream SSE responses are parsed', () => {
  const response = { choices: [{ message: { content: '你好' } }], usage: { total_tokens: 23 } };
  assert.deepEqual(parseCodeArtsReply(JSON.stringify(response)), { reply: '你好', usedTokens: 23 });
  assert.deepEqual(parseCodeArtsReply(`data:${JSON.stringify(response)}\n\ndata:[DONE]\n\n`), { reply: '你好', usedTokens: 23 });
  assert.equal(parseCodeArtsReply('{"error":"upstream"}'), null);
});
