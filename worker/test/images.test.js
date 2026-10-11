import assert from 'node:assert/strict';
import test from 'node:test';
import { imageKeys, validateImagePayload, proxyImage } from '../src/images.js';

const payload = { prompt: 'A yellow duck', turnstileToken: 'test-token' };
test('generation accepts only bounded text prompts', () => {
  assert.equal(validateImagePayload(payload).prompt, payload.prompt);
  for (const patch of [{ prompt: '' }, { prompt: 'x'.repeat(4001) }, { model: 'unapproved' }, { image: 'https://internal/' }, { turnstileToken: '' }]) {
    assert.equal(validateImagePayload({ ...payload, ...patch }), null);
  }
});
test('generation uses the official Lite model and never returns upstream secrets', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xsAAAAASUVORK5CYII=';
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ data: [{ b64_json: png.split(',')[1] }], usage: { total_tokens: 5000 } });
  };
  try {
    const env = { SENSENOVA_API_KEYS: JSON.stringify(['sk-synthetic-one', 'sk-synthetic-two', 'sk-synthetic-one']), SENSENOVA_MODEL: 'sensenova-u1.5-lite' };
    assert.equal(imageKeys(env).length, 2);
    const read = stream => new Response(stream).text();
    assert.equal((await proxyImage(payload, env, read)).image, png);
    assert.equal((await proxyImage(payload, env, read)).usedTokens, 5000);
    assert.equal(calls[0].url, 'https://token.sensenova.cn/v1/images/generations');
    assert.equal(calls[1].url, 'https://token.sensenova.cn/v1/images/generations');
    assert.equal(calls[0].body.n, 1);
    assert.equal(calls[1].body.images, undefined);
    assert.equal(calls[0].options.redirect, 'manual');
    globalThis.fetch = async () => Response.json({ error: 'synthetic private details' }, { status: 401 });
    await assert.rejects(proxyImage(payload, env, read), /image_upstream_unavailable/);
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return attempts === 1 ? Response.json({ error: 'rate limited' }, { status: 429 })
        : Response.json({ data: [{ b64_json: png.split(',')[1] }], usage: { total_tokens: 5000 } });
    };
    assert.equal((await proxyImage(payload, env, read)).image, png);
    assert.equal(attempts, 2);
  } finally { globalThis.fetch = original; }
});
