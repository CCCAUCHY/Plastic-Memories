/**
 * PM · 提交边界与端到端闭环（cookie / spans 版）。
 *
 * 用 dsh-agent 导出的 agentEvents() 在真实 cordis Context 上派发真事件，
 * 覆盖只在真实派发下才成立的性质：
 *   O1  flush 异常不杀 turn
 *   O2  turn 末兜底
 *   waterfall 契约、prepend 顺序、C3 重入、多会话隔离、序列化往返、卸载退化、
 *   cookie 自动补插（边界队尾永远保持一个 cookie）
 *
 * 运行：node hooks.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SystemPrompt from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { agentEvents } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-agent/lib/index.js';
import { createUserMessage } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { makeCounter, cookieSeed, cookieNodes, textOf, fixture } from './testkit.mjs';
import { cookieText } from './cookie.js';
import { KNOWN_SESSION_EVENT_TYPES } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { assertReleasedV4Relationships } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('hooks');

const ctx = new Context();
new SessionStore(ctx);
new SystemPrompt(ctx, {});
new ToolRuntime(ctx);

/** 捕获 PM 的告警（插件在 apply 时抓的是 ctx.logger 这个对象，改它的方法即可截获）。 */
const warnings = [];
ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

const mod = await import('./index.js');
const fork = ctx.plugin(mod, { trace: false });
await new Promise((resolve) => setTimeout(resolve, 30));
if (ctx.tools.get('plasticize') === undefined) {
  console.error('插件未激活：plasticize 未注册。中断测试。');
  process.exit(1);
}

const U = (t) => createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } });

let n = 0;
const mkSession = (id) => ctx.sessions.create(id ?? ('h-' + (++n)), { seed: cookieSeed('subagent-95230f54.jsonl') });
const agentOf = (session) => ({ session, ctx, id: session.id });
const fire = async (agent, extra) => agentEvents(ctx, agent, agent).waterfall(
  'agent/request',
  { turn: 2, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages: extra ?? [] }),
);
const fireTurnStopping = (agent) => agentEvents(ctx, agent, agent).serial('agent/turn-stopping', { turn: 2, signal: new AbortController().signal });

/** 造一次真实的 plasticize 调用（含 tool/call 记账 + 结果）。 */
const declare = (s, callId, spans, newText = '⟨结论⟩', option = 'execute') => {
  const args = { ops: [{ spans, new_text: newText }], option };
  s.append('assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'am-' + callId, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: callId, name: 'plasticize', arguments: JSON.stringify(args) }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  s.append('tool/call', { turn: 2, step: 1, callId, name: 'plasticize', arguments: JSON.stringify(args) });
  s.append('tool/result', {
    turn: 2, step: 1,
    message: { id: 'tr-' + callId, role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '已登记' }], isError: false, source: { kind: 'tool', callId } },
  }, { surfaceOp: 'append' });
};
const openStep = (s) => {
  s.append('turn/start', { turn: 2 });
  s.append('step/start', { turn: 2, step: 1 });
};
const reps = (s) => s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
const ALL = '(1,10)';   // 夹具里 cookie1..cookie10 之间 = system 之外的全部历史

console.log(NL + '① 端到端闭环：声明 → 边界 flush → 工作面改变');
{
  const s = mkSession('h1');
  openStep(s);
  declare(s, 'e2e', [ALL], '⟨E2E 结论⟩');
  ok(reps(s).length === 0, 'flush 之前没有投影');
  const decision = await fire(agentOf(s));
  ok(decision.kind === 'enter', 'agent/request 返回正常', JSON.stringify(decision).slice(0, 60));
  ok(reps(s).length === 1, 'prepend 的 flush 在边界上写下了投影', String(reps(s).length));
  ok(textOf(s).includes('⟨E2E 结论⟩'), '替代文本进入工作面');
}

console.log(NL + '② waterfall 契约（不得吞掉下游的返回值）');
{
  const s = mkSession('h2');
  const sentinel = [{ id: 'inj', role: 'user', content: [{ type: 'text', text: 'INJECTED' }], source: { kind: 'user' } }];
  const decision = await fire(agentOf(s), sentinel);
  ok(decision.kind === 'enter', 'decision.kind 未被改写');
  ok(JSON.stringify(decision.messages) === JSON.stringify(sentinel), 'decision.messages 逐字保留');
  const rejected = await agentEvents(ctx, agentOf(s), agentOf(s)).waterfall(
    'agent/request',
    { turn: 2, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'reject', reason: 'TEST' }),
  );
  ok(rejected.kind === 'reject', 'reject 原样穿透');
}

console.log(NL + '③ agent/turn-stopping 兜底');
{
  const s = mkSession('h3');
  openStep(s);
  declare(s, 'tail', [ALL], '⟨尾部兜底⟩');
  ok(reps(s).length === 0, 'turn-stopping 之前未投影');
  await fireTurnStopping(agentOf(s));
  ok(reps(s).length === 1, 'turn-stopping 补上了投影（O2）', String(reps(s).length));
}

console.log(NL + '④ O1 — flush 内部异常被吞，turn 不受影响');
{
  const s = mkSession('h4');
  warnings.length = 0;
  const realSnapshot = s.snapshotEvents.bind(s);
  s.snapshotEvents = () => { throw new Error('INJECTED'); };
  let threw = null;
  let decision = null;
  try { decision = await fire(agentOf(s)); } catch (e) { threw = e; }
  s.snapshotEvents = realSnapshot;
  ok(threw === null, 'flush 的异常没有外泄（否则会毁掉整个 turn）', String(threw?.message));
  ok(decision !== null && decision.kind === 'enter', 'decision 仍正常返回');
  ok(warnings.some((w) => w.includes('flush 失败')), '降级为告警', warnings.slice(0, 1).join('').slice(0, 70));
}

console.log(NL + '⑤ prepend 顺序');
{
  const s = mkSession('h5');
  openStep(s);
  declare(s, 'ord', [ALL], '⟨顺序⟩');
  let sawAfter = null;
  ctx.on('agent/request', async (_payload, next) => { sawAfter = reps(s).length; return next(); });
  await fire(agentOf(s));
  ok(sawAfter === 1, '后续 listener 看到的已是投影后的状态（PM 用了 prepend）', String(sawAfter));
}

console.log(NL + '⑥ C3 重入 + cookie 幂等（队尾已是 cookie 就不再补）');
{
  const s = mkSession('h6');
  openStep(s);
  const before = s.seq;
  await fire(agentOf(s));
  ok(s.seq === before, '无待办、队尾已是 cookie → 不产生多余事件', String(s.seq - before));
  s.append('user/message', U('AFTER'), { surfaceOp: 'append' });
  const afterUser = s.seq;
  await fire(agentOf(s));
  ok(s.seq === afterUser + 1, '队尾是普通 user 消息 → 边界补一个 cookie', String(s.seq - afterUser));
  const last = [...s.surface.nodes].at(-1);
  ok(s.eventAt(last)?.data?.source?.kind === 'pm-cookie', '补上的确实是 cookie');
  const cookieEvent = s.eventAt(last);
  ok(cookieEvent?.data?.id === 'pm-cookie-' + String(cookieEvent?.data?.source?.id),
    'cookie 的 message id 是确定性的 pm-cookie-<n>', String(cookieEvent?.data?.id));
  ok(cookieEvent?.data?.content?.[0]?.text === cookieText(cookieEvent?.data?.source?.id),
    'cookie 正文是新样式 [Plastic-Memories][cookie][N]', String(cookieEvent?.data?.content?.[0]?.text));
}

console.log(NL + '⑦ 多会话隔离');
{
  const s1 = mkSession('iso-1');
  const s2 = mkSession('iso-2');
  openStep(s1);
  openStep(s2);
  declare(s1, 'iso', [ALL], '⟨隔离⟩');
  await fire(agentOf(s2));
  ok(reps(s1).length === 0, '对 s2 的 flush 没有碰到 s1');
  await fire(agentOf(s1));
  ok(reps(s1).length === 1, 's1 自己的 flush 生效');
}

console.log(NL + '⑧ 日志序列化往返');
{
  const s = mkSession('ser');
  openStep(s);
  declare(s, 'ser', [ALL], '⟨序列化⟩');
  await fire(agentOf(s));
  const raw = JSON.parse(JSON.stringify(s.snapshotEvents()));
  const rp = raw.filter((e) => e.surfaceOp?.op === 'replace');
  ok(rp.length === 1, '日志里有 1 条 replace', String(rp.length));
  ok(Array.isArray(rp[0].sourceEventSeqs) && rp[0].sourceEventSeqs.length > 0, 'sourceEventSeqs 存活');
  const marker = raw.map((e) => (e.type === 'user/message' ? e.data?.source : e.data?.message?.source)).find((src) => src?.kind === 'pm-surface');
  ok(marker !== undefined && typeof marker.callId === 'string', 'PM 标记存活（幂等键靠它）');
  const ctx2 = new Context(); new SessionStore(ctx2);
  const s2 = ctx2.sessions.create('ser-replay', { seed: raw.filter((e) => e.type !== 'session') });
  ok(JSON.stringify([...s2.surface.nodes]) === JSON.stringify([...s.surface.nodes]), '重建后工作面逐条一致');
  ok(JSON.stringify(s2.deriveMessages().map((m) => m.role)) === JSON.stringify(s.deriveMessages().map((m) => m.role)),
    '重建后派生消息逐条一致');
}

console.log(NL + '⑨ 自动补 cookie 之后，日志仍通过宿主 released-v4 校验器');
{
  const rawRecords = fixture('subagent-95230f54.jsonl');
  const header = (() => { const h = { ...rawRecords.find((r) => r.type === 'session') }; delete h.type; return h; })();
  const check = (s) => {
    const artifact = { header, events: JSON.parse(JSON.stringify(s.snapshotEvents())), inheritedEventCount: 0 };
    try { assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES); return undefined; } catch (e) { return String(e.message); }
  };
  const s = mkSession('validate');
  openStep(s);
  ok(check(s) === undefined, 'seed 之后合法', String(check(s)));
  await fire(agentOf(s));
  ok(check(s) === undefined, '边界补 cookie 之后仍合法', String(check(s)));
  declare(s, 'val', [ALL], '⟨校验⟩');
  await fire(agentOf(s));
  ok(check(s) === undefined, '投影 + 再补 cookie 之后仍合法', String(check(s)));

  // turn 末的兜底路径：step 已关闭、turn 已结束，cookie 仍然要被追加在最后。
  const t = mkSession('validate-turnend');
  openStep(t);
  t.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am-te', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' }, content: [{ type: 'text', text: '完成' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  t.append('step/end', { turn: 2, step: 1 });
  t.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await fireTurnStopping(agentOf(t));
  const tailSeq = t.seq - 1;
  ok(t.eventAt(tailSeq)?.data?.source?.kind === 'pm-cookie', 'turn 结束后补上了 cookie', String(t.eventAt(tailSeq)?.type));
  ok(check(t) === undefined, 'turn 末补 cookie 之后仍合法', String(check(t)));
}

console.log(NL + '⑨b pre-step 真派发：用户消息前后各夹一条 cookie');
{
  const s = ctx.sessions.create('h-bracket-' + (++n), { seed: cookieSeed('subagent-95230f54.jsonl') });
  const agent = agentOf(s);
  // 夹具末尾是 cookie；先追加一条 assistant，让队尾变成非 cookie（左端点需要新补）。
  s.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am-br', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' }, content: [{ type: 'text', text: '先例' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  const firePreStep = (messages) => agentEvents(ctx, agent, agent).waterfall(
    'agent/pre-step',
    { turn: 2, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages }),
  );
  const decision = await firePreStep([U('用户亲口说的')]);
  ok(decision.kind === 'enter' && decision.messages.length === 3, '用户消息被夹成 3 条', String(decision.messages?.length));
  const kinds = decision.messages.map((m) => m?.source?.kind);
  ok(kinds[0] === 'pm-cookie' && kinds[1] === 'user' && kinds[2] === 'pm-cookie',
    '顺序 = cookie / 用户 / cookie', JSON.stringify(kinds));
  const ids = [decision.messages[0].source.id, decision.messages[2].source.id];
  ok(ids[1] === ids[0] + 1, '两条 cookie 编号连续递增', JSON.stringify(ids));

  // 落盘后必须能通过会话校验，并且模型可见顺序保持。
  for (const message of decision.messages) s.append('user/message', message, { surfaceOp: 'append' });
  const tail = s.eventAt(s.surface.nodes[s.surface.nodes.length - 1]);
  ok(tail?.data?.source?.kind === 'pm-cookie', '右端点是 cookie（紧跟用户消息）', String(tail?.type));

  // 队尾已是 cookie 时，下一条用户消息不再补左端点（避免连续两条 cookie）。
  const again = await firePreStep([U('第二条')]);
  ok(again.messages.length === 2 && again.messages[0].source.kind === 'user',
    '队尾已是 cookie → 只补右端点', JSON.stringify(again.messages?.map((m) => m?.source?.kind)));

  // 系统注入的 runtime-context 不夹 cookie。
  const snapshot = await firePreStep([{ id: 'ctx', role: 'user', content: [{ type: 'text', text: 'Current runtime context' }], source: { kind: 'runtime-context' } }]);
  ok(snapshot.messages.length === 1 && snapshot.messages[0].source.kind === 'runtime-context',
    '时间快照不被夹（与用户消息可分）', JSON.stringify(snapshot.messages?.map((m) => m?.source?.kind)));
}

console.log(NL + '⑩ 卸载插件后（fork.dispose）');
{
  const s = mkSession('unload');
  openStep(s);
  declare(s, 'un', [ALL], '⟨卸载⟩');
  await fire(agentOf(s));
  const nodesBefore = JSON.stringify([...s.surface.nodes]);
  fork.dispose();
  await new Promise((r) => setTimeout(r, 20));
  ok(ctx.tools.get('plasticize') === undefined, '工具已撤销（纤维所有权）');
  let threw = null;
  try { await fire(agentOf(s)); } catch (e) { threw = e; }
  ok(threw === null, '卸载后提交边界不再抛错');
  ok(JSON.stringify([...s.surface.nodes]) === nodesBefore, '已有投影逐条存活（投影是数据）');
  void cookieNodes;
}

done();