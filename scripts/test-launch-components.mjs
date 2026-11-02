// 一键启动/停止的接线契约：UI 入口与结构化失败码必须同时存在。
// 只读源码，不启动任何服务（真正的启动行为由集成环境手测）。
//
// 2026-11-02 slim 化：语音 / 桌宠 / B站 三个组件已整块移除，
// 因此这里只保留 QQ 一侧的接线断言（原断言见 git 历史）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/client.js'), 'utf8');

for (const action of ['start-selected', 'stop-selected']) {
  assert.ok(index.includes(action), `后端必须支持 ${action}`);
}
assert.ok(index.includes('NO_COMPONENTS'), '空选择必须返回结构化错误');
assert.ok(index.includes('PLATFORM_DISABLED'), '平台开关关闭必须返回结构化错误');
assert.ok(index.includes("'QQ（含 SnowLuma）'"), '启动项标签必须包含 SnowLuma');

for (const text of ['一键启动 SurfCore', '一键停止']) {
  assert.ok(client.includes(text), `前端必须有一键启动/停止入口：${text}`);
}
assert.ok(client.includes('launchErr'), '启动失败必须显示在界面上');
assert.ok(client.includes('it.hint'), '失败项必须展示下一步建议');

console.log('✅ 一键启动/停止接线通过');
