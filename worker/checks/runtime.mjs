import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xsAAAAASUVORK5CYII=';
let imageCalls = 0;
const chatModels = [];
const chatThinking = [];
let failImages = false;
const bindings = {
  ALLOWED_ORIGIN: 'https://chat.crazyhao.online', ALLOWED_ORIGIN_ALT: 'https://chat-crazy-bios.pages.dev',
  ALLOWED_HOSTNAME: 'chat.crazyhao.online', TURNSTILE_ACTION: 'gist_chat',
  TURNSTILE_SECRET: 'synthetic-turnstile', QUOTA_SALT: 'synthetic-salt-long-enough',
  CODEARTS_CREDENTIAL_JSON: JSON.stringify({ access_key: 'TEST_AK', secret_key: 'TEST_SK' }),
  UPSTREAM_MODEL: 'deepseek-v4.1-flash', SENSENOVA_API_KEYS: JSON.stringify(['sk-synthetic-one', 'sk-synthetic-two']),
  PER_IP_DAILY_REQUESTS: '100', GLOBAL_DAILY_REQUESTS: '80000', GLOBAL_DAILY_TOKENS: '200000000',
  PER_IP_DAILY_IMAGES: '2', GLOBAL_DAILY_IMAGES: '4',
};
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: '.test-build/index.js', compatibilityDate: '2026-10-11', bindings,
  durableObjects: { QUOTA: { className: 'Quota', useSQLite: true } },
  ratelimits: { IP_BURST: { namespace_id: '1001', simple: { limit: 100, period: 60 } } },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') {
      const form = new URLSearchParams(await request.text());
      const token = form.get('response');
      return Response.json({ success: token === 'ok' || token === 'ok-alt', hostname: token === 'ok-alt' ? 'chat-crazy-bios.pages.dev' : 'chat.crazyhao.online', action: 'gist_chat' });
    }
    if (url.hostname === 'token.sensenova.cn') {
      imageCalls++;
      const body = await request.json();
      assert.match(request.headers.get('authorization'), /^Bearer sk-synthetic-(one|two)$/);
      assert.equal(body.model, 'sensenova-u1.5-lite');
      assert.equal(body.n, 1);
      assert.equal(url.pathname, '/v1/images/generations');
      assert.equal(body.images, undefined);
      return failImages ? Response.json({ secret: 'should-not-leak' }, { status: 500 })
        : Response.json({ data: [{ b64_json: png }], usage: { total_tokens: 5000 } });
    }
    if (url.hostname === 'snap-access.cn-north-4.myhuaweicloud.com') {
      const body = await request.json();
      chatModels.push(body.model);
      chatThinking.push(body.enable_thinking);
      assert.match(request.headers.get('authorization'), /^SDK-HMAC-SHA256 /);
      return new Response('data:' + JSON.stringify({ choices: [{ message: { content: 'synthetic chat OK' } }], usage: { total_tokens: 25 } }) + '\n\ndata:[DONE]\n\n');
    }
    throw new Error('Unexpected outbound host');
  },
}));
async function post(path, value, ip = '192.0.2.10', origin = bindings.ALLOWED_ORIGIN) {
  return mf.dispatchFetch('https://worker.test' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(value) });
}
try {
  const status = await (await mf.dispatchFetch('https://worker.test/api/status')).json();
  assert.equal(status.ready, true);
  assert.equal(status.images.ready, true);
  assert.ok(!JSON.stringify(status).includes('sk-synthetic-one'));
  const alternateStatus = await mf.dispatchFetch('https://worker.test/api/status', { headers: { Origin: bindings.ALLOWED_ORIGIN_ALT } });
  assert.equal(alternateStatus.status, 200);
  assert.equal(alternateStatus.headers.get('access-control-allow-origin'), bindings.ALLOWED_ORIGIN_ALT);
  assert.equal((await mf.dispatchFetch('https://worker.test/api/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const input = { prompt: 'test duck', turnstileToken: 'ok' };
  const preflight = await mf.dispatchFetch('https://worker.test/api/images', { method: 'OPTIONS', headers: { Origin: bindings.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal((await post('/api/images', { ...input, image: `data:image/png;base64,${png}` })).status, 400);
  assert.equal((await post('/api/images', { ...input, turnstileToken: 'bad' })).status, 403);
  assert.equal(imageCalls, 0);
  let response = await post('/api/images', input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).image, `data:image/png;base64,${png}`);
  response = await post('/api/images', input);
  assert.equal(response.status, 200);
  assert.equal((await post('/api/images', input)).status, 429);
  assert.equal(imageCalls, 2);
  response = await post('/api/chat', { turnstileToken: 'ok', pace: 'reason', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'synthetic chat OK');
  response = await post('/api/chat', { turnstileToken: 'ok', pace: 'fast', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 200);
  response = await post('/api/chat', { turnstileToken: 'ok', pace: 'fast', model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 200);
  assert.equal((await post('/api/chat', { turnstileToken: 'ok-alt', messages: [{ role: 'user', content: 'hello' }] }, '192.0.2.50', bindings.ALLOWED_ORIGIN)).status, 403);
  response = await post('/api/chat', { turnstileToken: 'ok-alt', messages: [{ role: 'user', content: 'hello' }] }, '192.0.2.50', bindings.ALLOWED_ORIGIN_ALT);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), bindings.ALLOWED_ORIGIN_ALT);
  assert.deepEqual(chatModels, ['deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'deepseek-v4.1-flash']);
  assert.deepEqual(chatThinking, [true, false, true, false]);
  failImages = true;
  response = await post('/api/images', input, '192.0.2.20');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'image_upstream_unavailable');
  failImages = false;
  const raced = await Promise.all([post('/api/images', input, '192.0.2.30'), post('/api/images', input, '192.0.2.40')]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 429]);
  assert.equal(imageCalls, 4);
  console.log('PASS: workerd routes, auth, text-to-image, signed CodeArts chat, failed-request quota retention, concurrent site image limit.');
} finally { await mf.dispose(); }
