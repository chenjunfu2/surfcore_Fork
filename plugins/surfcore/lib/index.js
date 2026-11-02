/**
 * surfcore —— 宿主半边（设置窗口的唯一后端）。
 *
 * 它把原来两个插件的能力装进一个进程：
 *   · QQ 侧：读/写 <surfcore>/config.json、桥接探活/启停/重启、模式与 ownerQQ、
 *            白名单、social/socialV2/chat/slang/webSearch 等全部参数；
 *   · B站侧：读/写 ~/.dsh/surfcore/bili.config.json、cookie 写入、依赖体检、
 *            待审回复、通知测试、生物钟（scheduler.js）；
 *   · 合体层：统一人设卡、QQ→B站 脱敏记忆、身份对齐、扩展接口、平台适配器
 *            （qq/bili 内置，tieba 预留）。
 *
 * 安全：
 *   · 所有路由只接受本机回环 + DSH connection.requestRejection；
 *   · 写操作要求 application/json，且 Origin（若有）必须同源；
 *   · 读配置脱敏（********），保存时 ******** 表示保持原值；
 *   · 每次写文件前备份到 ~/.dsh/surfcore/backups/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ALIGN_FILE, BACKUP_DIR, BILI_ALIGNMENT_FILE, BILI_DIR, DSH_HOME, EXTENSIONS_DIR, MEMORY_DIR,
  PLUGIN_ROOT, PLUGIN_LOG, QQ_ALIGNMENT_BRIEF, QQ_CONFIG, QQBOT_ROOT, STATE_DIR, UNIFIED_FILE,
  ensureDirs, findNodeExe, maskPath,
} from './paths.js';
import { resolvePersonaFile } from './persona.js';
import { discoverSnowLumaConnection } from '../../../src/snowluma-conn.js';
import { findSnowLumaInstall as findSnowLumaInstallIn, normalizeSnowLumaInstall, snowLumaMissingReport } from './snowluma-install.js';
import { buildInstallChecks, installOk, planDoctorFix } from './doctor.js';
import {
  autoSnapshot, beforeSwitchSnapshot, characterDetail, characterOverview, createCharacterFromPayload,
  deleteCharacter, manualSnapshot, migrateIfNeeded, restoreCharacterSnapshot, switchToCharacter,
  updateCharacterFromPayload,
} from './characters.js';
import { activeMemoryPaths, activePersonaLayers, activePlatformStateDir, readCurrentCharacter, touchCharacter } from '../../../src/character-persona.js';
import {
  backupFile, listBackups, pathSummary,
  readAll, readJson, readQqConfig, readUnified,
  saveQqConfig, saveUnified, writeJsonAtomic, writeTextAtomic,
} from './store.js';
import {
  PRIVACY_POLICY_VERSION, explainText, scanText,
} from './privacy.js';
import {
  addLink, approveCandidate, exportAlignments, importAlignments, listCandidates,
  listLinks, rejectCandidate, removeLink, stats as alignStats,
  updateLink, writeAlignmentBriefs,
} from './align.js';
import {
  auditTail, biliToQqStatus, memoryStatus, previewQqForBili, rebuildAllPrompts,
  refreshBiliToQq, scanQqFeedForCandidates,
  syncQqToBili,
} from './memory.js';
import {
  bridgeLogTail, callBridge, restart as restartBridge, start as startBridge,
  status as bridgeStatus, stop as stopBridge,
  consoleBase, consoleToken } from './bridge.js';
import { PlatformRegistry } from './platforms.js';
import { ExtensionHost } from './extensions.js';
import { isLoopbackReq, json, readBody, sameOrigin } from './http-guard.js';
import { createTokenBudgetService } from './token-budget.js';
import { scanPluginCompatibility } from './compat.js';
import { createGateEventStore } from '../../../src/gate-events.js';
import { normalizeAllowlist } from '../../../src/allowlist.js';
import { createUpdatesService, resumePendingApply } from './updates.js';
import {
  adminFromSources, adminSummary, normalizeAdmin, projectAdminSave,
} from '../../../src/admin-identity.js';
import {
  applyMemoryCardAction, compactMemoryCardNow, fullMemoryCardSnapshot, memoryCardIdle, memoryCardSnapshot,
  memoryCardStatusNow, notifyOwnerIfNeeded, restoreMemoryCardBackup, runMemoryCardMaintenance,
  startMemoryCardTimer,
} from './memory-card.js';
import { summarizeQqFishGuard } from './qq-fish-guard.js';
import { fileStamp, isStale } from '../../../src/config-stamps.js';
import { createContextTelemetry } from '../../../src/context-telemetry.js';
import { createBillingService } from './billing.js';
import { createPersonaClassifier } from './persona-classify.js';

// 版本号只有一个来源：仓库根 package.json（与 plugins/surfcore/package.json 必须一致，
// 由 scripts/version.mjs check 与 test-version.mjs 把关）。
// 这里不做硬编码，避免"改了一处忘了另一处"。
function readOwnVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // plugins/surfcore/lib
    const rootPkg = path.resolve(here, '../../../package.json');
    return JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version || '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

const VERSION = readOwnVersion();
const API_PREFIX = '/dsh-surfcore/api';
const EXT_PREFIX = '/dsh-surfcore/ext';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const pluginLog = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 2026-10-22 审计：只 append 不轮转会无限增长。超过 2MB 就滚一份 .1（保留一代）。
    try {
      const stat = fs.statSync(PLUGIN_LOG);
      if (stat.size > 2 * 1024 * 1024) fs.renameSync(PLUGIN_LOG, `${PLUGIN_LOG}.1`);
    } catch {}
    fs.appendFileSync(PLUGIN_LOG, line);
  } catch {}
  try { console.log(`[surfcore] ${args.join(' ')}`); } catch {}
};

function safeBackupName(name) {
  const base = path.basename(String(name ?? ''));
  if (!base || base !== String(name)) return '';
  return base;
}

function readTextFile(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** 只读文件尾部（默认 512KB）：日志接口不能因为日志变大就一次读进内存。 */
function readTextTail(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function mtimeIso(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}

function parseModeState() {
  const local = readJson(path.join(QQ_STATE_DIR(), 'mode.json'), {}) ?? {};
  return { localMode: local.mode ?? null, localRole: local.role ?? null };
}

function QQ_STATE_DIR() {
  return path.join(path.dirname(QQ_CONFIG), 'state');
}

export const name = 'surfcore';
export const inject = ['webServer', 'connection', 'sessionController'];

export function apply(ctx) {
  ensureDirs();

  // 上次的"退出后应用"可能没跑起来（Electron 宿主没带 ELECTRON_RUN_AS_NODE）：
  // 这里重新排队，用户下次退出 DSH 就会应用（2026-10-28 反馈：点几次都还是旧版本）。
  try { resumePendingApply({ stateDir: STATE_DIR, pluginLog }); } catch (error) { pluginLog('[updates] 启动重试失败：', String(error?.message ?? error)); }

  // 2026-10-22 起：`surface_core` 迁移期的一次性逻辑**已整段删除**。
  // 原因：当年为了把旧工作区改名，留了「有 .legacy-workspace 标记就删/移旧目录」的代码；
  // 这类「启动时按标记动用户目录」的代码风险远大于收益（误删不可逆），迁移也早已完成。
  // 现在的约定：插件**不碰**任何工作区目录；清理旧目录一律由人工或用脚本先备份再动。
  // 相关事故与处置见 docs/PITFALLS.md #1/#3。

  const platforms = new PlatformRegistry();
  platforms.setStatus('qq', () => bridgeStatus());
  const extensionHost = new ExtensionHost({
    platforms,
    memory: { memoryStatus, previewQqForBili, syncQqToBili, refreshBiliToQq, auditTail },
    align: { listLinks, listCandidates, addLink, updateLink, removeLink, approveCandidate, rejectCandidate, stats: alignStats },
    bridge: {
      status: bridgeStatus,
      start: () => startBridge({ dshWebUrl: currentDshUrl() }),
      stop: stopBridge,
      restart: () => restartBridge({ dshWebUrl: currentDshUrl() }),
      call: callBridge,
    },
    log: pluginLog,
  });

  let syncTimer = null;
  let memoryCardTimer = null;
  let characterTimer = null;

  // ── 每日 token 额度 / 用量采集（2026-10-23 用户要求）────────────────────
  // 插件是唯一能同时看到 QQ、B站、黑话学习会话的地方：用 session/event 实时累计，
  // 设置页展示、B站 调度器拦截、QQ 桥接（读 daily 快照）都共用这一份。
  const tokenBudget = createTokenBudgetService({
    ctx,
    dshHome: DSH_HOME,
    qqStateDir: QQ_STATE_DIR(),
    getQqConfig: () => readQqConfig().config,
    log: (message) => pluginLog(message),
  });
  // 闸门事件中心：桥接负责写，插件负责展示/确认；同一份文件、同一套分级。
  const gateEvents = createGateEventStore({ dir: STATE_DIR, log: (message) => pluginLog(message) });
  // Phase 0A：旁路遥测（只读事件，不改 prompt/工具/会话行为）。
  const contextTelemetry = createContextTelemetry({
    file: path.join(STATE_DIR, 'context-telemetry-plugin.jsonl'),
    source: 'plugin',
    log: (message) => pluginLog(message),
  });
  // A+B 账单：每 10 分钟刷新到 ~/.dsh/surfcore/billing；只读，不调用模型。
  const personaClassifier = createPersonaClassifier({ ctx, log: (message) => pluginLog(message), tokenBudget });

  const billing = createBillingService({
    stateDir: STATE_DIR,
    qqRoot: QQBOT_ROOT,
    readCurrentCharacter,
    log: (message) => pluginLog(message),
  });
  billing.start();


  // ── 组件更新（2026-10-26 用户要求）──────────────────────────────────────
  // 检查 SurfCore 本体 + 语音包 + 桌宠 + 未来登记的扩展：只读 git fetch，更新只允许 --ff-only。
  // 组件清单每次动态解析：换路径 / 新装包 / 新扩展都不用重启插件。
  const updates = createUpdatesService({
    stateDir: STATE_DIR,
    pluginLog,
    githubToken: () => String(readUnified().config?.updates?.githubToken ?? ''),
    blockedReason: (component) => '',
    components: () => {
      const list = [];
      const updCfg = readUnified().config?.updates ?? {};
      // 1) SurfCore 本体：源码树，走 git
      list.push({ id: 'surfcore', name: 'SurfCore 本体', dir: QQBOT_ROOT, kind: 'git', branch: 'main', versionRepo: 'Mieksido/surfcore' });
      // 2) 语音包**不进入自动更新列表**：它是离线运行时/模型/vendor 包，
      //    不是 SurfCore 那种代码 zip；统一 updateFromZip 会按 surfcore-* + package.json
      //    解析而必然失败（2026-10-30 用户反馈）。需要新包时在「语音」页重新导入离线包，
      //    由 voice-pack-import 保留 config.toml / .venv / models / vendor。
      //    语音包自己的 version.json / models.json 仍由语音页/包管理读取。
      // 4) 用户/未来扩展登记的组件：unified config 的 updates.components[]
      try {
        const custom = updCfg.components;
        if (Array.isArray(custom)) {
          for (const item of custom) {
            if (!item || typeof item !== 'object' || !item.id || !item.dir) continue;
            list.push({
              id: String(item.id).slice(0, 60),
              name: String(item.name ?? item.id).slice(0, 80),
              dir: String(item.dir),
              kind: ['git', 'release', 'auto'].includes(item.kind) ? item.kind : 'auto',
              branch: item.branch ? String(item.branch).slice(0, 60) : undefined,
              versionUrl: item.versionUrl ? String(item.versionUrl) : '',
            });
          }
        }
      } catch {}
      // 去重（同 id 只留第一个）
      const seen = new Set();
      return list.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    },
  });

  let sessionEventOff = null;
  try {
    if (typeof ctx.on === 'function') {
      sessionEventOff = ctx.on('session/event', (session, event) => {
        try { tokenBudget.ingestEvent(session, event); }
        catch (error) { pluginLog('token 用量采集失败：', String(error?.message ?? error).slice(0, 160)); }
        try {
          if (tokenBudget.isTrackedSession(session)) contextTelemetry.ingestEvent(session, event);
        } catch (error) { pluginLog('上下文遥测失败：', String(error?.message ?? error).slice(0, 160)); }
      });
    }
  } catch (error) {
    pluginLog('token 用量采集监听注册失败：', String(error?.message ?? error));
  }

  // 启动时先重建身份对齐提示块（bridge 与 B站调度器都读它）。
  try { writeAlignmentBriefs(); } catch (error) { pluginLog('启动时写对齐简报失败：', error?.message ?? error); }

  // 管理员称呼的存量修复：v0.7.2 及以前只把 ownerQQ 投影到 QQ config.json，
  // displayName/biliName/gentle 留在 unified，桥接独立进程读不到 → 叫“管理员”。
  // 启动时补一次投影（有变化才写），桥接在跑就重启让它重新读配置。
  function ensureAdminProjection() {
    try {
      const qqState = readQqConfig();
      const unifiedState = readUnified();
      const unifiedAdmin = unifiedState.hasAdmin ? unifiedState.config?.admin : undefined;
      const sourceAdmin = unifiedAdmin ?? qqState.config?.admin;
      const current = adminFromSources({
        unified: { admin: sourceAdmin },
        qq: qqState.config,
      });
      if (!current.qq && !current.biliMid) return;
      const next = normalizeAdmin(current);
      const prev = normalizeAdmin(qqState.config?.admin);
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      const planned = projectAdminSave({ current: next, qq: qqState.config });
      if (!planned.qq) return;
      saveQqConfig(planned.qq);
      pluginLog('管理员称呼已补齐到 QQ config.json（桥接重启后生效）');
      setTimeout(() => {
        void bridgeStatus().then((st) => {
          if (!st.running) return;
          return restartBridge({ dshWebUrl: currentDshUrl() });
        }).catch(() => {});
      }, 1500).unref?.();
    } catch (error) {
      pluginLog('管理员称呼投影失败（继续使用现有配置）：', error?.message ?? error);
    }
  }

  ensureAdminProjection();

  // ── 平台启动开关（2026-10-24 用户要求）──
  // 唯一真相在合体层 config.json 的 platforms.start.qq；开关关掉 = 不自动启动、
  // 不被「一键启动」带上，保存配置时宿主会把正在跑的桥接停掉。
  // 2026-11-02 slim 化：B站 已整块移除，这里只剩 QQ 一项。
  function platformStartState() {
    const start = readUnified().config.platforms?.start ?? {};
    return { qq: start.qq !== false };
  }
  function platformStartEnabled(id) {
    return platformStartState()[id] !== false;
  }

  // ── 角色人格：启动迁移 + 切换编排 ───────────────────────────────────────
  // 迁移只做一次：有旧记忆/旧 B站 账本才建第一个角色；旧目录原样保留作冷备份。
  function ensureCharacterSystem() {
    if (process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION === '1') return { ok: true, skipped: true, reason: 'disabled' };
    try {
      const result = migrateIfNeeded({
        personaFile: resolvePersonaFile(),
        memoryDir: MEMORY_DIR,
        biliDir: BILI_DIR,
        stateDir: QQ_STATE_DIR(),
      });
      if (result.migrated) {
        pluginLog(`角色系统：已从旧数据迁移出「${result.character?.name ?? result.current?.name}」（备份 ${maskPath(result.backupDir)}）`);
        writeCharacterRolePointer();
        // 桥接可能已经在跑旧路径：给它一次重启，让它读新角色目录。
        setTimeout(() => { void bridgeStatus().then((st) => { if (st.running) return restartBridge({ dshWebUrl: currentDshUrl() }); }).catch(() => {}); }, 1500).unref?.();
      }
      return result;
    } catch (error) {
      pluginLog('角色系统迁移失败（继续用旧布局）：', error?.message ?? error);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  function writeCharacterRolePointer() {
    const cur = readCurrentCharacter();
    if (!cur) return;
    const file = path.join(QQ_STATE_DIR(), 'current-role.json');
    const old = readJson(file, {}) ?? {};
    try {
      writeJsonAtomic(file, { role: cur.name, mode: old.mode === 'silent' ? 'silent' : 'active' });
    } catch (error) {
      pluginLog('写 current-role.json 失败：', error?.message ?? error);
    }
  }

  /** 先让桥接停掉全部旧会话（v1 + v2），再停进程；否则旧 DSH 回合可能带着旧人格继续发消息。 */
  async function stopAllBridgeSessions() {
    try {
      const listed = await callBridge('/api/sessions', { timeoutMs: 8000 });
      const sessions = Array.isArray(listed?.data?.sessions) ? listed.data.sessions : [];
      for (const item of sessions) {
        if (!item?.key) continue;
        await callBridge('/api/session/reset', { method: 'POST', body: { key: item.key }, timeoutMs: 15000 }).catch(() => {});
      }
      await callBridge('/api/socialV2/reset', { method: 'POST', timeoutMs: 20000 }).catch(() => {});
    } catch (error) {
      pluginLog('切换角色：停止旧桥接会话失败（继续停进程）：', error?.message ?? error);
    }
  }

  /** 切换角色前把桥接的会话映射挪走：新角色必须从空会话开始，不能带旧人格上下文。 */
  function archiveBridgeRuntimeState() {    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(BACKUP_DIR, `character-switch-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = ['sessions.json', 'social-v2.json'];
    const moved = [];
    for (const name of files) {
      const src = path.join(QQ_STATE_DIR(), name);
      try {
        if (!fs.existsSync(src)) continue;
        fs.renameSync(src, path.join(dir, name));
        moved.push(name);
      } catch (error) {
        pluginLog(`切换角色：归档 ${name} 失败：`, error?.message ?? error);
      }
    }
    return { dir, moved };
  }

  async function switchCharacterEverywhere(id) {
    const current = readCurrentCharacter();
    if (current && current.id === id) return { ok: true, already: true, current };
    const target = characterDetail(id).character;
    const skipPlatform = process.env.SURFCORE_DISABLE_PLATFORM_RESTART === '1';
    await memoryCardIdle();
    const wasRunning = skipPlatform ? false : (await bridgeStatus()).running;

    try {

      if (wasRunning) {
        await stopAllBridgeSessions();
        const stopped = await stopBridge();
        if (!stopped.ok) {
          throw new Error(`切换失败：QQ 桥接没停下来（${stopped.error || stopped.message || '未知原因'}）`);
        }
      }
      // 到这里两个平台都停了：给旧角色拍切换前存档，然后原子换指针。
      if (current) beforeSwitchSnapshot(current.id);
      const switched = switchToCharacter(id);
      writeCharacterRolePointer();
      const archived = archiveBridgeRuntimeState();
      // 先把新角色的记忆卡 prompt 生成好，再启动桥接/调度器，避免开头几条提示词读不到记忆。
      await runMemoryCardMaintenance({}).catch((error) => pluginLog('切换角色后整理记忆卡失败：', error?.message ?? error));
      if (wasRunning) {
        const started = await startBridge({ dshWebUrl: currentDshUrl() });
        if (!started.ok) pluginLog('切换角色：桥接重启失败（角色已切换，平台保持停止）：', started.error || started.message);
      }
      pluginLog(`角色已切换：${current?.name ?? '（无）'} → ${target.name}（epoch ${switched.current?.epoch}）`);
      return {
        ok: true,
        current: switched.current,
        previous: current,
        bridgeRestarted: wasRunning,
        archived,
      };
    } catch (error) {
      pluginLog('角色切换失败：', error?.message ?? error);
      throw error;
    }
  }

  const characterMigration = ensureCharacterSystem();


  // 记忆卡：插件宿主是唯一维护者。启动 8 秒后整理一次（摄取桥接 inbox + B站记忆），
  // 之后每 10 分钟一次；每日衰减由 memory-card 自己按 dailyHour 判断。
  memoryCardTimer = startMemoryCardTimer({ log: pluginLog, callBridge });

  // 角色自动存档：启动 10 秒后跑一次，之后每 6 小时检查（每天最多一份 + 11 个年龄档轮换）。
  const runCharacterAutoSave = () => {
    const cur = readCurrentCharacter();
    if (!cur) return;
    try {
      const result = autoSnapshot(cur.id);
      if (result.pruned?.length) pluginLog(`角色自动存档：${cur.name} 清理 ${result.pruned.length} 个旧档`);
    } catch (error) {
      pluginLog('角色自动存档失败：', error?.message ?? error);
    }
  };
  const characterInitial = setTimeout(runCharacterAutoSave, 10_000);
  characterInitial.unref?.();
  characterTimer = setInterval(runCharacterAutoSave, 6 * 60 * 60 * 1000);
  characterTimer.unref?.();

  // QQ → B站 定时同步（默认关闭；开启后每 30 分钟一次，启动 20 秒后先跑一次）。
  const startSyncTimer = () => {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    const unified = readUnified().config;
    if (unified.memory?.qqToBili?.enabled !== true) return;
    setTimeout(() => {
      try { syncQqToBili(); } catch (error) { pluginLog('首次 QQ→B站 同步失败：', error?.message ?? error); }
    }, 20_000).unref?.();
    syncTimer = setInterval(() => {
      try { syncQqToBili(); } catch (error) { pluginLog('定时 QQ→B站 同步失败：', error?.message ?? error); }
    }, Math.max(5 * 60_000, Number(unified.memory?.qqToBili?.intervalMs) || 30 * 60_000));
  };

  // 扩展：只加载显式启用的；默认示例全部 disabled。
  const activateExtensions = async () => {
    if (readUnified().config.extensions?.enabled === false) return;
    try {
      const results = await extensionHost.activateEnabled();
      if (results.length) pluginLog(`扩展启用结果：${JSON.stringify(results)}`);
    } catch (error) {
      pluginLog('扩展启用失败：', error?.message ?? error);
    }
  };

  function currentDshUrl() {
    try {
      const ws = ctx.get('webServer');
      if (ws?.port) return `${ws.protocol || 'http:'}//127.0.0.1:${ws.port}`;
    } catch {}
    return String(process.env.DSH_WEB_URL ?? '').trim();
  }

  // 桥接是否还是“上一轮 DSH 的”：旧版本不报 root/dshBaseUrl，或者端口已经变了。
  function bridgeStaleReason(status) {
    if (!status?.running) return '';
    const runningRoot = status.root ? path.resolve(String(status.root)) : '';
    if (!runningRoot || runningRoot !== path.resolve(QQBOT_ROOT)) {
      return `桥接还在旧目录（root=${status.root ?? '未知'}）`;
    }
    const expected = currentDshUrl().replace(/\/+$/, '');
    const actual = String(status.dshBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!actual) return '桥接是旧版本，无法报告 DSH 地址';
    if (expected && actual !== expected) return `桥接还连着旧 DSH（${actual} ≠ ${expected}）`;
    return '';
  }

  // 自动拉起桥接（默认关；用户可在设置里开）。
  // 2026-10-22：除了启动时检查一次，再加一个 2 分钟自愈轮询 ——
  // DSH 重启后端口会变，桥接如果还连着旧端口，下一次轮询会自动重启它（而不是等用户发现）。
  let bridgeRepairBusy = false;
  let bridgeRepairTimer = null;
  const maybeAutoStartBridge = async () => {
    if (bridgeRepairBusy) return;
    bridgeRepairBusy = true;
    try {
      if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return;
      // 新开关是唯一真相；旧 bridge.autoStart 已由 readUnified() 迁移，不再直接读。
      if (!platformStartEnabled('qq')) return;
      const status = await bridgeStatus();
      if (status.running) {
        const stale = bridgeStaleReason(status);
        if (stale) {
          pluginLog(`autoStartBridge：${stale}，自动重启`);
          const restarted = await restartBridge({ dshWebUrl: currentDshUrl() });
          pluginLog('autoStartBridge 重启结果：', restarted.message || restarted.error || '');
        }
        return;
      }
      pluginLog('autoStartBridge：桥接未运行，尝试启动');
      const result = await startBridge({ dshWebUrl: currentDshUrl() });
      pluginLog('autoStartBridge 结果：', result.message || result.error || '');
    } catch (error) {
      pluginLog('autoStartBridge 失败：', error?.message ?? error);
    } finally {
      bridgeRepairBusy = false;
    }
  };

  const disposers = [];
  function route(kind, pathname, handler) {
    disposers.push(ctx.webServer.register({
      kind,
      path: pathname,
      handler: async (req, res) => {
        if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return; }
        if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }
        if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
          json(res, 415, { ok: false, error: '写操作必须是 application/json' });
          return;
        }
        try {
          const conn = ctx.get('connection');
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req);
            if (code !== undefined && code !== null && code !== false) {
              res.statusCode = typeof code === 'number' ? code : 403;
              res.end();
              return;
            }
          }
          await handler(req, res);
        } catch (error) {
          pluginLog('API 失败：', error?.message ?? error);
          try { json(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
        }
      },
    }));
  }

  // ── 概览 ────────────────────────────────────────────────────────────────
  async function overview() {
    const all = readAll();
    const snow = readQqConfig().config?.snowluma ?? {};
    const [bridge, memory] = await Promise.all([
      bridgeStatus().catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
      Promise.resolve(memoryStatus()),
    ]);
    // SnowLuma 只报「未连接」没用：这里给出可执行的诊断（没启动 / 在登录页 / token 不对）。
    const snowDiag = await diagnoseSnowLuma(bridge?.snowluma ?? {}).catch(() => ({ state: 'unknown', hint: '' }));
    const personaText = readTextFile(resolvePersonaFile());
    const mode = parseModeState();
    let dshMode = null;
    try {
      const settings = ctx.get('settings');
      if (settings?.describe) {
        const rows = settings.describe({ redactSecrets: true });
        const row = rows.find((item) => item.ns === 'qq-mode');
        dshMode = row?.value?.mode ?? null;
      }
    } catch {}
    return {
      ok: true,
      version: VERSION,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      bridge,
      memory,
      memoryCard: memoryCardStatusNow(),
      admin: adminSummary(all.unified?.admin),
      alignment: alignStats(),
      platforms: platforms.list(),
      extensions: extensionHost.describe(),
      // 平台启动开关：设置页顶部状态点、概览三按钮的可用性都读它。
      platformStart: platformStartState(),
      // 组件更新：概览「更新」卡与启动弹窗都读它（检查结果是缓存的，不在这里触发网络）。
      updates: updates.status(),
      launch: await launchStatus(),
      snowluma: {
        launcherPath: String(snow.launcherPath ?? ''),
        allowLaunch: snow.allowLaunch === true,
        downloadUrl: String(snow.downloadUrl ?? 'https://github.com/SnowLuma/SnowLuma/releases/latest'),
        detected: findSnowLumaInstall().ok,
        everConnected: bridge?.snowluma?.everConnected === true,
        diagnosis: snowDiag,
      },
      mode: {
        local: mode.localMode,
        dsh: dshMode,
        effective: dshMode || mode.localMode,
        role: mode.localRole,
        ownerQQ: all.qq?.ownerQQ ?? null,
        allowGroups: all.qq?.allow?.groups?.length ?? 0,
        allowPrivate: all.qq?.allow?.private?.length ?? 0,
      },
      persona: {
        path: resolvePersonaFile(),
        exists: Boolean(personaText),
        chars: personaText.length,
        mtime: mtimeIso(resolvePersonaFile()),
      },
      character: (() => {
        const cur = readCurrentCharacter();
        return cur ? { id: cur.id, name: cur.name, epoch: cur.epoch, switchedAt: cur.switchedAt } : null;
      })(),
      paths: { ...pathSummary(), ...memory.paths, backupDir: BACKUP_DIR },
      files: {
        pluginLog: fileInfo(PLUGIN_LOG),
        qqConfig: fileInfo(QQ_CONFIG),
          alignment: fileInfo(ALIGN_FILE),
        qqForBili: fileInfo(activeMemoryPaths().qqForBili),
      },
    };
  }

  // ── 配置读写 ────────────────────────────────────────────────────────────
  async function handleConfig(req, res) {
    if (req.method === 'GET') {
      json(res, 200, {
        ok: true, ...readAll(), paths: pathSummary(), backups: listBackups(20),
        // 保存时回传这些戳：服务端据此判断"加载之后配置有没有被别处改过"
        stamps: {
          qq: fileStamp(QQ_CONFIG),
            unified: fileStamp(path.join(STATE_DIR, 'config.json')),
        },
      });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    // 乐观并发：设置页加载后，如果配置被控制台/别的窗口改过，这里拒绝整份回写，
    // 否则会把别人的修改覆盖掉（2026-10-29：语音开关"自己回弹"）。
    const baseStamp = body?.baseStamp && typeof body.baseStamp === 'object' ? body.baseStamp : null;
    const currentStamps = {
      qq: fileStamp(QQ_CONFIG),
      unified: fileStamp(path.join(STATE_DIR, 'config.json')),
    };
    if (baseStamp) {
      const stale = ['qq', 'bili', 'unified'].filter((k) => isStale(baseStamp[k], currentStamps[k]));
      if (stale.length) {
        json(res, 409, {
          ok: false, code: 'CONFIG_STALE',
          error: `配置已被别处修改（${stale.join(' / ')}），本次保存未执行`,
          hint: '点「重新读取」拿到最新配置后再改；直接覆盖会丢掉别人的修改',
          stamps: currentStamps,
        });
        return;
      }
    }
    const result = { ok: true, saved: {}, warnings: [] };
    // ── 管理员：QQ ⇄ B站 默认是同一个人 ────────────────────────────────────
    // 合体层 admin 是唯一真相；旧格式（qq.ownerQQ / bili.owner）是投影。
    // 合并逻辑放在 src/admin-identity.js 的 projectAdminSave（纯函数，有单测），
    // 这里只负责把结果写回三份文件，避免「只改了一边」。
    // 管理员 B站 UID：显式拒绝非法值，别静默清空（用户会以为"填不进去"）
    const rawAdminMid = String(body?.unified?.admin?.biliMid ?? '').trim();
    if (rawAdminMid && !/^\d{4,20}$/.test(rawAdminMid)) {
      json(res, 400, {
        ok: false, code: 'admin.mid-invalid',
        error: `管理员 B站 UID「${rawAdminMid}」不合法`,
        hint: 'B站 UID 是 4~20 位数字（个人空间地址 space.bilibili.com/<数字>）；不要带字母或空格',
      });
      return;
    }

    const currentQq = readQqConfig().config;
    const currentUnifiedState = readUnified();
    const beforePlatformStart = platformStartState();
    // 合并默认值后 admin 永远存在（默认空串）；只有用户文件里明确写过才当"显式清空"，
    // 否则会把旧字段 ownerQQ / owner.mid 当成没配置，保存时把两边投影抹掉。
    const currentUnified = currentUnifiedState.hasAdmin
      ? currentUnifiedState.config
      : { ...currentUnifiedState.config, admin: undefined };
    const currentAdmin = adminFromSources({ unified: currentUnified, qq: currentQq });
    const planned = projectAdminSave({ current: currentAdmin, qq: body.qq, unified: body.unified });
    if (planned.conflict) {
      result.warnings.push('管理员卡片与高级参数同时改了 ownerQQ / owner.mid：已按管理员卡片对齐，两边会同时写成同一个人。');
    }
    body.qq = planned.qq;
    body.unified = planned.unified;
    if (body.qq && typeof body.qq === 'object') {
      if (body.qq.allow && typeof body.qq.allow === 'object') {
        const ownerForAllow = planned.unified?.admin?.qq || readQqConfig().config?.ownerQQ || '';
        const { allow, warnings } = normalizeAllowlist({ allow: body.qq.allow, ownerQQ: ownerForAllow });
        body.qq.allow = allow;
        for (const w of warnings) result.warnings.push(`白名单：${w.message}`);
      }
      const saved = saveQqConfig(body.qq);
      result.saved.qq = true;
      result.qq = saved.config;
      result.qqBackup = saved.backup;
      result.warnings.push('QQ 配置已保存；桥接只在启动时读 config.json，需要「重启桥接」才会生效。');
    }
    if (body.unified && typeof body.unified === 'object') {
      const saved = saveUnified(body.unified);
      result.saved.unified = true;
      result.unified = saved.config;
    }
    if (result.saved.unified) {
      try { writeAlignmentBriefs(); } catch (error) { result.warnings.push(`对齐简报重建失败：${error?.message ?? error}`); }
      startSyncTimer();
      // 改了记忆卡容量/注入上限后立刻重渲染，避免「设置保存了但提示词还是旧的」。
      try {
        const memoryCard = await runMemoryCardMaintenance({ config: readUnified().config.memoryCard });
        result.memoryCard = { status: memoryCard.status, changed: memoryCard.changed };
      } catch (error) {
        result.warnings.push(`记忆卡重渲染失败：${error?.message ?? error}`);
      }
      if (readUnified().config.memory?.qqToBili?.enabled === true) {
        try { result.qqMemory = syncQqToBili(); } catch (error) { result.warnings.push(`QQ→B站 同步失败：${error?.message ?? error}`); }
      }
    }
    // 平台启动开关的副作用：保存即生效（不是等下次重启）。
    // 用户关掉哪一边，就把正在跑的那一边停掉；重新打开则拉起来。
    // 这是「是否启动」和「只是改个参数」的区别，不能只写文件不执行。
    // 目的载体同理：切到桌宠后桥接下一次 tick 就不再自动出发（30 秒内生效），
    // 桌宠那边由 petPurpose 接手；不用重启桥接。
    if (result.saved.qq || result.saved.unified) {
      const afterCarrier = readQqConfig().config?.purpose?.carrier === 'pet' ? 'pet' : 'qq';
      const beforeCarrier = currentQq?.purpose?.carrier === 'pet' ? 'pet' : 'qq';
      result.purposeCarrier = afterCarrier;
      if (afterCarrier !== beforeCarrier) {
        result.warnings.push(afterCarrier === 'pet'
          ? '目的载体已切到「桌宠」：QQ 桥接不再自动主动搭话，改由桌宠气泡/语音发出（30 秒内生效，不用重启桥接）。'
          : '目的载体已切回「QQ」：桌宠不再主动搭话，改由桥接私聊你（30 秒内生效）。');
      }
    }
    const afterPlatformStart = platformStartState();
    result.platformStart = afterPlatformStart;
    if (result.saved.unified && process.env.SURFCORE_SKIP_AUTOSTART !== '1') {
      if (!afterPlatformStart.qq && beforePlatformStart.qq) {
        const stopped = await stopBridge();
        // 不要写 result.bridge：前端把它当成「已重启」并显示错误提示；启停单独记。
        result.bridgeStop = stopped;
        result.warnings.push(stopped.ok
          ? 'QQ 启动开关已关闭：QQ 桥接已停止。'
          : `QQ 启动开关已关闭，但桥接没停下来：${stopped.error ?? stopped.message ?? '未知'}`);
      } else if (afterPlatformStart.qq && !beforePlatformStart.qq && body.restartBridge !== true) {
        const started = await startBridge({ dshWebUrl: currentDshUrl() });
        result.bridgeStart = started;
        result.warnings.push(started.ok
          ? 'QQ 启动开关已打开：QQ 桥接已启动。'
          : `QQ 启动开关已打开，但桥接启动失败：${started.error ?? started.message ?? '未知'}`);
      }
    }
    if (body.restartBridge === true) {
      // 开关关掉时不允许「保存并重启」把 QQ 又拉起来；否则用户刚关的开关会被绕过。
      if (!platformStartEnabled('qq')) {
        result.warnings.push('QQ 启动开关已关闭：已跳过「保存并重启 QQ 桥接」。');
      } else {
        const restart = await restartBridge({ dshWebUrl: currentDshUrl() });
        result.bridge = restart;
        if (!restart.ok) result.warnings.push(`桥接重启失败：${restart.error ?? restart.message ?? '未知'}`);
      }
    }
    json(res, 200, result);
  }

  // ── 角色人格 ────────────────────────────────────────────────────────────
  async function handleCharacters(req, res, url) {
    if (req.method === 'GET') {
      const id = String(url.searchParams.get('id') ?? '').trim();
      try {
        json(res, 200, id ? characterDetail(id) : { ...characterOverview(), migration: characterMigration });
      } catch (error) {
        json(res, 404, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    let body = {};
    try { body = JSON.parse(await readBody(req, 16 * 1024 * 1024) || '{}'); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    const id = String(body.id ?? readCurrentCharacter()?.id ?? '').trim();
    try {
      if (action === 'create') {
        const created = createCharacterFromPayload(body);
        if (body.load === true) {
          const switched = await switchCharacterEverywhere(created.character.id);
          json(res, 200, { ok: true, created, switched });
        } else {
          json(res, 200, created);
        }
        return;
      }
      if (action === 'load') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, await switchCharacterEverywhere(id));
        return;
      }
      if (action === 'update') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, updateCharacterFromPayload(id, body));
        return;
      }
      if (action === 'snapshot') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, manualSnapshot(id, { label: String(body.label ?? '') }));
        return;
      }
      if (action === 'auto-snapshot') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, autoSnapshot(id, { force: body.force === true }));
        return;
      }
      if (action === 'restore') {
        if (!id) throw new Error('缺少角色 id');
        const current = readCurrentCharacter();
        if (!current || current.id !== id) throw new Error('只能回档当前角色；先加载这个角色再回档');
        const skipPlatform = process.env.SURFCORE_DISABLE_PLATFORM_RESTART === '1';
        const wasRunning = skipPlatform ? false : (await bridgeStatus()).running;
        await memoryCardIdle();
        if (wasRunning) {
          await stopAllBridgeSessions();
          const stopped = await stopBridge();
          if (!stopped.ok) {
                  throw new Error(`回档失败：QQ 桥接没停下来（${stopped.error || stopped.message || '未知原因'}）`);
          }
        }
        const restored = restoreCharacterSnapshot(id, String(body.slot ?? ''));
        writeCharacterRolePointer();
        archiveBridgeRuntimeState();
        await runMemoryCardMaintenance({}).catch((error) => pluginLog('回档后整理记忆卡失败：', error?.message ?? error));
        if (wasRunning) await startBridge({ dshWebUrl: currentDshUrl() });
        json(res, 200, { ...restored, bridgeRestarted: wasRunning });
        return;
      }
      if (action === 'migrate') {
        json(res, 200, ensureCharacterSystem());
        return;
      }
      if (action === 'delete') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, deleteCharacter(id));
        return;
      }
      json(res, 400, { ok: false, error: `未知 action：${action}` });
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 人设卡 ──────────────────────────────────────────────────────────────
  async function handleGroupPolicy(req, res) {
    try {
      if (req.method === 'GET') {
        const r = await callBridge('/api/socialV2/group-policy');
        if (!r.ok) {
          json(res, 502, { ok: false, code: 'GROUP_POLICY_BRIDGE', error: r.error || '桥接不可用', hint: '先启动 QQ 桥接，再刷新设置页' });
          return;
        }
        json(res, 200, r.data);
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await callBridge('/api/socialV2/group-policy', { method: 'POST', body });
        if (!r.ok) {
          json(res, 502, { ok: false, code: 'GROUP_POLICY_SAVE', error: r.error || '保存失败', hint: '检查桥接是否运行，再重试' });
          return;
        }
        json(res, 200, r.data);
        return;
      }
      json(res, 405, { ok: false, code: 'GROUP_POLICY_METHOD', error: '只支持 GET/POST' });
    } catch (error) {
      json(res, 400, { ok: false, code: 'GROUP_POLICY_FAILED', error: String(error?.message ?? error), hint: '检查桥接与配置' });
    }
  }

  async function handlePersonaClassify(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'PERSONA_CLASSIFY_METHOD', error: '只支持 POST', hint: '用角色页的「智能拆分」按钮' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let text = String(body.text ?? '');
    if (layer === 'daily') text = withDailyIdentity(text);
      const drafts = await personaClassifier.classify(text);
      drafts.daily = withDailyIdentity(drafts.daily);
      json(res, 200, { ok: true, drafts, note: '这是草稿；请检查/编辑后逐层保存。' });
    } catch (error) {
      json(res, 400, {
        ok: false,
        code: String(error?.code || 'PERSONA_CLASSIFY_FAILED'),
        error: String(error?.message ?? error),
        hint: String(error?.code || '').includes('UNAVAILABLE')
          ? '确认 DSH 模型服务已就绪；也可以手动填写各层'
          : '检查人格卡内容，或手动填写各层',
      });
    }
  }

  function personaIdentityLine() {
    const cur = readCurrentCharacter();
    const name = String(cur?.name || '').trim() || '这个角色';
    let admin = {};
    try {
      const unified = readUnified();
      const qq = readQqConfig();
      admin = adminSummary(unified?.config?.admin ?? qq?.config?.admin);
    } catch {}
    const owner = String(admin?.displayName || '').trim() || '主人';
    return `你是${name}；你的主人是${owner}。`;
  }

  function withDailyIdentity(text, identity = personaIdentityLine()) {
    const body = String(text ?? '').trim();
    if (!body) return identity;
    if (body.includes(identity)) return body;
    // 已有明确“我是谁/主人是谁”的旧日常也保留，不重复堆。
    if (/你是|我是/.test(body) && /主人/.test(body)) return body;
    return `${identity}

${body}`;
  }

  async function handleLimitMute(req, res) {
    if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'LIMIT_MUTE_METHOD', error: '只支持 POST' }); return; }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await callBridge('/api/socialV2/limit-mute', { method: 'POST', body });
      if (!r.ok) { json(res, 502, { ok: false, code: 'LIMIT_MUTE_BRIDGE', error: r.error || '桥接不可用', hint: '先启动/重启 QQ 桥接' }); return; }
      json(res, 200, r.data);
    } catch (error) {
      json(res, 400, { ok: false, code: 'LIMIT_MUTE_FAILED', error: String(error?.message ?? error), hint: '刷新错误报告后重试' });
    }
  }

  async function handlePersona(req, res) {
    const layerPaths = () => {
      const layers = activePersonaLayers();
      return layers ? {
        core: layers.core || resolvePersonaFile(),
        daily: layers.daily,
        tone: layers.tone,
        scenes: layers.scenes,
        scenesDir: layers.scenesDir,
      } : { core: resolvePersonaFile(), daily: '', tone: '', scenes: {}, scenesDir: '' };
    };
    const sceneLabels = { 'qq-group': 'QQ 群聊', 'qq-private': 'QQ 私聊', bili: 'B站', pet: '桌宠' };
    if (req.method === 'GET') {
      const paths = layerPaths();
      const core = readTextFile(paths.core);
      const daily = paths.daily ? withDailyIdentity(readTextFile(paths.daily)) : withDailyIdentity('');
      const scenes = {};
      for (const [id, file] of Object.entries(paths.scenes || {})) {
        scenes[id] = { path: file, text: readTextFile(file), chars: readTextFile(file).length };
      }
      const backups = listBackups(120).filter((item) => /^persona(?:-|$)/.test(item.name));
      json(res, 200, {
        ok: true,
        path: paths.core,
        text: core,
        chars: core.length,
        mtime: mtimeIso(paths.core),
        layers: {
          core: { path: paths.core, text: core, chars: core.length },
          tone: { path: paths.tone, text: readTextFile(paths.tone), chars: readTextFile(paths.tone).length },
          daily: { path: paths.daily, text: daily, chars: daily.length },
          scenes,
        },
        sceneLabels,
        backups,
        note: '人格卡分层：persona.md 是核心；persona.tone.md 是语气；persona.daily.md 是日常；persona.scenes/* 是场景。所有层都手动编辑，不会自动改写。',
      });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.action === 'restore') {
      const name = safeBackupName(body.name);
      if (!name) { json(res, 400, { ok: false, error: '备份名非法' }); return; }
      const source = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(source)) { json(res, 404, { ok: false, code: 'PERSONA_BACKUP_MISSING', error: '备份不存在', hint: '刷新备份列表后重试' }); return; }
      const paths = layerPaths();
      let target = paths.core;
      let label = 'persona';
      if (name.startsWith('persona-daily-')) { target = paths.daily; label = 'persona-daily'; }
      else if (name.startsWith('persona-tone-')) { target = paths.tone; label = 'persona-tone'; }
      else if (name.startsWith('persona-scene-')) {
        const scene = Object.keys(sceneLabels).find((id) => name.startsWith(`persona-scene-${id}-`));
        if (!scene) { json(res, 400, { ok: false, code: 'PERSONA_SCENE_UNKNOWN', error: '备份对应的场景未知', hint: '检查备份文件名' }); return; }
        target = paths.scenes?.[scene] || '';
        label = `persona-scene-${scene}`;
      }
      if (!target) { json(res, 400, { ok: false, code: 'PERSONA_LAYER_UNAVAILABLE', error: '这个层在当前角色里没有路径（可能未启用角色系统）', hint: '先创建/加载角色' }); return; }
      backupFile(target, label);
      fs.copyFileSync(source, target);
      const cur = readCurrentCharacter();
      if (cur) touchCharacter(cur.id);
      json(res, 200, { ok: true, restored: name, target, text: readTextFile(target), layers: layerPaths() });
      return;
    }
    const layer = String(body.layer || 'core');
    const scene = String(body.scene || '');
    const paths = layerPaths();
    let target = paths.core;
    let label = 'persona';
    if (layer === 'tone') {
      target = paths.tone;
      label = 'persona-tone';
    } else if (layer === 'daily') {
      target = paths.daily;
      label = 'persona-daily';
    } else if (layer === 'scene') {
      if (!sceneLabels[scene]) { json(res, 400, { ok: false, code: 'PERSONA_SCENE_UNKNOWN', error: `未知场景：${scene}`, hint: '只支持 qq-group / qq-private / bili / pet' }); return; }
      target = paths.scenes?.[scene] || '';
      label = `persona-scene-${scene}`;
    }
    if (!target) {
      json(res, 400, { ok: false, code: 'PERSONA_LAYER_UNAVAILABLE', error: '这个层在当前角色里没有路径（可能未启用角色系统）', hint: '先创建/加载角色' });
      return;
    }
    const text = String(body.text ?? '');
    if (layer === 'core' && text.length < 50) { json(res, 400, { ok: false, code: 'PERSONA_CORE_TOO_SHORT', error: '人格核心太短（至少 50 字）', hint: '核心卡是每次注入的底座，不能留空' }); return; }
    if (text.length > 64 * 1024) { json(res, 400, { ok: false, code: 'PERSONA_TOO_LARGE', error: '人格内容超过 64KB', hint: '拆成核心/场景/日常层，或精简内容' }); return; }
    const scan = scanText(text);
    const severe = scan.secrets.length > 0 || scan.pii.some((hit) => hit.severe);
    if (severe) {
      json(res, 400, {
        ok: false,
        code: 'PERSONA_SENSITIVE',
        error: '人格内容里命中密钥/密码/身份证/住址规则，拒绝保存',
        hint: '删掉这些内容后再保存；人格卡不应包含凭据',
        labels: [...new Set([...scan.secrets, ...scan.pii.filter((h) => h.severe)].map((h) => h.label))],
      });
      return;
    }
    const backup = backupFile(target, label);
        writeTextAtomic(target, text.endsWith('\n') ? text : `${text}\n`);
    const cur = readCurrentCharacter();
    if (cur) touchCharacter(cur.id);
    json(res, 200, { ok: true, layer, scene: layer === 'scene' ? scene : '', chars: text.length, backup, path: target, layers: layerPaths() });
  }

  // ── 记忆 ────────────────────────────────────────────────────────────────
  async function handleMemory(req, res, url) {
    if (req.method === 'GET') {
      const previewChars = Math.max(200, Math.min(20_000, Number(url.searchParams.get('chars')) || 4000));
      json(res, 200, {
        ok: true,
        status: memoryStatus(),
        qqPreview: previewQqForBili({ maxChars: previewChars }),
        biliPreview: biliToQqStatus().briefPreview,
        audit: auditTail(40),
        policyVersion: PRIVACY_POLICY_VERSION,
      });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.action === 'sync') {
      const result = syncQqToBili({ force: true });
      json(res, 200, result);
      return;
    }
    if (body.action === 'refresh-bili') {
      const result = await refreshBiliToQq({ callBridge });
      json(res, 200, result);
      return;
    }
    if (body.action === 'scan-align') {
      const qq = scanQqFeedForCandidates({ maxMessages: 1200 });
      json(res, 200, { ok: true, qq });
      return;
    }
    if (body.action === 'rebuild') {
      json(res, 200, { ok: true, ...rebuildAllPrompts() });
      return;
    }
    if (body.action === 'purge') {
      const feed = path.join(QQ_STATE_DIR(), 'qq-public-feed.jsonl');
      backupFile(activeMemoryPaths().qqForBili, 'qq-memory-before-purge');
      for (const file of [feed, activeMemoryPaths().qqForBili, path.join(activeMemoryPaths().dir, 'sync-state.json')]) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
      json(res, 200, { ok: true, purged: [feed, activeMemoryPaths().qqForBili].map(maskPath), note: '已清空 QQ→B站 记忆与原始公开 feed；对齐表不受影响。' });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 记忆卡（角色的长期记忆）──────────────────────────────────────────────
  // 和上面的「双向脱敏同步」不是一回事：memory 是 QQ⇄B站 的搬运；
  // memory-card 是她自己的记忆（冲浪 + 聊天 + 主人互动），带清晰度/遗忘/容量规则。
  async function handleMemoryCard(req, res) {
    const config = readUnified().config.memoryCard;
    if (req.method === 'GET') {
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    const action = String(body.action ?? '');
    if (action === 'maintain') {
      const result = await runMemoryCardMaintenance({ forceDecay: body.forceDecay === true, config });
      const snapshot = memoryCardSnapshot(config);
      json(res, 200, { ...snapshot, changed: result.changed, addedBili: result.addedBili, addedQq: result.addedQq, addedPet: result.addedPet });
      return;
    }
    if (action === 'compact') {
      const result = await compactMemoryCardNow({ targetRatio: Number(body.targetRatio) || 0.8, config });
      json(res, 200, { ...memoryCardSnapshot(config), steps: result.steps });
      return;
    }
    if (action === 'restore') {
      const result = await restoreMemoryCardBackup(String(body.name ?? ''), { config });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    if (action === 'notify-test') {
      const result = await notifyOwnerIfNeeded({ callBridge, config });
      json(res, 200, result);
      return;
    }
    if (['pin', 'forget', 'ack', 'add', 'set-first-meet', 'clear-first-meet', 'merge-memories'].includes(action)) {
      const result = await applyMemoryCardAction(action, body, { config });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 全量记忆卡（只存档；不参与日常提示词）───────────────────────────────
  async function handleMemoryCardFull(req, res, url) {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只读接口' }); return; }
    const q = String(url.searchParams.get('q') ?? '');
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 40));
    json(res, 200, fullMemoryCardSnapshot({ q, limit, config: readUnified().config.memoryCard }));
  }

  // ── 身份对齐 ────────────────────────────────────────────────────────────
  async function handleAlign(req, res) {
    if (req.method === 'GET') {
      json(res, 200, {
        ok: true,
        labelsSupported: true,
        links: listLinks(),
        candidates: listCandidates(),
        stats: alignStats(),
        platforms: platforms.list(),
        briefs: {
          qqChars: readTextFile(QQ_ALIGNMENT_BRIEF).length,
          biliChars: readTextFile(BILI_ALIGNMENT_FILE).length,
        },
      });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    const action = String(body.action ?? '');
    if (action === 'add') { json(res, 200, { ok: true, link: addLink(body.link ?? body) }); return; }
    if (action === 'update') { json(res, 200, { ok: true, link: updateLink(String(body.id), body.link ?? body.patch ?? {}) }); return; }
    if (action === 'remove') { json(res, 200, { ok: true, ...removeLink(String(body.id)) }); return; }
    if (action === 'approve') { json(res, 200, { ok: true, link: approveCandidate(String(body.id), body.overrides ?? {}) }); return; }
    if (action === 'reject') { json(res, 200, { ok: true, ...rejectCandidate(String(body.id)) }); return; }
    if (action === 'scan') {
      const qq = scanQqFeedForCandidates({ maxMessages: 1200 });
      json(res, 200, { ok: true, qq, candidates: listCandidates() });
      return;
    }
    if (action === 'import') { json(res, 200, { ok: true, state: importAlignments(body.payload ?? body.data, { merge: body.merge !== false }) }); return; }
    if (action === 'export') { json(res, 200, { ok: true, ...exportAlignments() }); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 模式 / ownerQQ ─────────────────────────────────────────────────────
  async function handleMode(req, res) {
    if (req.method === 'GET') {
      let dshSetting = null;
      try {
        const settings = ctx.get('settings');
        if (settings?.describe) {
          const rows = settings.describe({ redactSecrets: true });
          const row = rows.find((item) => item.ns === 'qq-mode');
          if (row) dshSetting = row.value;
        }
      } catch {}
      json(res, 200, { ok: true, ...parseModeState(), dshSetting });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    const mode = body.mode ? String(body.mode) : null;
    const ownerQQ = body.ownerQQ === undefined ? undefined : (body.ownerQQ === '' || body.ownerQQ === null ? null : String(body.ownerQQ));
    if (mode && !['chat', 'closed-agent', 'reserved', 'reserved2', 'simulation'].includes(mode)) {
      json(res, 400, { ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2 / simulation' });
      return;
    }
    const stateFile = path.join(QQ_STATE_DIR(), 'mode.json');
    const current = readJson(stateFile, {}) ?? {};
    const next = { ...current, ...(mode ? { mode } : {}) };
    writeJsonAtomic(stateFile, next);
    const settings = ctx.get('settings');
    if (settings?.update) {
      try {
        await settings.update('qq-mode', {
          ...(mode ? { mode } : {}),
          ...(ownerQQ !== undefined ? { ownerQQ: ownerQQ ?? '' } : {}),
        });
      } catch (error) {
        pluginLog('写 DSH qq-mode 设置失败（本地 mode.json 已写）：', error?.message ?? error);
      }
    }
    if (ownerQQ !== undefined) {
      const qq = readQqConfig().config;
      qq.ownerQQ = ownerQQ;
      saveQqConfig(qq);
    }
    if (mode) {
      try { await callBridge('/api/mode', { method: 'POST', body: { mode } }); } catch {}
    }
    json(res, 200, { ok: true, mode: mode ?? current.mode ?? null, ownerQQ: ownerQQ ?? null, note: '若桥接未运行，下次启动时生效。' });
  }

  // ── 扩展 ────────────────────────────────────────────────────────────────
  async function handleExtensions(req, res) {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, extensions: extensionHost.describe(), platforms: platforms.list(), dir: EXTENSIONS_DIR });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    const action = String(body.action ?? '');
    const id = String(body.id ?? '');
    if (action === 'toggle') { json(res, 200, { ok: true, result: await extensionHost.setEnabled(id, body.enabled === true), extensions: extensionHost.describe() }); return; }
    if (action === 'config') { json(res, 200, { ok: true, config: extensionHost.setConfig(id, body.config ?? {}) }); return; }
    if (action === 'reload') {
      await extensionHost.deactivate(id);
      const result = await extensionHost.activate(id);
      json(res, 200, { ok: true, result, extensions: extensionHost.describe() });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 诊断 / 备份 ─────────────────────────────────────────────────────────
  // ── 新手体检（只读）＋ 一键配置（只写"缺失项"，绝不覆盖已有值）────────────
  // 目标：新人装完点一下就知道"还差什么、在哪补"，不用去翻文档。
  function dshProfileWithSurfcore() {
    const root = path.join(DSH_HOME, 'profiles');
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => { try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; } }); } catch { return ''; }
    for (const name of names) {
      // 两种都能作为"已装进 DSH"的证据：
      //   ① profile package.json 的 dsh.profile.bundles 里有 surfcore；
      //   ② cordis.patch.yml 里有我们托管的 mcp 条目（不同版本写的是不同 id）。
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
        const bundles = pkg?.dsh?.profile?.bundles;
        if (Array.isArray(bundles) && bundles.includes('surfcore')) return name;
      } catch {}
      try {
        const patch = fs.readFileSync(path.join(root, name, 'cordis.patch.yml'), 'utf8');
        if (/surfcore|mcp-snowluma/.test(patch)) return name;
      } catch {}
    }
    return '';
  }

  async function installChecks() {
    const all = readAll();
    const qqCfg = readQqConfig().config ?? {};
    const snow = qqCfg.snowluma ?? {};
    let snowState = { state: 'unknown', hint: '' };
    try { snowState = await diagnoseSnowLuma(snow); } catch {}
    const bridgeSrc = path.join(QQBOT_ROOT, 'src', 'bridge.js');
    return buildInstallChecks({
      nodeVersion: process.versions.node,
      hasUnified: readUnified().hasUserFile,
      unifiedMasked: maskPath(UNIFIED_FILE),
      ownerQQ: String(all.unified?.admin?.qq ?? '').trim(),
      groups: Array.isArray(qqCfg.allow?.groups) ? qqCfg.allow.groups : [],
      privates: Array.isArray(qqCfg.allow?.private) ? qqCfg.allow.private : [],
      snow,
      snowState,
      bridgeSrc: fs.existsSync(bridgeSrc),
      bridgeMasked: maskPath(bridgeSrc),
      profile: dshProfileWithSurfcore(),
      token: String(qqCfg.consoleToken ?? '').trim(),
    });
  }

  let installJob = { running: false, startedAt: null, finishedAt: null, steps: [] };

  function installStep(key, name) {
    const step = { key, name, status: 'running', detail: '', at: new Date().toISOString() };
    installJob.steps.push(step);
    return step;
  }

  function runCommand(cmd, args, { cwd, timeoutMs = 600_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === 'win32' });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout?.on('data', (d) => { out += String(d).slice(0, 4000); });
      child.stderr?.on('data', (d) => { out += String(d).slice(0, 4000); });
      child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, out: String(error?.message ?? error) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
    });
  }

  async function runInstall(opts) {
    const done = (step, ok, detail = '') => { step.status = ok ? 'ok' : 'fail'; step.detail = String(detail).slice(0, 600); };
    try {
      // 1) 依赖
      const depsStep = installStep('deps', '安装依赖（npm install）');
      if (fs.existsSync(path.join(QQBOT_ROOT, 'node_modules', '.package-lock.json')) || fs.existsSync(path.join(QQBOT_ROOT, 'node_modules', 'express'))) {
        done(depsStep, true, '已经装过，跳过');
      } else {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const r = await runCommand(npm, ['install', '--no-audit', '--no-fund'], { cwd: QQBOT_ROOT, timeoutMs: 900_000 });
        done(depsStep, r.ok, r.ok ? '完成' : (r.out.slice(-400)));
        if (!r.ok) throw new Error('依赖安装失败');
      }

      // 2) 装进 DSH
      const dshStep = installStep('dsh', '装进 DSH（预设 / MCP / bundle）');
      if (dshProfileWithSurfcore()) {
        done(dshStep, true, '已注册，跳过');
      } else {
        // profile 必须跟着"当前 DSH 用的那个"走：setup-dsh 默认写 web，
        // 而用户可能是 desktop/自定义 profile —— 写错地方插件根本不会出现。
        let profile = String(process.env.DSH_PROFILE ?? '').trim();
        if (!profile) {
          try {
            const names = fs.readdirSync(path.join(DSH_HOME, 'profiles')).filter((n) => fs.statSync(path.join(DSH_HOME, 'profiles', n)).isDirectory() && !n.includes('.'));
            profile = names.includes('web') ? 'web' : (names[0] ?? 'web');
          } catch { profile = 'web'; }
        }
        const r = await runCommand(process.execPath, [path.join(QQBOT_ROOT, 'scripts', 'setup-dsh.mjs'), profile], { cwd: QQBOT_ROOT, timeoutMs: 120_000 });
        done(dshStep, r.ok, r.ok ? '已注册（重启 DSH 生效）' : (r.out.slice(-400)));
      }

      // 3) 配置与令牌
      const cfgStep = installStep('config', '生成配置 / 控制台令牌');
      const changed = doctorFix({ ownerQQ: opts.ownerQQ });
      done(cfgStep, true, changed.length ? changed.join('、') : '已经齐了');

      // 4) SnowLuma 端点 / token
      const snowStep = installStep('snowluma', '发现并写入 SnowLuma 连接');
      try {
        const found = await discoverSnowLumaConnection({ cfg: readQqConfig().config ?? {}, timeoutMs: 4000 });
        if (found.ok) {
          const snow = { httpUrl: found.baseUrl };
          if (found.wsUrl) snow.wsUrl = found.wsUrl;
          if (found.token) snow.accessToken = found.token;
          saveQqConfig({ snowluma: snow });
          done(snowStep, true, `已连上 ${found.self?.nickname ?? ''}（${found.self?.user_id ?? ''}）`);
        } else {
          done(snowStep, false, String(found.error ?? '没连上：先启动 SnowLuma 并扫码登录'));
        }
      } catch (error) { done(snowStep, false, String(error?.message ?? error)); }

      // 5) 主人 + 白名单
      const idStep = installStep('identity', '写入主人 QQ 与白名单');
      if (opts.groups.length) {
        // 保留用户已有私聊白名单，只追加主人（2026-10-31：以前 [owner] 整体替换会冲掉用户加的人）
        const { allow, warnings } = normalizeAllowlist({
          allow: { ...(readQqConfig().config?.allow ?? {}), groups: opts.groups },
          ownerQQ: opts.ownerQQ,
        });
        saveQqConfig({ allow });
        for (const w of warnings) pluginLog(`[安装] 白名单：${w.code} ${w.message}`);
        done(idStep, true, `${opts.groups.length} 个群${opts.ownerQQ ? ' + 主人私聊' : ''}${warnings.length ? `（${warnings.length} 条修正）` : ''}`);
      } else {
        done(idStep, true, '没选群，跳过（之后在设置 → QQ → 白名单里加）');
      }

      // 6) 可选：语音包 / 桌宠（只报告状态，不自动下 GB 级内容）
        
      // 7) 起桥接
      const bridgeStep = installStep('bridge', '启动 QQ 桥接');
      try {
        const before = await bridgeStatus().catch(() => ({ running: false }));
        if (before.running) done(bridgeStep, true, `已在运行（端口 ${before.port}）`);
        else {
          await startBridge({ dshWebUrl: currentDshUrl() });
          done(bridgeStep, true, '已启动');
        }
      } catch (error) { done(bridgeStep, false, String(error?.message ?? error)); }
    } catch (error) {
      const last = installJob.steps[installJob.steps.length - 1];
      if (last && last.status === 'running') { last.status = 'fail'; last.detail = String(error?.message ?? error); }
    } finally {
      installJob.running = false;
      installJob.finishedAt = new Date().toISOString();
    }
  }

  function doctorFix(body) {
    const all = readAll();
    const qqCfg = readQqConfig().config ?? {};
    const actions = planDoctorFix({
      hasUnified: readUnified().hasUserFile,
      hasToken: Boolean(String(qqCfg.consoleToken ?? '').trim()),
      ownerQQ: body?.ownerQQ,
      currentOwnerQQ: all.unified?.admin?.qq,
    });
    for (const action of actions) {
      if (action.startsWith('生成统一配置')) saveUnified({});
      else if (action.startsWith('生成控制台令牌')) saveQqConfig({ consoleToken: randomUUID().replace(/-/g, '') });
      else if (action.startsWith('写入管理员 QQ')) saveUnified({ admin: { qq: String(body.ownerQQ).trim() } });
    }
    return actions;
  }

  async function handleDiagnostics(req, res) {
    if (req.method === 'GET') {
      const checks = [];
      const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
      add('插件目录', fs.existsSync(PLUGIN_ROOT), PLUGIN_ROOT);
      add('surfcore 根目录', fs.existsSync(QQ_CONFIG), maskPath(QQ_CONFIG));
      add('QQ 桥接源码', fs.existsSync(path.join(path.dirname(QQ_CONFIG), 'src', 'bridge.js')), 'src/bridge.js');
            add('人设卡', fs.existsSync(resolvePersonaFile()), maskPath(resolvePersonaFile()));
      add('身份对齐表', fs.existsSync(ALIGN_FILE), maskPath(ALIGN_FILE));
      const qqMemoryOn = readAll().unified.memory?.qqToBili?.enabled === true;
      add('QQ→B站记忆', qqMemoryOn ? fs.existsSync(activeMemoryPaths().qqForBili) : true,
        qqMemoryOn ? maskPath(activeMemoryPaths().qqForBili) : '未开启（正常）');
      add('B站→QQ简报', fs.existsSync(path.join(activePlatformStateDir(QQ_STATE_DIR()), 'bili-memory-brief.md')), '当前角色 bili/bili-memory-brief.md');
      let ffmpeg = false;
      try {
        const result = await new Promise((resolve) => execFile('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }, (error) => resolve(!error)));
        ffmpeg = result;
      } catch {}
      add('ffmpeg（可选）', ffmpeg, ffmpeg ? '可用' : '未安装：只影响“抽帧看画面”');
      let bridge = { running: false };
      try { bridge = await bridgeStatus(); } catch {}
      add('QQ 桥接', bridge.running, bridge.running ? `端口 ${bridge.port}` : '未运行');
      const all = readAll();
      add('隐私策略', PRIVACY_POLICY_VERSION >= 3, `v${PRIVACY_POLICY_VERSION}（私信/密钥/PII 一律不跨平台）`);
      const install = await installChecks();

      // 同名检查只留一条（installChecks 与旧 checks 有重叠，比如"QQ 桥接源码"）。
      const seen = new Set();
      const allChecks = [...install, ...checks].filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
      json(res, 200, { ok: allChecks.every((c) => c.ok || c.name.includes('可选')), checks: allChecks, installOk: installOk(install), install: installJob, bridge, paths: pathSummary() });
      return;
    }
    const body = JSON.parse(await readBody(req) || '{}');
    // ── 一键安装：发现 SnowLuma → 拉群 → 写配置（只写这一台机器上真实存在的群）
    if (body.action === 'install-scan') {
      const cfg = readQqConfig().config ?? {};
      let found = { ok: false, error: '未探测' };
      try { found = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 }); } catch (error) { found = { ok: false, error: String(error?.message ?? error) }; }
      let groups = [];
      if (found.ok) {
        try {
          const resp = await fetch(`${found.baseUrl}/get_group_list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(found.token ? { Authorization: `Bearer ${found.token}` } : {}) },
            body: '{}',
          });
          const data = await resp.json().catch(() => ({}));
          groups = (Array.isArray(data?.data) ? data.data : [])
            .map((g) => ({ id: String(g.group_id ?? ''), name: String(g.group_name ?? '') }))
            .filter((g) => /^\d{5,15}$/.test(g.id));
        } catch {}
      }
      json(res, 200, {
        ok: found.ok,
        error: found.ok ? '' : String(found.error ?? '连不上 SnowLuma'),
        snow: {
          online: Boolean(found.ok),
          uin: String(found.self?.user_id ?? ''),
          nickname: String(found.self?.nickname ?? ''),
          httpUrl: found.baseUrl ?? '',
          wsUrl: found.wsUrl ?? '',
          hasToken: Boolean(found.token),
          wsToken: Boolean(found.wsToken),
        },
        groups,
      });
      return;
    }
    // ── 一键安装：把整机装成"能用"的状态（依赖 → 装进 DSH → 配置 → SnowLuma → 白名单 → 桥接）
    if (body.action === 'install-run') {
      if (installJob.running) { json(res, 200, { ok: true, install: installJob }); return; }
      const opts = {
        ownerQQ: String(body.ownerQQ ?? '').trim(),
        groups: (Array.isArray(body.groups) ? body.groups : []).map((g) => String(g ?? '').trim()).filter((g) => /^\d{5,15}$/.test(g)),
          pet: body.pet === true,
      };
      installJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, steps: [] };
      void runInstall(opts);
      json(res, 200, { ok: true, install: installJob });
      return;
    }
    if (body.action === 'install-apply') {
      const changed = [];
      const cfg = readQqConfig().config ?? {};
      // 1) 端点 / token：服务端再发现一次（不把 token 交给浏览器）
      if (body.discoverSnow !== false) {
        try {
          const found = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
          if (found.ok) {
            const snow = { httpUrl: found.baseUrl };
            if (found.wsUrl) snow.wsUrl = found.wsUrl;
            if (found.token) snow.accessToken = found.token;
            saveQqConfig({ snowluma: snow });
            changed.push('写入 SnowLuma 地址与 token');
          }
        } catch {}
      }
      // 2) 主人 QQ（用户确认过的才写）
      const owner = String(body.ownerQQ ?? '').trim();
      if (/^\d{5,15}$/.test(owner)) {
        saveUnified({ admin: { qq: owner } });
        changed.push('写入管理员 QQ');
      }
      // 3) 白名单：只写用户点过 confirm 的那些群
      const groups = (Array.isArray(body.groups) ? body.groups : [])
        .map((g) => String(g ?? '').trim())
        .filter((g) => /^\d{5,15}$/.test(g));
      if (body.applyGroups && groups.length) {
        // 同样保留现有私聊白名单（2026-10-31 反馈：安装/诊断修复后用户加的人丢失）
        const { allow, warnings } = normalizeAllowlist({
          allow: { ...(cfg.allow ?? {}), groups },
          ownerQQ: owner || cfg.ownerQQ || '',
        });
        saveQqConfig({ allow });
        for (const w of warnings) pluginLog(`[install-apply] 白名单：${w.code} ${w.message}`);
        changed.push(`写入白名单（${groups.length} 个群${owner ? ' + 主人私聊' : ''}${warnings.length ? `，${warnings.length} 条修正` : ''}）`);
      }
      // 4) 配置骨架 / 控制台令牌
      for (const action of doctorFix({ ownerQQ: owner })) {
        if (!changed.includes(action)) changed.push(action);
      }
      json(res, 200, { ok: true, changed, needRestart: changed.some((c) => /DSH|白名单/.test(c)) });
      return;
    }
    if (body.action === 'doctor-fix') {
      const changed = doctorFix(body);
      json(res, 200, { ok: true, changed, restartRequired: changed.length > 0 });
      return;
    }
    if (body.action === 'backup') {
      const created = [];
      for (const [label, file] of [
        ['qq-config', QQ_CONFIG], ['unified-config', path.join(STATE_DIR, 'config.json')],
        ['persona', resolvePersonaFile()], ['alignments', ALIGN_FILE],
        ['qq-memory', activeMemoryPaths().qqForBili], ['qq-alignment', QQ_ALIGNMENT_BRIEF],
      ]) {
        const out = backupFile(file, label);
        if (out) created.push({ label, file: maskPath(out) });
      }
      json(res, 200, { ok: true, created });
      return;
    }
    if (body.action === 'restore') {
      const name = safeBackupName(body.name);
      if (!name) { json(res, 400, { ok: false, error: '备份名非法' }); return; }
      const source = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(source)) { json(res, 404, { ok: false, code: 'PERSONA_BACKUP_MISSING', error: '备份不存在', hint: '刷新备份列表后重试' }); return; }
      const map = [
        ['qq-config-', QQ_CONFIG], ['unified-config-', path.join(STATE_DIR, 'config.json')],
        ['persona-', resolvePersonaFile()], ['alignments-', ALIGN_FILE],
      ];
      const hit = map.find(([prefix]) => name.startsWith(prefix));
      if (!hit) { json(res, 400, { ok: false, error: '这个备份不支持一键恢复（请手动复制）' }); return; }
      backupFile(hit[1], 'before-restore');
      fs.copyFileSync(source, hit[1]);
      json(res, 200, { ok: true, restored: name, target: maskPath(hit[1]) });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── SnowLuma 启动（只打开本机已安装程序，不安装、不部署、不代扫码）──────
  // 默认关闭；必须用户在设置页显式开启 snowluma.allowLaunch，且只在点击
  // 「一键启动 / 打开 SnowLuma」时执行。源码/测试里的 L6 边界仍保持：
  // MCP 工具面没有 start_snowluma，桥接本身也只探测不启动。
  function portOpen(port, timeout = 600) {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  function resolveSnowLumaLauncher() {
    const cfg = readQqConfig().config?.snowluma ?? {};
    const explicit = String(cfg.launchScript ?? '').trim();
    if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(QQBOT_ROOT, explicit);
    const base = String(cfg.launcherPath ?? '').trim();
    if (!base) return '';
    const root = path.isAbsolute(base) ? base : path.resolve(QQBOT_ROOT, base);
    const candidates = [
      path.join(root, 'app', 'launcher.bat'),
      path.join(root, 'launcher.bat'),
      path.join(root, 'SnowLuma.exe'),
    ];
    return candidates.find((file) => { try { return fs.existsSync(file); } catch { return false; } }) ?? '';
  }

  // SnowLuma 安装位置识别：规则在 snowluma-install.js（「检测」与「浏览…」共用同一套，
  // 避免两边各猜各的）。这里只负责把当前 QQ 配置喂进去。
  function findSnowLumaInstall(extraPaths = []) {
    const snow = readQqConfig().config?.snowluma ?? {};
    return findSnowLumaInstallIn({ snowluma: snow, extraPaths });
  }

  // SnowLuma 没有原生窗口，它的界面是 WebUI（默认 http://127.0.0.1:5100）。
  // 端口从 SnowLuma 自己的 runtime.json 读，读不到就回退 5100。
  function snowLumaWebui() {
    const cfg = readQqConfig().config?.snowluma ?? {};
    let port = 5100;
    try {
      const root = String(cfg.launcherPath ?? '').trim();
      if (root) {
        const runtime = JSON.parse(fs.readFileSync(path.join(root, 'app', 'config', 'runtime.json'), 'utf8'));
        if (Number(runtime?.webuiPort) > 0) port = Number(runtime.webuiPort);
      }
    } catch {}
    return { port, url: `http://127.0.0.1:${port}` };
  }

  // 只用系统默认浏览器打开本地回环地址；URL 由端口拼出，不接受外部输入。
  function openLocalUrl(url) {
    if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return false;
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(url))) return false;
    try {
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', `"${url}"`], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
      return true;
    } catch {
      return false;
    }
  }

  // SnowLuma 连不上时到底卡在哪一步：进程没起 / 停在登录页 / token 或端口不对。
  // 桥接的 goodError 只有一句 fetch failed，光看它没法给用户任何可执行的信息。
  async function diagnoseSnowLuma(bridgeSnow = {}) {
    if (bridgeSnow.connected === true) return { state: 'ok', hint: '' };
    const webui = snowLumaWebui();
    const onebot = (await portOpen(3000)) || (await portOpen(3001));
    const webuiUp = await portOpen(webui.port);
    if (onebot) {
      return {
        state: 'onebot-rejected',
        hint: 'OneBot 端口在监听但桥接连不上：多半是 accessToken 不匹配（对齐 config.json 的 snowluma.accessToken），或 httpUrl 指到了 WebSocket 端口',
      };
    }
    if (webuiUp) {
      return { state: 'needs-login', hint: `SnowLuma 已启动但还没登录：打开 ${webui.url} 扫码/登录` };
    }
    return { state: 'not-running', hint: 'SnowLuma 没在运行：设置 → SurfCore → 概览 → 一键启动（会按需打开控制台）' };
  }

  async function launchSnowLuma() {
    if (process.env.SURFCORE_SKIP_AUTOSTART === '1') {
      return { ok: true, skipped: true, message: '测试环境：跳过打开 SnowLuma' };
    }
    const cfg = readQqConfig().config?.snowluma ?? {};
    if (cfg.allowLaunch !== true) {
      return { ok: false, error: '未开启「允许插件打开 SnowLuma」：设置 → SurfCore → QQ → SnowLuma' };
    }
    const webui = snowLumaWebui();

    // 已登录（OneBot 3000/3001 在听）：什么都不用做，也别弹窗口。
    if (await portOpen(3000) || await portOpen(3001)) {
      return { ok: true, already: true, opened: false, message: 'SnowLuma 已在运行且已登录' };
    }

    // 进程在、但 OneBot 没起 → 多半停在登录页：直接把 WebUI 打开让人扫码。
    if (await portOpen(webui.port)) {
      const opened = openLocalUrl(webui.url);
      return {
        ok: true,
        needsLogin: true,
        opened,
        webui: webui.url,
        message: opened ? `SnowLuma 在登录页，已打开控制台 ${webui.url}` : `SnowLuma 在登录页：请打开 ${webui.url} 扫码`,
      };
    }

    const launcher = resolveSnowLumaLauncher();
    if (!launcher) {
      return { ok: false, error: '找不到 SnowLuma 启动脚本：请在设置里填「SnowLuma 安装目录」或「启动脚本」' };
    }
    try {
      const cwd = path.dirname(launcher);
      const lower = launcher.toLowerCase();
      if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
        // 2026-10-22 审计：旧写法把 basename 拼进 cmd 命令串，路径里带 `&` 可注入命令。
        // 现在整条路径作为「verbatim 参数」交给 cmd，并且拒绝含引号/换行的路径。
        if (/["\r\n]/.test(launcher)) return { ok: false, error: '启动脚本路径含引号或换行，拒绝执行' };
        spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', `"${launcher}"`], {
          cwd, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
        }).unref();
      } else {
        spawn(launcher, [], { cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref();
      }
      // 等 WebUI 端口起来（最多 10 秒）：起来了就打开浏览器；没起来也给出地址让用户自己点。
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (await portOpen(webui.port)) {
          const opened = openLocalUrl(webui.url);
          return {
            ok: true,
            started: true,
            opened,
            webui: webui.url,
            launcher,
            message: opened ? `已启动 SnowLuma 并打开控制台 ${webui.url}` : `已启动 SnowLuma：${webui.url}`,
          };
        }
      }
      return { ok: true, started: true, pending: true, webui: webui.url, launcher, message: `已启动 SnowLuma，控制台稍后可访问：${webui.url}` };
    } catch (error) {
      return { ok: false, error: `打开 SnowLuma 失败：${error?.message ?? error}` };
    }
  }

  // ── 启动完成弹窗 ────────────────────────────────────────────────────────
  // 用 wscript 的 WScript.Shell.Popup：独立 GUI 窗口，不弹控制台，不依赖 DSH。
  function showStartupPopup(title, text, seconds = 30) {
    if (process.platform !== 'win32' || process.env.SURFCORE_SKIP_AUTOSTART === '1') return false;
    try {
      const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
      if (!fs.existsSync(wscript)) return false;
      const esc = (value) => String(value ?? '').replace(/"/g, '""');
      const body = String(text ?? '').replace(/\r?\n/g, '" & vbCrLf & "');
      const vbs = [
        'Set sh = CreateObject("WScript.Shell")',
        // 64 = vbInformation，4096 = vbSystemModal：强制置顶，避免弹到 DSH 后面。
        `sh.Popup "${body}", ${Math.max(5, Math.round(seconds))}, "${esc(title)}", ${64 + 4096}`,
        '',
      ].join('\r\n');
      const file = path.join(os.tmpdir(), `surfcore-startup-${process.pid}-${Date.now()}.vbs`);
      // VBScript 在 wscript 下按 UTF-16LE + BOM 读最稳，中文不会乱码。
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbs, 'utf16le')]));
      const child = spawn(wscript, ['//nologo', file], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      pluginLog(`启动弹窗已请求：${title}（pid ${child.pid ?? '?'}，${seconds}s）`);
      setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 120000).unref?.();
      return true;
    } catch (error) {
      pluginLog('启动弹窗失败：', error?.message ?? error);
      return false;
    }
  }

  let startupWatcher = null;
  async function watchStartupCompletion({ qq = true, bili = true } = {}) {
    if (startupWatcher) return startupWatcher;
    startupWatcher = (async () => {
      try {
        const notify = readUnified().config.bridge?.startupNotify !== false;
        if (!notify || (!qq && !bili)) return;
        // DSH 重启/桥接切端口时，鉴权握手可能比 90 秒慢；给 3 分钟，
        // 并在超时前再做一次 final check，避免把“还在连”误报成“DSH 未连接”。
        const until = Date.now() + 180_000;
        const qqReady = (bridge) => {
          const snow = bridge?.snowluma ?? {};
          return Boolean(bridge?.running && bridge?.ok !== false && bridge?.dshReady === true
            && snow.connected === true && snow.accountOnline === true);
        };
        const allReady = (bridge) => Boolean(!qq || qqReady(bridge));
        const successLines = (bridge) => {
          const snow = bridge?.snowluma ?? {};
          return [
            '全部启动成功 ✓',
            '',
            ...(qq ? [
              `QQ 桥接：运行中（端口 ${bridge.port ?? 3100}，DSH 已连接）`,
              `SnowLuma：已连接，QQ ${snow.accountOnline ? '在线' : '离线'}`,
            ] : ['QQ：启动开关关闭（未启动）']),
          ];
        };
        let last = null;
        while (Date.now() < until) {
          const bridge = await bridgeStatus().catch((error) => ({ ok: false, running: false, error: String(error?.message ?? error) }));
          last = { bridge };
          if (allReady(bridge)) {
            const snow = bridge?.snowluma ?? {};
            pluginLog(`启动检查通过：qq=${qq} bili=${bili} DSH=${bridge.dshBaseUrl ?? '?'} SnowLuma=${snow.connected} 账号=${snow.accountOnline}`);
            showStartupPopup('SurfCore 启动完成', successLines(bridge).join('\n'), 30);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        // 最后一次补查：桥接可能刚好在超时边界上完成 DSH 握手。
        try {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const bridge = await bridgeStatus().catch(() => null);
          if (bridge) last = { bridge };
          if (bridge && allReady(bridge)) {
            showStartupPopup('SurfCore 启动完成', successLines(bridge).join('\n'), 30);
            return;
          }
        } catch {}
        const bridge = last?.bridge ?? {};
        const snow = bridge.snowluma ?? {};
        const snowDiag = await diagnoseSnowLuma(snow).catch(() => ({ state: 'unknown', hint: '' }));
        pluginLog(`启动检查未通过：qq=${qq} bili=${bili} running=${Boolean(bridge.running)} dshReady=${Boolean(bridge.dshReady)} dshBaseUrl=${bridge.dshBaseUrl ?? '?'} snow=${Boolean(snow.connected)} snowState=${snowDiag.state} account=${Boolean(snow.accountOnline)}`);
        showStartupPopup('SurfCore 启动状态', [
          '还没全部就绪：',
          '',
          ...(qq ? [
            `QQ 桥接：${bridge.running ? (bridge.ok ? '运行中' : '运行中但状态异常') : '未运行'}`,
            `DSH：${bridge.dshReady
              ? '已连接'
              : (bridge.dshBaseUrl && bridge.dshBaseUrl !== currentDshUrl()
                ? `桥接还连着旧端口 ${bridge.dshBaseUrl}（当前 ${currentDshUrl()}）`
                : 'DSH 已打开，但桥接还在鉴权/等待连接')}`,
            `SnowLuma：${snow.connected ? '已连接' : `未就绪（${snowDiag.state}）`}`,
            ...(snowDiag.hint ? [`   → ${snowDiag.hint}`] : []),
          ] : ['QQ：启动开关关闭（未启动）']),
        ].join('\n'), 40);
      } catch (error) {
        pluginLog('启动完成检查失败：', error?.message ?? error);
      } finally {
        startupWatcher = null;
      }
    })();
    return startupWatcher;
  }

  // ── 桥接控制 ────────────────────────────────────────────────────────────

  // 原生「浏览目录 / 选择文件」——浏览器拿不到绝对路径，只能由宿主进程弹 Windows 对话框。
  // 仅 Windows 且 DSH 跑在本机时有意义；其它情况返回可读错误，前端提示手动填。
  //
  // 路径不能走 PowerShell stdout：Windows PowerShell 5.1 重定向时用 OEM/GBK 编码，
  // Node 按 UTF-8 解码，中文目录会变成 `�`，后端 fsp.stat 直接 ENOENT（2026-10-29 反馈）。
  // 改成：PowerShell 把选中路径写进临时 UTF-8 文件，Node 读文件后删除；彻底绕开控制台编码。
  async function handleBrowse(req, res, url) {
    const mode = url.searchParams.get('mode') === 'file' ? 'file' : 'dir';
    const title = url.searchParams.get('title') || (mode === 'file' ? '选择文件' : '选择目录');
    // 文件过滤只认枚举（目前只有 snowluma）：不接受任意 filter 串，避免用户被诱导选错类型。
    const filterKey = String(url.searchParams.get('filter') || '').trim().toLowerCase();
    const fileFilter = filterKey === 'snowluma'
      ? 'SnowLuma 启动文件 (SnowLuma.exe;launcher.bat)|SnowLuma.exe;launcher.bat|所有文件 (*.*)|*.*'
      : '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*';
    if (process.platform !== 'win32') {
      json(res, 200, { ok: false, error: '只有 Windows 支持原生选择框，请手动填路径' });
      return;
    }
    const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const outFile = path.join(os.tmpdir(), `surfcore-browse-${process.pid}-${randomUUID()}.txt`);
    const writeOut = (expr) => `[System.IO.File]::WriteAllText(${psQuote(outFile)}, ${expr}, (New-Object System.Text.UTF8Encoding -ArgumentList $false))`;
    const ps = mode === 'file'
      ? `Add-Type -AssemblyName System.Windows.Forms;
$d = New-Object System.Windows.Forms.OpenFileDialog;
$d.Title = ${psQuote(title)};
$d.Filter = ${psQuote(fileFilter)};
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${writeOut('$d.FileName')} }`
      : `Add-Type -AssemblyName System.Windows.Forms;
$d = New-Object System.Windows.Forms.FolderBrowserDialog;
$d.Description = ${psQuote(title)};
$d.ShowNewFolderButton = $true;
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${writeOut('$d.SelectedPath')} }`;
    const child = execFile('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { windowsHide: true, timeout: 180_000 }, (error) => {
      let picked = '';
      try { picked = String(fs.readFileSync(outFile, 'utf8')).replace(/^\uFEFF/, '').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      if (error && !picked) json(res, 200, { ok: false, error: `选择框打不开：${String(error.message || error).slice(0, 160)}` });
      else if (!picked) json(res, 200, { ok: false, cancelled: true, error: '已取消' });
      else json(res, 200, { ok: true, path: picked });
    });
    child.on('error', () => {
      try { fs.unlinkSync(outFile); } catch {}
      json(res, 200, { ok: false, error: '无法启动 PowerShell（可能不在本机桌面）' });
    });
  }


  // ── 目的机制（设置页「目的」）：载体现固定为 QQ 桥接 ─────────────
  async function purposeAvailability() {
    let bridge = null;
    try { bridge = await bridgeStatus(); } catch (error) { bridge = { ok: false, running: false, error: String(error?.message ?? error) }; }
    return {
      qq: {
        running: Boolean(bridge?.running),
        mode: bridge?.mode || bridge?.status?.mode || null,
        ok: bridge?.ok !== false,
        error: bridge?.error || '',
      },
    };
  }

  async function handlePurpose(req, res, url) {
    const suffix = url.pathname.slice(`${API_PREFIX}/purpose`.length) || '/status';
    const method = String(req.method || 'GET').toUpperCase();
    const availability = await purposeAvailability();
    try {
      if (suffix === '/status' && method === 'GET') {
        if (!availability.qq.running) {
          json(res, 200, {
            ok: false,
            source: 'qq',
            carrier: 'qq',
            availability,
            error: 'QQ 桥接没在运行：先在「QQ」页启动',
            config: readQqConfig().config?.purpose ?? {},
            state: null,
          });
          return;
        }
        const remote = await callBridge('/api/purpose/status', { timeoutMs: 8000 });
        const data = remote?.data ?? {};
        json(res, remote?.status || 200, {
          ...data,
          source: 'qq',
          carrier: 'qq',
          availability,
          ok: data.ok !== false,
          error: data.ok === false ? (data.error || '读取目的状态失败') : '',
        });
        return;
      }
      if (suffix === '/preview' && method === 'POST') {
        if (!availability.qq.running) {
          json(res, 409, { ok: false, error: 'QQ 桥接没在运行，无法预览 QQ 载体的目的回合', availability });
          return;
        }
        const remote = await callBridge('/api/purpose/preview', { method: 'POST', body: {}, timeoutMs: 20000 });
        json(res, remote?.status || 200, { ...(remote?.data ?? {}), source: 'qq', carrier: 'qq', availability });
        return;
      }
      if (suffix === '/run' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!availability.qq.running) {
          json(res, 409, { ok: false, error: 'QQ 桥接没在运行，无法让 QQ 载体出发', availability });
          return;
        }
        const remote = await callBridge('/api/purpose/run', { method: 'POST', body: { force: body.force !== false }, timeoutMs: 30000 });
        json(res, remote?.status || 200, { ...(remote?.data ?? {}), source: 'qq', carrier: 'qq', availability });
        return;
      }
      json(res, 404, { ok: false, error: `未知目的接口：${suffix}` });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 一键启动 / 停止（概览、QQ 共用同一份状态）────────────
  const LAUNCH_IDS = ['qq'];
  const LAUNCH_LABELS = { qq: 'QQ（含 SnowLuma）' };

  function normalizeLaunchComponents(input) {
    const list = Array.isArray(input) ? input : [];
    const picked = list.map((x) => String(x)).filter((x) => LAUNCH_IDS.includes(x));
    return [...new Set(picked)];
  }

  async function launchStatus() {
    const bridge = await bridgeStatus().catch((error) => ({ running: false, error: String(error?.message ?? error) }));
    return {
      qq: {
        running: Boolean(bridge.running),
        ok: Boolean(bridge.running && bridge.ok !== false),
        port: bridge.port ?? null,
        pid: bridge.pid ?? bridge.lockPid ?? null,
        snowluma: bridge.snowluma ?? null,
        lastError: bridge.error ?? null,
      },
    };
  }

  function launchItem(id, ok, extra = {}) {
    return { id, label: LAUNCH_LABELS[id] || id, ok: ok !== false, ...extra };
  }

  async function startComponent(id, opts = {}) {
    try {
      if (id === 'qq') {
        if (!platformStartEnabled('qq')) {
          return launchItem(id, false, { code: 'PLATFORM_DISABLED', error: 'QQ 启动开关已关闭', hint: '去「QQ」页打开「启动 QQ」并保存' });
        }
        const status = await bridgeStatus();
        const stale = bridgeStaleReason(status);
        const bridge = stale ? await restartBridge({ dshWebUrl: currentDshUrl() }) : await startBridge({ dshWebUrl: currentDshUrl() });
        const snowluma = await launchSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error), hint: '检查 SnowLuma 安装目录/允许插件打开设置' }));
        const bridgeOk = bridge?.ok !== false;
        const snowOk = snowluma?.ok !== false || snowluma?.skipped === true || snowluma?.already === true;
        return launchItem(id, bridgeOk && snowOk, {
          message: [bridge?.message, snowluma?.message || snowluma?.error].filter(Boolean).join('；'),
          code: bridgeOk && snowOk ? '' : 'QQ_START_PARTIAL',
          error: bridgeOk ? (snowOk ? '' : `QQ 桥接已启动，但 SnowLuma 未打开：${snowluma?.error || '未知原因'}`) : (bridge?.error || bridge?.message || 'QQ 桥接启动失败'),
          hint: bridgeOk ? (snowOk ? '' : (snowluma?.hint || '启动 SnowLuma（launcher.bat）并确认端口 3000/3001')) : '检查桥接日志/端口；必要时重启 DSH',
          detail: { bridge, snowluma },
        });
      }
      return launchItem(id, false, { code: 'UNKNOWN_COMPONENT', error: `未知启动项：${id}` });
    } catch (error) {
      return launchItem(id, false, {
        code: `${String(id).toUpperCase()}_START_FAILED`,
        error: `${LAUNCH_LABELS[id] || id} 启动失败：${String(error?.message ?? error).slice(0, 300)}`,
        hint: '看设置页状态/日志；修复后重试',
      });
    }
  }

  async function stopComponent(id, opts = {}) {
    try {
      if (id === 'qq') {
        const r = await stopBridge();
        return launchItem(id, r?.ok !== false, {
          message: 'QQ 桥接已停止（SnowLuma 本体不会被本程序关闭）',
          code: r?.ok === false ? 'QQ_STOP_FAILED' : '',
          error: r?.ok === false ? (r.error || 'QQ 桥接停止失败') : '',
          hint: r?.ok === false ? '看桥接日志/手动结束残留进程' : '',
          detail: r,
        });
      }
      return launchItem(id, false, { code: 'UNKNOWN_COMPONENT', error: `未知停止项：${id}` });
    } catch (error) {
      return launchItem(id, false, {
        code: `${String(id).toUpperCase()}_STOP_FAILED`,
        error: `${LAUNCH_LABELS[id] || id} 停止失败：${String(error?.message ?? error).slice(0, 300)}`,
        hint: '看设置页状态/日志；必要时手动结束进程',
      });
    }
  }

  async function runLaunchAction(action, body) {
    const ids = normalizeLaunchComponents(body.components);
    if (!ids.length) {
      return { ok: false, code: 'NO_COMPONENTS', error: '没有选择要启动/停止的项目', hint: '至少勾选一项', items: [], status: await launchStatus() };
    }
    const items = [];
    const ordered = ids;
    for (const id of ordered) {
      items.push(action === 'stop' ? await stopComponent(id, body) : await startComponent(id, body));
    }
    const status = await launchStatus();
    return { ok: items.every((x) => x.ok), items, status };
  }

  async function handleBridge(req, res) {
    if (req.method === 'GET') { json(res, 200, { ok: true, status: await bridgeStatus() }); return; }
    const body = JSON.parse(await readBody(req) || '{}');
    const action = String(body.action ?? 'status');
    if (action === 'status') { json(res, 200, { ok: true, status: await bridgeStatus() }); return; }
    if (action === 'start') {
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：去「QQ」页打开「启动 QQ」并保存' });
        return;
      }
      json(res, 200, await startBridge({ dshWebUrl: currentDshUrl() }));
      return;
    }
    if (action === 'start-qq') {
      // 概览的「启动 QQ」：桥接 + 按需打开 SnowLuma（仍是用户显式点击，不自动弹）。
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：去「QQ」页打开「启动 QQ」并保存' });
        return;
      }
      const bridge = await startBridge({ dshWebUrl: currentDshUrl() });
      const snowluma = await launchSnowLuma();
      json(res, 200, {
        ok: bridge?.ok !== false,
        message: [bridge?.message, snowluma?.message || snowluma?.error].filter(Boolean).join('；'),
        bridge,
        snowluma,
      });
      return;
    }
    if (action === 'start-selected' || action === 'start-components') {
      json(res, 200, await runLaunchAction('start', body));
      return;
    }
    if (action === 'stop-selected' || action === 'stop-components') {
      json(res, 200, await runLaunchAction('stop', body));
      return;
    }
    if (action === 'start-all') {
      // 一键启动：按平台启动开关拉起 QQ 桥接 / B站生物钟；QQ 打开时才尝试打开 SnowLuma。
      const starts = platformStartState();
      const status = await bridgeStatus();
      const stale = bridgeStaleReason(status);
      const dshWebUrl = currentDshUrl();
      const bridge = starts.qq
        ? (stale ? await restartBridge({ dshWebUrl }) : await startBridge({ dshWebUrl }))
        : { ok: true, skipped: true, message: 'QQ 启动开关关闭，已跳过桥接' };
      const snowluma = starts.qq ? await launchSnowLuma() : { ok: true, skipped: true, message: 'QQ 启动开关关闭，已跳过 SnowLuma' };
      const coreOk = !starts.qq || bridge?.ok !== false;
      const message = [
        bridge?.message,
        snowluma?.message || snowluma?.error,
        starts.qq ? '启动完成后会弹窗告诉你结果' : 'QQ 的启动开关关着，没有需要启动的平台',
      ].filter(Boolean).join('；');
      json(res, 200, {
        ok: coreOk,
        pending: starts.qq,
        message,
        bridge,
        snowluma,
        platformStart: starts,
      });
      if (starts.qq) void watchStartupCompletion(starts);
      return;
    }
    if (action === 'start-snowluma') {
      json(res, 200, await launchSnowLuma());
      return;
    }
    if (action === 'detect-snowluma') {
      // 可选 path：用户点「浏览…」选了解压目录/app 目录/launcher.bat 时，**只验证这个路径**——
      // 用户明确选了一个，就不能悄悄回退去猜别的目录（否则会"检测成功"但保存的是另一份安装）。
      const picked = String(body.path ?? '').trim();
      const direct = picked ? normalizeSnowLumaInstall(picked) : null;
      const found = picked
        ? (direct ? { ok: true, ...direct, tried: [{ path: picked, ok: true }] } : { ok: false, tried: [{ path: picked, ok: false }] })
        : findSnowLumaInstall();
      if (!found.ok) {
        // 失败必须有结构化报告：code + 人读的 error + 下一步 hint + 试过的路径（AGENTS 1.7）。
        const report = snowLumaMissingReport({ picked, tried: found.tried.map((x) => x.path).slice(0, 12) });
        json(res, 200, { ok: false, code: report.code, title: report.title, error: report.error, hint: report.hint, tried: report.tried });
        return;
      }
      saveQqConfig({ snowluma: { launcherPath: found.root, allowLaunch: true } });
      json(res, 200, { ok: true, found: true, path: found.root, launcher: found.launcher, message: `已找到 SnowLuma：${found.root}` });
      return;
    }
    if (action === 'stop') { json(res, 200, await stopBridge()); return; }
    if (action === 'restart') {
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：先在「QQ」页打开「启动 QQ」并保存' });
        return;
      }
      json(res, 200, await restartBridge({ dshWebUrl: currentDshUrl() }));
      return;
    }
    if (action === 'greeting-test') {
      const result = await callBridge('/api/greeting/test', { method: 'POST', body: {} });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    // 目的机制：状态 / 只读预览 / 立刻试一次（真发，设置页会先 confirm）。
    if (action === 'purpose-status') {
      const result = await callBridge('/api/purpose/status', { timeoutMs: 8000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'purpose-preview') {
      const result = await callBridge('/api/purpose/preview', { method: 'POST', body: {}, timeoutMs: 20000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'purpose-run') {
      const result = await callBridge('/api/purpose/run', { method: 'POST', body: { force: true }, timeoutMs: 25000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'refresh-bili') { json(res, 200, await refreshBiliToQq({ callBridge })); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── QQ 鱼群保护（设置页「最近触发」）────────────────────────────────────
  // 桥接把每次新触发写进 social-v2.json 的 fishGuardLog（每群最多 30 条）；
  // 设置页只读这个文件，不再靠翻活动日志。见 PITFALLS #30 / #31。
  function handleQqFishGuard(res) {
    try {
      const file = path.join(QQ_STATE_DIR(), 'social-v2.json');
      const data = readJson(file, {}) ?? {};
      const summary = summarizeQqFishGuard(data, { now: Date.now() });
      json(res, 200, {
        ok: true,
        file,
        now: new Date().toISOString(),
        ...summary,
        config: readQqConfig().config?.fishGuard ?? {},
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 日志 ────────────────────────────────────────────────────────────────
  function handleLogs(res, url) {
    const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines')) || 120));
    const plugin = readTextTail(PLUGIN_LOG).split('\n').slice(-lines).join('\n');
    const bridge = bridgeLogTail(lines);
    json(res, 200, { ok: true, plugin, bridge, paths: { pluginLog: PLUGIN_LOG, bridgeLog: path.join(QQ_STATE_DIR(), 'bridge.log') } });
  }

  // 主人特权操作审计：只读桥接写好的 state/owner-audit.jsonl；agent 永远拿不到。
  async function handleOwnerAudit(req, res, url) {
    if (req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      const result = await callBridge(`/api/owner-audit?limit=${limit}`, { timeoutMs: 8000 });
      json(res, result.status || 200, result.data ?? { ok: false, error: result.error || '桥接不可用' });
      return;
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      // 只支持「打开所在文件夹」；路径固定，不接受任何用户输入。
      if (body.action !== 'open') { json(res, 400, { ok: false, error: '未知 action' }); return; }
      if (process.platform !== 'win32') { json(res, 200, { ok: false, error: '只有 Windows 支持打开文件夹' }); return; }
      const dir = path.join(QQBOT_ROOT, 'state');
      try {
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        json(res, 200, { ok: true, path: dir });
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    json(res, 405, { ok: false, error: 'method not allowed' });
  }

  // ── 平台 ────────────────────────────────────────────────────────────────
  async function handlePlatforms(req, res) {
    json(res, 200, { ok: true, platforms: await platforms.statusAll(), capabilities: ['identity', 'memory.read', 'memory.write', 'prompt.block', 'actions'] });
  }

  // ── 组件更新 ────────────────────────────────────────────────────────────
  // GET  : 最近一次检查结果 + 待更新项 + 是否该弹窗
  // POST : { action:'check' | 'apply' | 'dismiss' | 'reset', ids?: string[] }
  async function handleUpdates(req, res) {
    if (req.method === 'GET') { json(res, 200, updates.status()); return; }
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (action === 'check') { json(res, 200, await updates.check({ fetch: true })); return; }
    if (action === 'apply') { json(res, 200, await updates.apply(ids)); return; }
    if (action === 'set-token' || action === 'clear-token') {
      try {
        const current = readUnified().config ?? {};
        const next = { ...current, updates: { ...(current.updates ?? {}) } };
        if (action === 'clear-token') delete next.updates.githubToken;
        else next.updates.githubToken = String(body.token ?? '').trim();
        saveUnified(next);
        json(res, 200, { ok: true, configured: action === 'set-token' && Boolean(next.updates.githubToken) });
      } catch (error) {
        json(res, 500, {
          ok: false, code: 'token.save-failed',
          error: `保存 token 失败：${String(error?.message ?? error).slice(0, 160)}`,
          hint: '检查 config.json 是否可写；也可以稍后重试',
        });
      }
      return;
    }
    if (action === 'rollback') {
      const target = String(body.id ?? ids[0] ?? '').trim();
      json(res, 200, await updates.rollback(target));
      return;
    }
    if (action === 'dismiss') { json(res, 200, updates.dismiss(ids)); return; }
    if (action === 'reset') { json(res, 200, updates.resetDismissed()); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 每日 token 额度 ─────────────────────────────────────────────────────
  // GET  : 额度 + 今日三类用量 + 比例 + 当天唯一的 80% 提醒（取走即落盘）
  // POST : { limits } 整体保存 / { add:{scope,unit,amount} } 快捷加额度 / { reset:true } 清空
  async function handleTokenBudget(req, res, url) {
    if (req.method === 'GET') {
      const takeAlertFlag = url?.searchParams?.get('alert') !== '0';
      json(res, 200, await tokenBudget.status({ takeAlertFlag }));
      return;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return; }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    try {
      if (body?.reset === true) {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-reset');
        tokenBudget.resetLimits();
      } else if (body?.add && typeof body.add === 'object') {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-add');
        tokenBudget.addLimit(body.add.scope, body.add.unit, body.add.amount);
      } else if (body?.limits !== undefined) {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-save');
        tokenBudget.saveLimits(body.limits);
      } else {
        throw new Error('缺少 limits，或 add / reset');
      }
      json(res, 200, await tokenBudget.status({ takeAlertFlag: false }));
    } catch (error) {
      json(res, 400, { ok: false, error: `保存额度失败：${String(error?.message ?? error)}` });
    }
  }

  // ── 路由：API 前缀 ──────────────────────────────────────────────────────
  route('prefix', API_PREFIX, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === `${API_PREFIX}/overview`) { json(res, 200, await overview()); return; }
    if (pathname === `${API_PREFIX}/config`) { await handleConfig(req, res); return; }
    if (pathname === `${API_PREFIX}/characters`) { await handleCharacters(req, res, url); return; }
    if (pathname === `${API_PREFIX}/persona`) { await handlePersona(req, res); return; }
    if (pathname === `${API_PREFIX}/limit-mute`) { await handleLimitMute(req, res); return; }
    if (pathname === `${API_PREFIX}/persona/classify`) { await handlePersonaClassify(req, res); return; }
    if (pathname === `${API_PREFIX}/group-policy`) { await handleGroupPolicy(req, res); return; }
    if (pathname === `${API_PREFIX}/memory`) { await handleMemory(req, res, url); return; }
    if (pathname === `${API_PREFIX}/watch-history`) { handleWatchHistory(res, url); return; }
    if (pathname === `${API_PREFIX}/preferences/scan`) {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return; }
      await handlePreferenceScan(res, url);
      return;
    }
    if (pathname === `${API_PREFIX}/fish-guard/qq`) { handleQqFishGuard(res); return; }
    if (pathname === `${API_PREFIX}/memory-card/full`) { await handleMemoryCardFull(req, res, url); return; }
    if (pathname === `${API_PREFIX}/memory-card`) { await handleMemoryCard(req, res); return; }
    if (pathname === `${API_PREFIX}/align`) { await handleAlign(req, res); return; }
    if (pathname === `${API_PREFIX}/mode`) { await handleMode(req, res); return; }
    if (pathname === `${API_PREFIX}/extensions`) { await handleExtensions(req, res); return; }
    if (pathname === `${API_PREFIX}/platforms`) { await handlePlatforms(req, res); return; }
    if (pathname === `${API_PREFIX}/compat/scan`) {
      try {
        let version = '';
        try { version = String(JSON.parse(fs.readFileSync(path.join(QQBOT_ROOT, 'package.json'), 'utf8')).version ?? ''); } catch {}
        const report = scanPluginCompatibility({ surfcoreVersion: version });
        // 体检结果进闸门事件中心：只记 blocker/high，unknown/info 留在体检报告里，避免噪音。
        for (const issue of report.issues ?? []) {
          if (issue.severity !== 'blocker' && issue.severity !== 'high') continue;
          gateEvents.record({
            gate: 'plugin-compat',
            kind: 'compat',
            event: issue.code,
            action: 'blocked',
            subject: { bundle: issue.evidence?.bundle ?? '', profile: report.profile?.name ?? '' },
            reason: { code: issue.code, message: issue.title },
            impact: issue.impact,
            recommendation: issue.recommendation,
            confidence: issue.confidence,
            dedupeKey: `compat:${issue.code}:${issue.evidence?.bundle ?? ''}`,
            evidence: issue.evidence ?? {},
          });
        }
        json(res, 200, report);
      } catch (error) {
        json(res, 500, {
          ok: false,
          code: 'COMPAT_SCAN_FAILED',
          error: `插件体检失败：${String(error?.message ?? error)}`,
          hint: '先确认 DSH_HOME/profiles 可读；如果刚升级过 DSH，重启 DSH 后再试。',
        });
      }
      return;
    }
    if (pathname === `${API_PREFIX}/gate-events`) {
      if (req.method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const level = String(url.searchParams.get('level') ?? '').trim();
        const includeAcked = url.searchParams.get('includeAcked') !== '0';
        json(res, 200, { ok: true, ...gateEvents.list({ limit, level, includeAcked }), gateEvents: true });
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const acked = gateEvents.ack(Array.isArray(body.ids) ? body.ids : [], body.action === 'ack-all' || body.all === true);
        json(res, 200, { ok: true, ...acked, ...gateEvents.list({ limit: 50, includeAcked: false }) });
        return;
      }
      json(res, 405, { ok: false, code: 'GATE_EVENTS_METHOD', error: '只支持 GET / POST', hint: '刷新页面后重试' });
      return;
    }
    if (pathname === `${API_PREFIX}/diagnostics`) { await handleDiagnostics(req, res); return; }
    if (pathname === `${API_PREFIX}/bridge`) { await handleBridge(req, res); return; }
    if (pathname.startsWith(`${API_PREFIX}/purpose`)) { await handlePurpose(req, res, url); return; }

    if (pathname === `${API_PREFIX}/token-budget`) { await handleTokenBudget(req, res, url); return; }
    if (pathname === `${API_PREFIX}/updates`) { await handleUpdates(req, res); return; }
      if (pathname === `${API_PREFIX}/logs`) { handleLogs(res, url); return; }
    if (pathname === `${API_PREFIX}/owner-audit`) { await handleOwnerAudit(req, res, url); return; }
    if (pathname === `${API_PREFIX}/browse`) { await handleBrowse(req, res, url); return; }
    if (pathname === `${API_PREFIX}/privacy/explain`) {
      const body = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : { text: url.searchParams.get('text') ?? '' };
      json(res, 200, { ok: true, ...explainText(String(body.text ?? '')) });
      return;
    }
    json(res, 404, { ok: false, error: `未知接口：${pathname}` });
  });

  // 扩展自定义路由：/dsh-surfcore/ext/<id>/<path>
  route('prefix', EXT_PREFIX, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rest = url.pathname.slice(EXT_PREFIX.length + 1);
    const [id, ...parts] = rest.split('/');
    if (!id) { json(res, 404, { ok: false, error: '缺少扩展 id' }); return; }
    const routePath = `/${parts.join('/')}`;
    const record = extensionHost.routeFor(id, req.method, routePath);
    if (!record) { json(res, 404, { ok: false, error: `扩展 ${id} 没有注册 ${req.method} ${routePath}` }); return; }
    await record.handler(req, res, { url, extensionId: id });
  });


  route('exact', '/dsh-surfcore/health', async (req, res) => {
    json(res, 200, { ok: true, name, version: VERSION, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
  });


  // 启动后异步做的事（不阻塞插件激活）
  void activateExtensions();
  void maybeAutoStartBridge();
  // 组件更新检查（2026-10-26）：DSH 起来后延迟 20 秒查一次，之后每 6 小时一次。
  // 结果缓存在 updates.json；设置页概览打开时若 showPrompt 就自动弹窗。
  try {
    const updCfg = readUnified().config?.updates ?? {};
    updates.startAutoCheck({
      delayMs: Number(updCfg.startDelayMs ?? 20_000),
      intervalMs: Number(updCfg.intervalMs ?? 6 * 60 * 60 * 1000),
      enabled: updCfg.enabled !== false && updCfg.checkOnStart !== false,
    });
  } catch (error) {
    pluginLog('[updates] 启动检查失败：', String(error?.message ?? error));
  }
  // 端口漂移自愈：每 2 分钟检查一次（内部会判断 autoStart 是否开启、是否有并发）。
  bridgeRepairTimer = setInterval(() => { void maybeAutoStartBridge(); }, 120_000);
  bridgeRepairTimer.unref?.();
  startSyncTimer();

  // 保存设置后如果开启了“随插件自动启动”，这里也覆盖一次。
  ctx.effect(() => () => {
    try { updates.dispose(); } catch {}
    try { sessionEventOff?.(); } catch {}
    try { billing.dispose(); } catch {}
    try { tokenBudget.dispose(); } catch {}
    try { memoryCardTimer?.stop?.(); } catch {}
    if (characterTimer) clearInterval(characterTimer);
    if (syncTimer) clearInterval(syncTimer);
    if (bridgeRepairTimer) clearInterval(bridgeRepairTimer);
    void extensionHost.deactivateAll();
    for (const dispose of disposers) { try { dispose(); } catch {} }
  });

  // 诊断日志：证明插件真的被装配，且知道它读的是哪一份配置。
  pluginLog(`已激活 v${VERSION}；surfcore=${maskPath(path.dirname(QQ_CONFIG))}；privacy=v${PRIVACY_POLICY_VERSION}`);
}

export default { name, inject, apply };