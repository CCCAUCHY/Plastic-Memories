/**
 * 全局 bundle 注册冒烟：apply 必须在没有 PM preset 的普通 ctx 里注册工具和命令。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCounter, makeStore, cookieSeed } from './testkit.mjs';
import { apply } from './index.js';

const { ok, done } = makeCounter('globaltest');
const home = join(tmpdir(), 'pm-global-' + String(process.pid));
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const tools = [];
const definitions = [];
const toolOptions = [];
const commands = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined; },
  inject(names, callback) {
    if (names.includes('commands')) callback({ commands: { register(definition) { commands.push(definition.name); } } });
  },
  effect(effect) { try { return effect(); } catch { return undefined; } },
  on() { return () => {}; },
  tools: { register(definition, options) { tools.push(definition.name); definitions.push(definition); toolOptions.push(options ?? {}); } },
  root: undefined,
};
apply(ctx, {});
ok(tools.includes('plasticize') && tools.includes('retrospect') && tools.includes('letter'), '全局注册三个工具', tools.join(','));
ok(commands.includes('plasticize'), '全局注册 /plasticize', commands.join(','));
ok(!tools.includes('undefined'), '没有空工具');

const store = makeStore();
const session = store.sessions.create('global-retro', { seed: cookieSeed('subagent-95230f54.jsonl') });
const retrospect = definitions.find((definition) => definition.name === 'retrospect');
let unitData;
try {
  const result = await retrospect.execute({ generation: 'self', units: true }, { agent: { session } });
  unitData = JSON.parse(result.text);
} catch (error) {
  unitData = { error: String(error.message) };
}
ok(unitData.error === undefined && unitData.count > 0 && unitData.units[0].n === 0, 'retrospect(self, units) 返回单元数组', JSON.stringify(unitData).slice(0, 160));
ok(unitData.units !== undefined && unitData.units[0].type === 'system', '0 号单元是 system');
let messageData;
try {
  const result = await retrospect.execute({ generation: 'self' }, { agent: { session } });
  messageData = JSON.parse(result.text);
} catch (error) {
  messageData = { error: String(error.message) };
}
ok(messageData.error === undefined && Array.isArray(messageData.messages) && messageData.messages.length > 0, 'retrospect(self) 返回 Message[]', JSON.stringify(messageData).slice(0, 160));
ok(messageData.messages[0].type === 'system', 'Message[] 第一条是 system');

// preset 门控：标准模式不提供服务，PTC 提供。
const standardSession = { header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
const ptcSession = { header: { agentPreset: 'ptc' }, snapshotEvents: () => [] };
const gate = toolOptions[0] ?? {};
const allowed = async (session) => {
  try {
    return (await gate.when === undefined) ? 'no-when' : (await gate.when({ agent: { session }, signal: new AbortController().signal })) === true;
  } catch {
    return 'threw';
  }
};
ok((await allowed(standardSession)) === false, 'standard 会话不提供服务');
ok((await allowed(ptcSession)) === true, 'ptc 会话提供服务');
const legacySession = { header: {}, snapshotEvents: () => [] };
ok((await allowed(legacySession)) === true, '无 preset 记录的旧会话保持兼容');

// 安全区只属于当前世代。
const lockSession = store.sessions.create('global-lock', { seed: cookieSeed('subagent-95230f54.jsonl') });
lockSession.append('plugin:plastic-memories/logical', { logical: 0, physical: 1, kind: 'execute', callId: 'lock-probe' });
lockSession.append('plugin:plastic-memories/locks', { op: 'lock', seqs: [lockSession.surface.nodes[1]] }, { ignorable: true });
const selfData = JSON.parse((await retrospect.execute({ generation: 'self' }, { agent: { session: lockSession } })).text);
const selfLocked = selfData.messages.filter((message) => message.locked === true).length;
let historyData;
try {
  historyData = JSON.parse((await retrospect.execute({ generation: 0 }, { agent: { session: lockSession } })).text);
} catch (error) {
  historyData = { error: String(error.message) };
}
const historyLocked = Array.isArray(historyData.messages) ? historyData.messages.filter((message) => message.locked === true).length : -1;
ok(historyLocked === 0, '历史世代不返回安全区', JSON.stringify({ historyLocked, error: historyData.error }));
done();