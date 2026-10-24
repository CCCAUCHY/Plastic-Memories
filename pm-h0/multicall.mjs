/**
 * PM-H0 · 一步多调用（原生模式）回归测试。
 *
 * 针对一个具体怀疑：模型在**一条 assistant 消息**里发出 3 个 tool-call 时，
 * 3 个工具结果是"分别插到各自调用后面"，还是"整齐地跟在 assistant 消息后面"？
 *
 * 若是前者，上下文前缀会在第一个结果之后就被改写，缓存全部报废。
 * 这份真实日志给出的答案是后者 —— 因为 @tool/call@ 事件**不进 surface**，
 * 它只是日志记账（记录派发时刻），@deriveMessages()@ 看不到它。
 *
 * 运行：node multicall.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stepPeers } from './coords.js';
import { pairingMaps } from './coords.js';

const NL = String.fromCharCode(10);
const LOG = fileURLToPath(new URL('./fixtures/session-native-multicall.jsonl', import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (extra === undefined ? '' : '  → ' + extra)); } };

const records = readFileSync(LOG, 'utf8').trim().split(NL).map((l) => JSON.parse(l)).filter((r) => r.type !== 'session');
const ctx = new Context();
new SessionStore(ctx);
const s = ctx.sessions.create('multicall', { seed: records });
const events = s.snapshotEvents();

console.log('\n⓪ 形态：一条 assistant 消息 + 三个 tool/call 记账 + 三个 tool/result');
{
  const assistant = events.filter((e) => e.type === 'assistant/message');
  const withCalls = assistant.filter((e) => e.data.message.content.filter((b) => b.type === 'tool-call').length >= 3);
  ok(withCalls.length === 1, '恰好一条 assistant 消息含 3 个 tool-call 块', String(withCalls.length));
  const calls = withCalls[0].data.message.content.filter((b) => b.type === 'tool-call');
  ok(calls.length === 3, '三个调用是 bash / bash / glob', calls.map((c) => c.name).join(','));
  ok(new Set(calls.map((c) => c.id)).size === 3, '三个调用 id 互不相同');
  const callEvents = events.filter((e) => e.type === 'tool/call');
  ok(callEvents.length === 3, '日志里有 3 条 tool/call 记账事件', String(callEvents.length));
}

console.log('\n① 关键：tool/call 不进 surface（所以不会切开 assistant 消息）');
{
  const callEvents = events.filter((e) => e.type === 'tool/call');
  ok(callEvents.every((e) => e.surfaceOp === undefined), '3 条 tool/call 都没有 surfaceOp');
  const results = events.filter((e) => e.type === 'tool/result');
  ok(results.every((e) => e.surfaceOp === 'append'), '3 条 tool/result 都有 surfaceOp:append');
  const assistant = events.find((e) => e.type === 'assistant/message');
  ok(assistant.surfaceOp === 'append', 'assistant 消息本身是 surface 节点');
}

console.log('\n② surface 顺序：assistant 之后紧跟三个结果，中间没有别的东西');
{
  const nodes = [...s.surface.nodes];
  const aIdx = nodes.findIndex((seq) => s.eventAt(seq).type === 'assistant/message');
  ok(aIdx >= 0, '找到 assistant 节点');
  const after = nodes.slice(aIdx + 1, aIdx + 4).map((seq) => s.eventAt(seq).type);
  ok(JSON.stringify(after) === JSON.stringify(['tool/result', 'tool/result', 'tool/result']),
    '紧随其后的三个节点全是 tool/result', JSON.stringify(after));
  ok(nodes.every((seq) => s.eventAt(seq).type !== 'tool/call'), 'surface 里一条 tool/call 都没有');
}

console.log('\n③ deriveMessages：前缀是 append-only 的');
{
  const msgs = s.deriveMessages();
  const aIdx = msgs.findIndex((m) => m.role === 'assistant' && m.content.filter((b) => b.type === 'tool-call').length === 3);
  ok(aIdx >= 0, '派生消息里有一条含 3 个 tool-call 的 assistant 消息');
  const roles = msgs.slice(aIdx + 1, aIdx + 4).map((m) => m.role);
  ok(JSON.stringify(roles) === JSON.stringify(['tool', 'tool', 'tool']),
    '它后面紧跟三条 tool 消息，没有被 assistant 消息切开', JSON.stringify(roles));
  const ids = msgs.slice(aIdx + 1, aIdx + 4).map((m) => m.toolCallId);
  const callIds = msgs[aIdx].content.filter((b) => b.type === 'tool-call').map((b) => b.id);
  ok(JSON.stringify(ids) === JSON.stringify(callIds), '结果顺序与调用顺序一致（顺序执行，不是并行完成序）');
}

console.log('\n④ 配对平衡（PM 的守卫依赖它）');
{
  const balance = pairingMaps(s);
  const nodes = [...s.surface.nodes];
  const aIdx = nodes.findIndex((seq) => s.eventAt(seq).type === 'assistant/message');
  const aSeq = nodes[aIdx];
  ok(balance.before.get(aSeq) === 0, 'assistant 之前开集为空');
  ok(balance.after.get(aSeq) === 3, 'assistant 之后开集为 3（三个未应答调用）', String(balance.after.get(aSeq)));
  const lastResult = nodes[aIdx + 3];
  ok(balance.after.get(lastResult) === 0, '最后一个结果之后开集归零', String(balance.after.get(lastResult)));
  ok(balance.malformed === 0, '没有形态无法识别的块');
}

console.log('\n⑤ 隔离规则在真实多调用步上生效');
{
  const assistant = s.snapshotEvents().find((e) => e.type === 'assistant/message');
  const calls = assistant.data.message.content.filter((b) => b.type === 'tool-call');
  const self = calls[0].id;
  const peers = stepPeers(s, self, self);
  ok(peers.length === 2, 'stepPeers 报出另外 2 个同伙调用', JSON.stringify(peers.map((p) => p.name)));
  ok(peers.some((p) => p.name === 'glob'), '同伙里包含 glob');
  ok(!peers.some((p) => p.callId === self), '不含自己');
}

console.log('\n══════════════════════════════════════');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('══════════════════════════════════════');
process.exitCode = fail === 0 ? 0 : 1;
