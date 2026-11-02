/** 配置存储回归：脱敏/还原密钥、范围收敛、默认值合并。 */
import assert from 'node:assert/strict';
import {
  MASK, normalizeQqConfig, redactForUi, restoreMaskedSecrets,
} from '../lib/store.js';

const sample = {
  dsh: { authToken: 'secret-token' },
  snowluma: { accessToken: 'snow-secret' },
  webSearch: { apiKey: 'search-secret' },
  consoleToken: 'console-secret',
  allow: { private: [12345678, '87654321', 'abc'], groups: [] },
};
const redacted = redactForUi(sample);
assert.equal(redacted.dsh.authToken, MASK);
assert.equal(redacted.snowluma.accessToken, MASK);
assert.equal(redacted.webSearch.apiKey, MASK);
assert.equal(redacted.consoleToken, MASK);

const restored = restoreMaskedSecrets(redacted, sample);
assert.equal(restored.dsh.authToken, 'secret-token');
assert.equal(restored.snowluma.accessToken, 'snow-secret');
assert.equal(restored.webSearch.apiKey, 'search-secret');
assert.equal(restored.consoleToken, 'console-secret');

const normalized = normalizeQqConfig({
  ...sample,
  consolePort: 999999,
  allow: { private: ['12345678', 'abc'], groups: ['767098733'] },
  biliBridge: { memory: { enabled: false, refreshIntervalMs: 1 }, share: { times: ['7:00', '99:99'] } },
});
assert.equal(normalized.consolePort, 65535);
assert.deepEqual(normalized.allow.private, ['12345678']);
assert.equal(normalized.biliBridge.memory.enabled, false);
assert.equal(normalized.biliBridge.memory.refreshIntervalMs, 60000);
assert.deepEqual(normalized.biliBridge.share.times, ['07:00']);
// 分享形式：旧 card:boolean 收敛成 cardMode；card 变成派生值（PITFALLS #24）
assert.equal(normalized.biliBridge.share.cardMode, 'text', '没写 cardMode 时默认文本链接');
assert.equal(normalized.biliBridge.share.card, true);
const cardOff = normalizeQqConfig({ biliBridge: { share: { card: false } } });
assert.equal(cardOff.biliBridge.share.cardMode, 'off');
assert.equal(cardOff.biliBridge.share.card, false);
const cardMini = normalizeQqConfig({ biliBridge: { share: { card: true, cardMode: 'miniapp' } } });
assert.equal(cardMini.biliBridge.share.cardMode, 'miniapp', '显式 cardMode 优先于旧 card');
assert.equal(cardMini.biliBridge.share.card, true);
const cardBad = normalizeQqConfig({ biliBridge: { share: { cardMode: 'weird' } } });
assert.equal(cardBad.biliBridge.share.cardMode, 'text', '非法值回默认，不要静默变 off');

console.log('store tests OK');
