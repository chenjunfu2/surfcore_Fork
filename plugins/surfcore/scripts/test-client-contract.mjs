/**
 * 设置页契约（不启浏览器）：
 *   · 加载 client.js 的 factory（React stub + ModuleLoader），确认模块可求值；
 *   · 检查 QQ 参数表字段、白名单/黑名单卡片、目的机制、Token 额度页、诊断/高级页结构。
 *
 * 2026-11-02 slim 化：语音 / 桌宠 / B站 三个子系统已整块移除，
 * 原先针对它们的断言（BILI_FIELDS / VoiceTab / PetTab / 扫码登录 / 鱼群 B站 卡 等）
 * 一并删除；本文件现在只钉 QQ 侧与通用 UI 结构。原断言见 git 历史。
 *
 * 运行：node scripts/test-client-contract.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const idle = () => {};
const React = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: idle,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, idle],
};

let client = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const module = { exports: {} };
      client = factory((name) => (name === 'react' ? React : {}));
    },
  },
};

await import('../lib/client.js');
assert.ok(client, 'client.js 没有被 ModuleLoader 加载');
const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

// ── QQ 参数表 ─────────────────────────────────────────────────────────────
assert.ok(Array.isArray(client.QQ_FIELDS), 'QQ_FIELDS 没有导出');
const qqPaths = client.QQ_FIELDS.flatMap((group) => group.fields.map((field) => field.path.join('.')));
assert.ok(qqPaths.length > 0, 'QQ_FIELDS 为空');

// QQ 白名单必须在设置页有一张常驻卡片（PITFALLS #27：以前只藏在折叠的「白名单与权限」组里）。
assert.ok(source.includes('WhitelistCard'), 'QQ 页缺少白名单卡片');
assert.ok(source.includes('QQ 白名单（群 / 人）'), '白名单卡片标题必须写人话');
assert.ok(source.includes('allow.groups') && source.includes('allow.private'), '白名单卡片没有绑定 allow.groups / allow.private');
assert.ok(source.includes('把管理员加进去'), '缺少「管理员不在私聊白名单」的修复入口');

// QQ 黑名单（2026-10-23 用户要求：白名单底下加黑名单，无论什么群都不响应黑名单里的人）。
assert.ok(source.includes('BlacklistCard'), 'QQ 页缺少黑名单卡片');
assert.ok(source.includes('QQ 黑名单（人 / 群 / 私聊）'), '黑名单卡片标题必须写人话');
assert.ok(source.includes('deny.users'), '黑名单卡片没有绑定 deny.users（人的黑名单）');

// 白/黑名单只在卡片里编辑，避免高级参数重复一份。
for (const dup of ['deny.private', 'deny.groups', 'deny.users', 'allow.groups', 'allow.private']) {
  assert.ok(!qqPaths.includes(dup), `白/黑名单应只在卡片里编辑（${dup} 不能被高级参数重复一份）`);
}

// ── 目的机制（QQ 载体）────────────────────────────────────────────────────
assert.ok(source.includes('function PurposeCard'), '缺少「主动找主人 · 目的机制」卡片');
assert.ok(source.includes('主动找主人 · 目的机制'), '目的机制卡片标题必须写人话');
assert.ok(source.includes('function PurposeTab'), '缺少独立的「目的」页组件');
assert.ok(source.includes('["purpose", "目的"]'), '设置页缺少「目的」标签');
for (const endpoint of ['"/purpose/status"', '"/purpose/preview"', '"/purpose/run"']) {
  assert.ok(source.includes(endpoint), `设置页没有调用 ${endpoint}`);
}

// ── 平台启动 / 一键启动 ───────────────────────────────────────────────────
assert.ok(source.includes('function PlatformStartCard'), '缺少平台启动开关卡片');
assert.ok(source.includes('"platforms", "start", "qq"'), 'QQ 启动开关没有绑定 platforms.start.qq');
assert.ok(source.includes('h(PlatformStartCard'), 'QQ 页没有渲染启动开关卡片');
assert.ok(source.includes('一键启动 SurfCore'), '概览启动卡缺少一键启动入口');
assert.ok(source.includes('一键停止'), '概览启动卡缺少一键停止入口');
for (const action of ['start-selected', 'stop-selected']) {
  assert.ok(source.includes(`"${action}"`), `设置页没有调用 ${action}`);
}
assert.ok(source.includes('人格卡在「角色」页维护'), '概览移除人格卡后缺少指路文案');

// ── 设置页 IA：人设/角色合并、高级设置折叠 ────────────────────────────────
assert.ok(source.includes('function AdvancedSettings'), '缺少统一的「高级设置」折叠组件');
assert.ok(source.includes('function PersonaEditor'), '人格卡编辑器没有抽成内嵌组件');
assert.ok(source.includes('保存全部'), '人格卡编辑器缺少保存全部入口');
assert.ok(source.includes('QQ 群聊') && source.includes('QQ 私聊'), '人格卡编辑器缺少 QQ 群聊/私聊场景');
assert.ok(source.includes('h(PersonaEditor'), '「角色」页没有渲染人格卡编辑器');
assert.ok(!source.includes('["persona", "人设"]'), '「人设」标签必须并入「角色」，不能留第二个入口');

// 各页的关键组件都要真的被渲染（避免"注册了但没渲染"）。
for (const [marker, page] of [
  ['h(QqFishGuardStatusCard, { busy })', 'QQ'],
  ['h(MemoryCardPanel, { view: "summary"', '记忆'],
  ['h(Section, { title: "配置 JSON（高级）"', '扩展'],
  ['h(Section, { title: `备份', '诊断'],
]) {
  assert.ok(source.includes(marker), `${page}页的关键/高级组件缺失：${marker}`);
}

// ── Token 额度页 ─────────────────────────────────────────────────────────
assert.ok(source.includes('function TokenTab'), '设置页缺少 Token 额度页组件');
assert.ok(source.includes('Token 额度'), '设置页缺少 Token 额度标签');
assert.ok(source.includes('今日 token 额度已用到 80%'), '设置页缺少 80% 弹窗');
assert.ok(source.includes('今天唯一一次'), '弹窗没有说明「每天只提醒一次」');

// ── 标签页集合 ────────────────────────────────────────────────────────────
for (const [id, label] of [
  ['overview', '概览'], ['characters', '角色'], ['purpose', '目的'], ['qq', 'QQ'],
  ['tokens', 'Token 额度'], ['memory', '记忆'], ['extensions', '扩展'],
  ['advanced', '全部参数'], ['diag', '诊断'],
]) {
  assert.ok(source.includes(`["${id}", "${label}"]`), `设置页缺少标签：${label}`);
}
// 已移除的子系统不得再出现在标签栏（只在 TABS 数组附近判断，避免误伤其它同名选项）。
{
  const tabsStart = source.indexOf('const TABS = [');
  const tabsEnd = source.indexOf('];', tabsStart);
  assert.ok(tabsStart > 0 && tabsEnd > tabsStart, '找不到 TABS 数组');
  const tabsBlock = source.slice(tabsStart, tabsEnd);
  for (const gone of ['"voice"', '"pet"', '"bili"', '"watch"', '"align"']) {
    assert.ok(!tabsBlock.includes(gone), `TABS 仍残留已移除的页：${gone}`);
  }
}

// ── setPath 路径归一化（2026-10-24 回归）──────────────────────────────────
assert.ok(client.__test?.setPath, 'client 没有导出 setPath 测试钩子');
{
  const target = {};
  client.__test.setPath(target, 'night.skipChance', 0.5);
  assert.deepEqual(target, { night: { skipChance: 0.5 } }, 'setPath 必须按点号分层，不能按字符遍历');
}
{
  const target = {};
  client.__test.setPath(target, ['a', 'b'], 1);
  assert.deepEqual(target, { a: { b: 1 } }, 'setPath 必须支持数组路径');
}

// ── 失败必须可见 ─────────────────────────────────────────────────────────
assert.ok(source.includes('launchErr'), '启动失败必须显示在界面上');
assert.ok(source.includes('it.hint'), '失败项必须展示下一步建议');

console.log('client contract tests OK（QQ-only）');
