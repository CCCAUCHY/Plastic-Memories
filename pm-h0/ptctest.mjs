/**
 * PM · PTC 呈现路径回归（一次真实事故换来的）。
 *
 * PTC 模式下模型通过 run_code 调用工具，日志里**不会出现** tool-call 块，
 * 声明只藏在 tool/ptc-dispatch-start 里。旧实现只扫 assistant/message，
 * 于是待办队列恒空 —— 但工具照样回「已登记」，模型据此报告成功（静默失效 + 回执撒谎）。
 *
 * 这一套验证：新实现认得 PTC 形态（cookie / spans 版）。
 *
 * 运行：node ptctest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SystemPrompt from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { makeCounter, fixture, cookieSeed, textOf } from './testkit.mjs';
import { flush, pendingReport } from './engine.js';
import { pairingMaps } from './coords.js';
import { findLastPendingSet } from './plasticize.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('ptctest');
const quiet = { warn: () => {}, info: () => {} };

const ctx = new Context();
new SessionStore(ctx);
const records = fixture('session-ptc-minimal.jsonl');
const s = ctx.sessions.create('ptc-probe', { seed: cookieSeed('session-ptc-minimal.jsonl') });

/** 在打开的 step 里注入一条真实形态的 PTC plasticize 声明。 */
const ptcDeclare = (session, at, rootCallId, args) => {
  const subCallId = rootCallId + ':ptc:1';
  session.append('assistant/message', {
    turn: at.turn, step: at.step,
    message: {
      id: 'am-' + rootCallId, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: rootCallId, name: 'run_code', arguments: '{}' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId, name: 'plasticize', arguments: args });
  session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId, name: 'plasticize', arguments: args, isError: false, content: [{ type: 'text', text: '已登记' }] });
  session.append('tool/result', {
    turn: at.turn, step: at.step,
    message: { id: 'tr-' + rootCallId, role: 'tool', toolCallId: rootCallId, content: [{ type: 'text', text: '已登记' }], isError: false, source: { kind: 'tool', callId: rootCallId } },
  }, { surfaceOp: 'append' });
};

console.log(NL + '⓪ 真实 PTC 日志形态自检');
{
  const dispatch = s.snapshotEvents().filter((e) => e.type === 'tool/ptc-dispatch-start');
  ok(dispatch.length > 0, '日志里有 tool/ptc-dispatch-start 事件（' + dispatch.length + ' 条）');
  const samples = dispatch.filter((e) => typeof e.data?.subCallId === 'string');
  ok(samples.length === dispatch.length, '每条都有 subCallId');
  ok(samples[0].data.subCallId.includes(':ptc:'), 'subCallId 形如 <rootCallId>:ptc:N', samples[0].data.subCallId);
  ok(typeof samples[0].data.rootCallId === 'string', 'rootCallId 可用于反查承载它的 assistant 消息');
  const blocks = s.snapshotEvents().filter((e) => e.type === 'assistant/message'
    && e.data.message.content.some((b) => b?.type === 'tool-call'));
  ok(blocks.length > 0, '这条日志里 assistant 消息带的是 run_code（不是内层工具）');
  const inner = blocks.filter((e) => e.data.message.content.some((b) => b?.type === 'tool-call' && b.name !== 'run_code'));
  ok(inner.length === 0, '**没有**内层工具名出现在 tool-call 块里 —— 这正是旧实现的盲区');
}

console.log(NL + '① 新实现必须认得 PTC 形态的 plasticize 声明');
{
  s.append('turn/start', { turn: 99 });
  s.append('step/start', { turn: 99, step: 1 });
  // ptc-minimal 的布局：cookie 5@10 与 cookie 6@13 之间是「assistant + tool/result」一组。
  ptcDeclare(s, { turn: 99, step: 1 }, 'ptc-root-1', { ops: [{ spans: ['(5,6)'], new_text: '⟨PTC 压缩结论⟩' }], option: 'execute' });

  const before = pendingReport(s);
  ok(before.length === 1 && before[0].via === 'ptc', '**认出了 PTC 声明**（旧实现这里恒为 0）', JSON.stringify(before));

  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1, '写下了 1 条 replace', String(reps.length));
  ok(r.applied === 1, 'flush 报告应用 1 条', JSON.stringify(r));
  ok(reps[0].sourceEventSeqs.length === 2, '遮蔽的是整组（调用 + 结果）', String(reps[0].sourceEventSeqs.length));
  ok(textOf(s).includes('⟨PTC 压缩结论⟩'), '替代文本进入工作面');
}

console.log(NL + '② 幂等：重复 flush 不再动作，日志保持合法');
{
  const seqBefore = s.seq;
  const r2 = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(s.seq === seqBefore, '第二次 flush 不产生新事件', JSON.stringify(r2));
  ok(pendingReport(s).length === 0, '待办已清空');
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1, 'replace 仍只有 1 条', String(reps.length));
  const ctx2 = new Context(); new SessionStore(ctx2);
  const s2 = ctx2.sessions.create('ptc-replay', { seed: JSON.parse(JSON.stringify(s.snapshotEvents())).filter((e) => e.type !== 'session') });
  ok(JSON.stringify([...s2.surface.nodes]) === JSON.stringify([...s.surface.nodes]), '重建后工作面逐条一致');
}

console.log(NL + '③ PTC 路径与 native 路径共用同一套解析（this 也认）');
{
  const ctx3 = new Context(); new SessionStore(ctx3);
  const s3 = ctx3.sessions.create('ptc-self', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  s3.append('turn/start', { turn: 99 });
  s3.append('step/start', { turn: 99, step: 1 });
  ptcDeclare(s3, { turn: 99, step: 1 }, 'ptc-root-self', { ops: [{ spans: ['this'], new_text: '' }], option: 'execute' });
  const pm = pairingMaps(s3);   // 必须在投影**之前**取：投影会改变工作面
  const r3 = flush(s3, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r3.applied === 1, 'PTC 路径下的 this 也能落地', JSON.stringify(r3));
  const reps = s3.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1, '写下 1 条 replace', String(reps.length));
  const refs = reps[0].sourceEventSeqs;
  ok(pm.before.get(refs[0]) === 0 && pm.after.get(refs[refs.length - 1]) === 0,
    '扩展后落在块边界（配对完整）', refs.length + ' 条');
  ok(s3.eventAt(refs[0]).type === 'assistant/message' && s3.eventAt(refs[refs.length - 1]).type === 'tool/result',
    '覆盖调用消息与它的结果');
}

console.log(NL + '④ 工具执行期：this 组还没落地时，execute 不能报错（真实事故）');
{
  // 现场：模型 call run_code → 内层 plasticize({spans:['this'], option:'execute'})
  // 此刻外层的 tool/result **还没 append**，this 组的后边界不存在。
  // 旧实现在这里直接 resolveOps + checkBalanced → 报「拆开工具对」，
  // 模型收到错误后重试 4 次，而每次失败在边界上仍然被写入投影（更糟，见 ⑤）。
  const tctx = new Context(); new SessionStore(tctx); new SystemPrompt(tctx, {}); new ToolRuntime(tctx);
  tctx.plugin(await import('./index.js'), {});
  await new Promise((r) => setTimeout(r, 30));
  const tool = tctx.tools.get('plasticize');
  ok(tool !== undefined, '工具已注册');

  const ts = tctx.sessions.create('ptc-tool-self', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  ts.append('turn/start', { turn: 2 });
  ts.append('step/start', { turn: 2, step: 1 });
  const root = 'call_root_exec';
  const sub = root + ':ptc:1';
  const args = { ops: [{ spans: ['this'], new_text: '⟨吞掉本步⟩' }], option: 'execute' };
  ts.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am-exec', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: root, name: 'run_code', arguments: '{}' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  ts.append('tool/call', { turn: 2, step: 1, callId: root, name: 'run_code', arguments: '{}' });
  ts.append('tool/ptc-dispatch-start', { rootCallId: root, parentCallId: root, subCallId: sub, name: 'plasticize', arguments: args });

  let err;
  let res;
  try {
    res = await tool.execute(args, { agent: { session: ts }, callId: sub, name: 'plasticize', arguments: args, signal: new AbortController().signal });
  } catch (e) { err = e; }
  ok(err === undefined, '工具执行期不报错（this 组不完整是常态）', String(err?.message).slice(0, 90));
  ok(typeof res?.text === 'string' && res.text.includes('Registered'), '回执正常返回「已登记」', String(res?.text).slice(0, 60));

  // 结果补齐后，边界上按完整的 this 组落地。
  ts.append('tool/ptc-dispatch', { rootCallId: root, parentCallId: root, subCallId: sub, name: 'plasticize', arguments: args, isError: false, content: [{ type: 'text', text: '已登记' }] });
  const resultSeq = ts.append('tool/result', {
    turn: 2, step: 1,
    message: { id: 'tr-exec', role: 'tool', toolCallId: root, content: [{ type: 'text', text: '已登记' }], isError: false, source: { kind: 'tool', callId: root } },
  }, { surfaceOp: 'append' }).seq;
  const r = flush(ts, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(r.applied === 1, '边界上落地 1 条', JSON.stringify(r));
  const reps = ts.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1 && reps[0].surfaceOp.endSeq === resultSeq, '遮蔽范围 = 本步整组（含结果）', JSON.stringify(reps[0]?.sourceEventSeqs));
  ok(textOf(ts).includes('⟨吞掉本步⟩'), '替代文本进入工作面');
}

console.log(NL + '⑤ 工具执行失败时：声明永远不落地（不能悄悄生效）');
{
  const fctx = new Context(); new SessionStore(fctx);
  const fs = fctx.sessions.create('ptc-failed', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  fs.append('turn/start', { turn: 2 });
  fs.append('step/start', { turn: 2, step: 1 });
  const root = 'call_root_fail';
  const sub = root + ':ptc:1';
  const args = { ops: [{ spans: ['(5,6)'], new_text: '⟨不该出现⟩' }], option: 'execute' };
  fs.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am-fail', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: root, name: 'run_code', arguments: '{}' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  fs.append('tool/ptc-dispatch-start', { rootCallId: root, parentCallId: root, subCallId: sub, name: 'plasticize', arguments: args });
  fs.append('tool/ptc-dispatch', { rootCallId: root, parentCallId: root, subCallId: sub, name: 'plasticize', arguments: args, isError: true, content: [{ type: 'text', text: 'Error: 故意失败' }] });
  fs.append('tool/result', {
    turn: 2, step: 1,
    message: { id: 'tr-fail', role: 'tool', toolCallId: root, content: [{ type: 'text', text: 'Error: 故意失败' }], isError: true, source: { kind: 'tool', callId: root } },
  }, { surfaceOp: 'append' });

  const r = flush(fs, { openStep: { turn: 2, step: 1 } }, quiet);
  const reps = fs.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 0, '失败的 execute 不写任何投影', String(reps.length) + ' | ' + JSON.stringify(r));
  ok(pendingReport(fs).length === 0, '它被视为已了结，不会每个边界重试');
  ok(!textOf(fs).includes('⟨不该出现⟩'), '替代文本没有进入工作面');
  const r2 = flush(fs, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(r2.applied === 0 && r2.skipped === 0 && r2.auto === 0, '第二次边界也不动作', JSON.stringify(r2));
}

console.log(NL + '⑥b set 预览：this 组不完整时也能算预览（且不写日志）');
{
  const tctx = new Context(); new SessionStore(tctx); new SystemPrompt(tctx, {}); new ToolRuntime(tctx);
  tctx.plugin(await import('./index.js'), {});
  await new Promise((r) => setTimeout(r, 30));
  const tool = tctx.tools.get('plasticize');
  const ts = tctx.sessions.create('ptc-set-preview', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  ts.append('turn/start', { turn: 2 });
  ts.append('step/start', { turn: 2, step: 1 });
  const root = 'call_root_set';
  const sub = root + ':ptc:1';
  const args = { ops: [{ spans: ['this'], new_text: '⟨预览用⟩' }], option: 'set' };
  ts.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am-set', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: root, name: 'run_code', arguments: '{}' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  ts.append('tool/call', { turn: 2, step: 1, callId: root, name: 'run_code', arguments: '{}' });
  ts.append('tool/ptc-dispatch-start', { rootCallId: root, parentCallId: root, subCallId: sub, name: 'plasticize', arguments: args });
  const seqBefore = ts.seq;
  let err;
  let res;
  try {
    res = await tool.execute(args, { agent: { session: ts }, callId: sub, name: 'plasticize', arguments: args, signal: new AbortController().signal });
  } catch (e) { err = e; }
  ok(err === undefined, 'set 预览不报错', String(err?.message).slice(0, 90));
  ok(typeof res?.text === 'string' && res.text.includes('Preview only'), '返回了预览', String(res?.text).slice(0, 50));
  ok(res?.text.includes('⟨预览用⟩'), '预览里含替代文本');
  ok(ts.seq === seqBefore, 'set 不写日志', String(ts.seq - seqBefore));
  const reps = ts.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 0, '没有 replace 事件', String(reps.length));
}

console.log(NL + '⑥ 待决 set 查找认得 PTC 形态');
{
  const pctx = new Context(); new SessionStore(pctx);
  const ps = pctx.sessions.create('ptc-set', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  ps.append('turn/start', { turn: 2 });
  ps.append('step/start', { turn: 2, step: 1 });
  ptcDeclare(ps, { turn: 2, step: 1 }, 'ptc-root-set', { ops: [{ spans: ['(5,6)'], new_text: '⟨预览⟩' }], option: 'set' });
  const pending = findLastPendingSet(ps);
  ok(pending !== undefined, '找得到 PTC 形态的 set');
  ok(pending?.callId === 'ptc-root-set:ptc:1', 'callId 是 subCallId', String(pending?.callId));
}

console.log(NL + '⑦ PTC + also_execute_last_set：零点属于 set，且只写一条投影');
{
  // 真实事故（两份测试日志）：PTC 下 execute 的锚点用了 subCallId，反查不到承载消息，
  // 于是 set 与 execute 各按自己的零点解析 → 写了**两条**投影（同一段结论出现两次），
  // 模型以为没生效又重发一轮。（native 下 callId == ownerCallId，所以测试一直没抓到。）
  const actx = new Context(); new SessionStore(actx);
  const as = actx.sessions.create('ptc-anchor', { seed: cookieSeed('session-ptc-minimal.jsonl') });
  const quiet2 = { warn: () => {}, info: () => {} };
  const repsOf = (sess) => sess.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  const args = { ops: [{ spans: ['this'], new_text: '⟨PTC 预览③⟩' }], option: 'set' };

  as.append('turn/start', { turn: 2 });
  as.append('step/start', { turn: 2, step: 1 });
  ptcDeclare(as, { turn: 2, step: 1 }, 'ptc-root-set3', { ...args });
  const setGroupSeqs = as.snapshotEvents()
    .filter((e) => (e.type === 'assistant/message' && e.data.message.content.some((b) => b.id === 'ptc-root-set3'))
      || (e.type === 'tool/result' && e.data.message.toolCallId === 'ptc-root-set3'))
    .map((e) => e.seq);
  flush(as, { openStep: { turn: 2, step: 1 } }, quiet2);
  ok(repsOf(as).length === 0, 'set 不写投影', String(repsOf(as).length));

  as.append('step/end', { turn: 2, step: 1 });
  as.append('step/start', { turn: 2, step: 2 });
  ptcDeclare(as, { turn: 2, step: 2 }, 'ptc-root-exec3', { ...args, option: 'execute', also_execute_last_set: true });
  const execCallSeq = as.snapshotEvents()
    .find((e) => e.type === 'assistant/message' && e.data.message.content.some((b) => b.id === 'ptc-root-exec3')).seq;
  const r = flush(as, { openStep: { turn: 2, step: 2 } }, quiet2);
  const reps = repsOf(as);
  ok(reps.length === 1, '**只写一条** replace（不是 set/execute 各一条）', String(reps.length) + ' | ' + JSON.stringify(r));
  ok(JSON.stringify(reps[0].sourceEventSeqs) === JSON.stringify(setGroupSeqs),
    '遮蔽的是 **set 那一步**（零点属于 set）', JSON.stringify(reps[0].sourceEventSeqs));
  ok(as.surface.nodes.includes(execCallSeq), 'execute 自己那一步没有被替换');
  const repSource0 = reps[0].data?.message?.source ?? reps[0].data?.source;
  ok(Array.isArray(repSource0?.consumed)
    && repSource0.consumed.includes('ptc-root-exec3:ptc:1'),
    '标记同时了结 execute（consumed）', JSON.stringify(repSource0?.consumed));
  ok((textOf(as).match(/⟨PTC 预览③⟩/g) ?? []).length === 1, '替代文本只出现一次');

  const seqBefore = as.seq;
  flush(as, { openStep: { turn: 2, step: 2 } }, quiet2);
  ok(as.seq === seqBefore, '下个边界不再重复执行 execute', String(as.seq - seqBefore));
}

done();