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
let messageData;
try {
  const result = await retrospect.execute({ generation: 'self' }, { agent: { session } });
  messageData = JSON.parse(result.text);
} catch (error) {
  messageData = { error: String(error.message) };
}
ok(messageData.error === undefined && Array.isArray(messageData.messages) && messageData.messages.length > 0, 'retrospect(self) 返回 Message[]', JSON.stringify(messageData).slice(0, 160));
ok(messageData.messages[0].role === 'system', '第一条行的 role 是 system');

// 全局注册：工具不再按 preset 门控（结果窗口让非 PTC 也能限制结果大小）。
ok(toolOptions.every((options) => options.when === undefined), '三个工具都是无条件全局注册', JSON.stringify(toolOptions.map((options) => typeof options.when)));

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

// 结果窗口：两个工具共用同一套 positions 语法，用来在非 PTC 里主动限制结果大小。
const windowData = JSON.parse((await retrospect.execute({ generation: 'self', messages_position: 'unit 1' }, { agent: { session } })).text);
ok(windowData.messages.length === 1 && windowData.messages[0].unit === 1, 'messages_position 只返回选中单元', JSON.stringify({ rows: windowData.messages.length }));
ok(Number.isSafeInteger(windowData.units) && windowData.units > 1, 'units 是总单元数', String(windowData.units));
let thisInRetrospect;
try { await retrospect.execute({ generation: 'self', messages_position: 'this' }, { agent: { session } }); } catch (error) { thisInRetrospect = String(error.message); }
ok(typeof thisInRetrospect === 'string' && thisInRetrospect.includes('this'), 'messages_position 拒绝 this', thisInRetrospect?.slice(0, 40));

done();