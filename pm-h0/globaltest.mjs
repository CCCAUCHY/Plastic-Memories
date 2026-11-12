/**
 * 全局 bundle 注册冒烟：apply 必须在没有 PM preset 的普通 ctx 里注册工具和命令。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCounter, makeStore, cookieSeed } from './testkit.mjs';
import { apply } from './index.js';
import { previewOf } from './plasticize.js';

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
ok(messageData.messages[0].type === 'system', 'Message[] 第一条是 system');

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
const windowData = JSON.parse((await retrospect.execute({ generation: 'self', result_positions: 'unit 1' }, { agent: { session } })).text);
ok(windowData.count === 1 && windowData.messages[0].n === 1 && windowData.total > 1, 'retrospect result_positions 只返回选中单元', JSON.stringify({ count: windowData.count, total: windowData.total }));
ok(JSON.stringify(windowData.units) === JSON.stringify([1]), 'retrospect result_positions 回显命中的单元', JSON.stringify(windowData.units));
let thisInRetrospect;
try { await retrospect.execute({ generation: 'self', result_positions: 'this' }, { agent: { session } }); } catch (error) { thisInRetrospect = String(error.message); }
ok(typeof thisInRetrospect === 'string' && thisInRetrospect.includes('this'), 'retrospect 拒绝 result_positions 里的 this', thisInRetrospect?.slice(0, 40));

const previewSession = store.sessions.create('global-preview-window', { seed: cookieSeed('subagent-95230f54.jsonl') });
const fullPreview = previewOf(previewSession, [], 'window-probe');
const windowPreview = previewOf(previewSession, [], 'window-probe', { selectors: 'unit 1' });
ok(windowPreview.messageCount === 1 && windowPreview.total === fullPreview.messageCount && JSON.stringify(windowPreview.units) === JSON.stringify([1]), 'set 预览支持同一套 positions', JSON.stringify({ shown: windowPreview.messageCount, total: windowPreview.total }));
ok(!String(fullPreview.text).includes('\u0000'), '预览文本不含控制字符');

// execute 用重放元素兑现待决 set（旧的空 ops 写法已废除）。
{
  const emptyOps = store.sessions.create('global-empty-ops', { seed: cookieSeed('subagent-95230f54.jsonl') });
  emptyOps.append('turn/start', { turn: 9 });
  emptyOps.append('step/start', { turn: 9, step: 1 });
  const say = (id, args) => {
    emptyOps.append('assistant/message', {
      turn: 9, step: 1,
      message: { id: 'am-' + id, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' }, content: [{ type: 'tool-call', id, name: 'plasticize', arguments: JSON.stringify(args) }] },
      stream: [],
    }, { surfaceOp: 'append' });
    emptyOps.append('tool/call', { turn: 9, step: 1, callId: id, name: 'plasticize', arguments: JSON.stringify(args) });
    emptyOps.append('tool/result', {
      turn: 9, step: 1,
      message: { id: 'tr-' + id, role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: id } },
    }, { surfaceOp: 'append' });
  };
  const plasticize = definitions.find((definition) => definition.name === 'plasticize');
  let setText;
  let emptyExec;
  try {
    say('eo-set', { option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨预览⟩' }] });
    setText = (await plasticize.execute({ option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨预览⟩' }] }, { agent: { session: emptyOps }, callId: 'eo-set' })).text;
    say('eo-exec', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] });
    emptyExec = (await plasticize.execute({ option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, { agent: { session: emptyOps }, callId: 'eo-exec' })).text;
  } catch (error) {
    emptyExec = 'ERR ' + String(error.message);
  }
  ok(typeof setText === 'string' && setText.startsWith('Preview only'), 'set 预览正常', String(setText).slice(0, 40));
  ok(typeof emptyExec === 'string' && emptyExec.includes('Registered') && !emptyExec.startsWith('ERR'), 'execute 可以重放待决 set', String(emptyExec).slice(0, 80));
}
done();