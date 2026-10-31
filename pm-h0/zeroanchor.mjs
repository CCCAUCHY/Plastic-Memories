/**
 * PM · 零点锚定回归（cookie / this 版）。
 *
 * 旧版负偏移量的「零点」问题在 cookie 端点上**自然消失** ——
 * cookie 编号是绝对坐标，set 与 execute 解析出同一段。
 *
 * 但 this 端点仍然需要一个零点：**this = 写下这条 ops 的那条 plasticize**。
 * 所以 execute 带 also_execute_last_set 重传同一条 this 时，
 * 必须按 **set 那条消息** 解析，而不是 execute 自己 ——
 * 否则「看了预览再决定」会落到另一段上，整个设计就失效了。
 *
 * 运行：node zeroanchor.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SystemPrompt from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { makeCounter, cookieSeed, cookieNodes, openStep, plasticizeCall, textOf } from './testkit.mjs';
import { flush } from './engine.js';
import { surfaceNodes } from './coords.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('zeroanchor');
const quiet = { warn: () => {}, info: () => {} };

const ctx = new Context(); new SessionStore(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx);
ctx.plugin(await import('./index.js'), {});
await new Promise((r) => setTimeout(r, 30));

let n = 0;
const mk = () => {
  const s = ctx.sessions.create('za-' + (++n), { seed: cookieSeed('subagent-95230f54.jsonl') });
  openStep(s, 2, 1);
  return s;
};
const reps = (s) => s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
const step2 = (s) => { s.append('step/end', { turn: 2, step: 1 }); s.append('step/start', { turn: 2, step: 2 }); };

console.log(NL + '① cookie 端点没有零点问题：set 与 execute 解析出**同一段**');
{
  const s = mk();
  const ops = [{ spans: ['(1,5)'], new_text: '⟨零点测试⟩' }];
  plasticizeCall(s, { turn: 2, step: 1 }, 'za-set', { ops, option: 'set' });
  ok(reps(s).length === 0, 'set 不写日志');
  step2(s);
  // execute 在另一步里**原样重传**同一条 ops
  plasticizeCall(s, { turn: 2, step: 2 }, 'za-exec', { ops, option: 'execute', also_execute_last_set: true });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied >= 1, 'execute 被处理', JSON.stringify(r));
  const explicit = reps(s).filter((e) => ((e.data?.message?.source ?? e.data?.source)?.note ?? '').startsWith('auto-hide') === false);
  ok(explicit.length === 1, '**只写一条**显式 replace（不是两条）', String(explicit.length));
  ok(explicit[0].sourceEventSeqs.length === 7, '遮蔽 7 条（cookie1..cookie5 之间）', String(explicit[0].sourceEventSeqs.length));
  const t = textOf(s);
  ok(t.includes('⟨零点测试⟩'), '替代文本进入工作面');
  ok((t.match(/⟨零点测试⟩/g) ?? []).length === 1, '**只出现一次**（没有重复应用）');
  // 去重后的那条投影必须**同时了结 set 与 execute**：否则下个边界会把 execute 再执行一遍。
  const zaSource = explicit[0].data?.message?.source ?? explicit[0].data?.source;
  ok(Array.isArray(zaSource?.consumed)
    && zaSource.consumed.includes('za-exec'),
    '标记里记下了被合并的 execute callId', JSON.stringify(zaSource?.consumed));
  const seqBefore = s.seq;
  const repsBefore = reps(s).length;
  flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(s.seq === seqBefore, '下个边界不再重复执行 execute', String(s.seq - seqBefore));
  ok(reps(s).length === repsBefore, '不新增 replace', repsBefore + ' -> ' + reps(s).length);
  const explicitAfter = reps(s).filter((e) => ((e.data?.message?.source ?? e.data?.source)?.note ?? '').startsWith('auto-hide') === false);
  ok(explicitAfter.length === 1, '显式投影仍只有 1 条', String(explicitAfter.length));
}

console.log(NL + '② this 的零点属于写下它的那条 plasticize（set）');
{
  const s = mk();
  const nodesBefore = surfaceNodes(s);
  plasticizeCall(s, { turn: 2, step: 1 }, 'za-set2', { ops: [{ spans: ['this'], new_text: '⟨来自 set⟩' }], option: 'set' });
  const setCallSeq = s.snapshotEvents().find((e) => e.type === 'assistant/message'
    && e.data.message.content.some((b) => b.id === 'za-set2')).seq;
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'za-exec2', { ops: [{ spans: ['this'], new_text: '⟨来自 set⟩' }], option: 'execute', also_execute_last_set: true });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied >= 1, 'execute 被处理', JSON.stringify(r));
  ok(reps(s).length === 1, '写下了投影', String(reps(s).length));
  const shadowed = reps(s)[0].sourceEventSeqs;
  ok(shadowed.includes(setCallSeq), '遮蔽的是 **set 那一步**（零点属于 set）', JSON.stringify(shadowed));
  const execCallSeq = s.snapshotEvents().find((e) => e.type === 'assistant/message'
    && e.data.message.content.some((b) => b.id === 'za-exec2')).seq;
  ok(!shadowed.includes(execCallSeq), '不是 execute 那一步');
  ok(textOf(s).includes('⟨来自 set⟩'), '替代文本进入工作面');
  void nodesBefore;
}

console.log(NL + '③ execute 用**新内容**时，覆盖 set（不是叠加）');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'za-set3', { ops: [{ spans: ['(1,5)'], new_text: '⟨旧的⟩' }], option: 'set' });
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'za-exec3', { ops: [{ spans: ['(5,6)'], new_text: '⟨新的⟩' }], option: 'execute' });
  flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  const t = textOf(s);
  ok(t.includes('⟨新的⟩'), '新内容生效');
  ok(!t.includes('⟨旧的⟩'), '旧内容没有被应用');
  const explicit = reps(s).filter((e) => ((e.data?.message?.source ?? e.data?.source)?.note ?? '').startsWith('auto-hide') === false);
  ok(explicit.length === 1, '只写一条显式 replace', String(explicit.length));
}

console.log(NL + '④ 部分重叠（模型算错）必须被点名拒绝，而不是写坏');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'za-set4', { ops: [{ spans: ['(1,5)'], new_text: 'A' }], option: 'set' });
  step2(s);
  // execute 的 ops 与 set 的**部分重叠**
  plasticizeCall(s, { turn: 2, step: 2 }, 'za-exec4', { ops: [{ spans: ['(1,6)'], new_text: 'B' }], option: 'execute', also_execute_last_set: true });
  const warnings = [];
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, { warn: (m) => warnings.push(String(m)), info: () => {} });
  ok(reps(s).length === 0, '一批里部分重叠 → 整批不写（工作面不被写坏）', String(reps(s).length));
  ok(r.skipped > 0, '被跳过', JSON.stringify(r));
  ok(warnings.some((w) => w.includes('overlap')), '告警点名 overlap', warnings.slice(0, 1).join('').slice(0, 80));
}

done();