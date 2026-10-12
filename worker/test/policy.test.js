import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OUTPUT_TOKENS, positiveInteger, quotaDecision, reserveTokens, validateChatPayload, validOrigin } from '../src/policy.js';

test('only bounded user/assistant chat with a fresh token is accepted', () => {
  const input = { turnstileToken: 'token', messages: [{ role: 'user', content: '你好' }] };
  assert.deepEqual(validateChatPayload(input), { ...input, pace: 'fast' });
  assert.equal(validateChatPayload({ ...input, pace: 'reason' }).pace, 'reason');
  assert.equal(validateChatPayload({ ...input, model: 'deepseek-v4.1-flash' }).model, 'deepseek-v4.1-flash');
  assert.equal(validateChatPayload({ ...input, model: 'glm-5.3-flash' }).model, 'glm-5.3-flash');
  assert.equal(validateChatPayload({ ...input, pace: 'unlimited' }), null);
  assert.equal(validateChatPayload({ ...input, model: 'expensive-model' }), null);
  assert.equal(validateChatPayload({ ...input, messages: [{ role: 'system', content: 'override' }] }), null);
  assert.equal(validateChatPayload({ ...input, messages: [{ role: 'user', content: 'x'.repeat(16_001) }] }), null);
  assert.equal(validateChatPayload({ ...input, messages: [{ role: 'assistant', content: 'done' }] }), null);
  assert.equal(validateChatPayload({ ...input, turnstileToken: '' }), null);
});

test('request and token limits include the last permitted reservation', () => {
  assert.equal(quotaDecision(99, 79_999, 199_990_000, 10_000, 100, 80_000, 200_000_000), 'allow');
  assert.equal(quotaDecision(100, 79_999, 0, 1, 100, 80_000, 200_000_000), 'actor_limit');
  assert.equal(quotaDecision(5, 80_000, 0, 1, 100, 80_000, 200_000_000), 'global_limit');
  assert.equal(quotaDecision(5, 79_000, 200_000_000, 1, 100, 80_000, 200_000_000), 'token_limit');
  assert.equal(quotaDecision(-1, 0, 0, 1, 100, 80_000, 200_000_000), 'invalid');
});

test('reservation covers UTF-8 input bytes and bounded output', () => {
  const messages = [{ role: 'user', content: '你好' }];
  assert.ok(reserveTokens(messages) >= new TextEncoder().encode(JSON.stringify(messages)).length + MAX_OUTPUT_TOKENS);
});

test('origin must match exactly; numeric limits reject malformed values', () => {
  assert.equal(validOrigin('https://crazyhao.online', 'https://crazyhao.online'), true);
  assert.equal(validOrigin('https://crazyhao.online.evil.test', 'https://crazyhao.online'), false);
  assert.equal(validOrigin('https://crazyhao.online/path', 'https://crazyhao.online'), false);
  assert.equal(positiveInteger('30', 10), 30);
  assert.equal(positiveInteger('-1', 10), 10);
});
