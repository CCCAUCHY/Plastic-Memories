/**
 * PM · 自动隐藏回归（用户要求的行为）。
 *
 * execute **成功时**，为新世代顺手隐藏两类噪音：
 *
 *   1. 报错的 PM 工具步骤组（失败调用只会污染下一个世代）
 *   2. 成功的 plasticize(set) 步骤组（预览已兑现，留着会让模型以为还没执行）
 *
 * 只要某个步骤组里含成功的 set 或报错的 PM 调用，自动隐藏会**连其他工具一起**隐藏；
 * 因此工具说明要求不要把塑形工作和任务工作混在同一步/同一条助手消息里。
 *
 * 运行：node autohide.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, cookieSeed, openStep, plasticizeCall, textOf } from './testkit.mjs';
import { flush } from './engine.js';
import { surfaceNodes } from './coords.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('autohide');
const quiet = { warn: () => {}, info: () => {} };

const ctx = new Context();
new SessionStore(ctx);
let n = 0;
const mk = () => {
  const s = ctx.sessions.create('ah-' + (++n), { seed: cookieSeed('subagent-95230f54.jsonl') });
  openStep(s, 2, 1);
  return s;
};
const reps = (s) => s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
const autoReps = (s) => reps(s).filter((e) => ((e.data?.message?.source ?? e.data?.source)?.note ?? '').startsWith('auto-hide'));
const explicitReps = (s) => reps(s).filter((e) => ((e.data?.message?.source ?? e.data?.source)?.note ?? '').startsWith('auto-hide') === false);
const noteOf = (e) => (e.data?.message ?? e.data)?.source?.note;
const step2 = (s) => { s.append('step/end', { turn: 2, step: 1 }); s.append('step/start', { turn: 2, step: 2 }); };
const seqOfCall = (s, callId) => s.snapshotEvents()
  .find((e) => e.type === 'assistant/message' && e.data.message.content.some((b) => b.id === callId))?.seq;

console.log(NL + '① execute 成功后：成功的 set 步骤组被自动隐藏');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah-set', { ops: [{ spans: ['(1,5)'], new_text: '⟨预览⟩' }], option: 'set' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(reps(s).length === 0, 'set 阶段不写任何投影');
  const setSeq = seqOfCall(s, 'ah-set');
  ok(setSeq !== undefined, '找到 set 那一步的调用消息', String(setSeq));

  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied === 1, 'execute 落地', JSON.stringify(r));
  ok(r.auto === 1, '自动隐藏了 1 组', JSON.stringify(r));
  ok(explicitReps(s).length === 1, '显式投影 1 条', String(explicitReps(s).length));
  const autos = autoReps(s);
  const autoMsg = autos[0] === undefined ? undefined : (autos[0].data?.message ?? autos[0].data);
  ok(autos.length === 1 && autos[0].type === 'developer/message' && Array.isArray(autoMsg?.content) && autoMsg.content.length === 0, '自动隐藏写的是空 developer 消息', autos[0] === undefined ? '0' : String(autos[0].type));
  ok(noteOf(autos[0]) === 'auto-hide:set', '原因标记为 set', String(noteOf(autos[0])));
  ok(autos[0].sourceEventSeqs.includes(setSeq), '遮蔽的正是 set 那一步的调用消息');
  ok(!s.surface.nodes.includes(setSeq), 'set 消息已离开工作面');
  ok(textOf(s).includes('⟨结论⟩'), '显式投影生效');
  ok(!textOf(s).includes('⟨预览⟩'), '预览文本没有进入新世代');
}

console.log(NL + '② 报错的 PM 步骤组，在下一次成功的 execute 时被隐藏');
{
  const s = mk();
  // 一个会失败的 PM 调用：区间语法非法 → resolveOps 抛错 → 整批跳过（不写投影）
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah-bad', { ops: [{ spans: ['bad-span'] }], option: 'execute' }, { isError: true, resultText: 'Error: 端点 "bad-span" 不合法' });
  const r0 = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(reps(s).length === 0, '失败的调用不写投影', JSON.stringify(r0) + ' | ' + String(reps(s).length));
  const badSeq = seqOfCall(s, 'ah-bad');

  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-ok', { ops: [{ spans: ['(5,6)'], new_text: '⟨成功⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied === 1, '成功的 execute 落地', JSON.stringify(r));
  const autos = autoReps(s);
  ok(autos.length === 1, '自动隐藏了报错的那一组', String(autos.length));
  ok(noteOf(autos[0]) === 'auto-hide:error', '原因标记为 error', String(noteOf(autos[0])));
  ok(autos[0].sourceEventSeqs.includes(badSeq), '遮蔽的正是失败那一步的调用消息');
  ok(!s.surface.nodes.includes(badSeq), '失败消息已离开工作面');
}

console.log(NL + '③ 混合步骤也会整体自动隐藏（只要含成功的 set）');
{
  const s = mk();
  // 一步里同时有 plasticize(set) 与 bash：现在整组都会被自动隐藏。
  s.append('assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'am-mixed', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [
        { type: 'tool-call', id: 'mix-pm', name: 'plasticize', arguments: JSON.stringify({ ops: [{ spans: ['(1,5)'], new_text: '⟨预览⟩' }], option: 'set' }) },
        { type: 'tool-call', id: 'mix-bash', name: 'bash', arguments: '{}' },
      ],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  s.append('tool/call', { turn: 2, step: 1, callId: 'mix-pm', name: 'plasticize', arguments: '{}' });
  s.append('tool/call', { turn: 2, step: 1, callId: 'mix-bash', name: 'bash', arguments: '{}' });
  s.append('tool/result', { turn: 2, step: 1, message: { id: 'tr-mix-pm', role: 'tool', toolCallId: 'mix-pm',
    content: [{ type: 'text', text: '已登记' }], isError: false, source: { kind: 'tool', callId: 'mix-pm' } } }, { surfaceOp: 'append' });
  s.append('tool/result', { turn: 2, step: 1, message: { id: 'tr-mix-bash', role: 'tool', toolCallId: 'mix-bash',
    content: [{ type: 'text', text: '构建成功' }], isError: false, source: { kind: 'tool', callId: 'mix-bash' } } }, { surfaceOp: 'append' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);

  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec2', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied === 1, 'execute 落地', JSON.stringify(r));
  const autos = autoReps(s);
  ok(autos.length === 1, '混合 set 步骤被自动隐藏', String(autos.length));
  ok(noteOf(autos[0]) === 'auto-hide:set', '原因标记为 set', String(noteOf(autos[0])));
  const mixedSeq = seqOfCall(s, 'mix-pm');
  ok(!s.surface.nodes.includes(mixedSeq), '混合步骤的调用消息离开工作面', String(mixedSeq));
  ok(!textOf(s).includes('构建成功'), '同一步里 bash 的成果也随整组隐藏');
}

console.log(NL + '③b 混合的报错 PM 步骤也会整体隐藏');
{
  const s = mk();
  s.append('assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'am-mixed-err', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [
        { type: 'tool-call', id: 'mix-bad', name: 'plasticize', arguments: JSON.stringify({ ops: [{ spans: ['bad-span'] }], option: 'execute' }) },
        { type: 'tool-call', id: 'mix-bash-err', name: 'bash', arguments: '{}' },
      ],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  s.append('tool/call', { turn: 2, step: 1, callId: 'mix-bad', name: 'plasticize', arguments: '{}' });
  s.append('tool/call', { turn: 2, step: 1, callId: 'mix-bash-err', name: 'bash', arguments: '{}' });
  s.append('tool/result', { turn: 2, step: 1, message: { id: 'tr-mix-bad', role: 'tool', toolCallId: 'mix-bad',
    content: [{ type: 'text', text: 'Error: 端点不合法' }], isError: true, source: { kind: 'tool', callId: 'mix-bad' } } }, { surfaceOp: 'append' });
  s.append('tool/result', { turn: 2, step: 1, message: { id: 'tr-mix-bash-err', role: 'tool', toolCallId: 'mix-bash-err',
    content: [{ type: 'text', text: '任务成果' }], isError: false, source: { kind: 'tool', callId: 'mix-bash-err' } } }, { surfaceOp: 'append' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);

  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec3', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论2⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied === 1, 'execute 落地（混合报错组）', JSON.stringify(r));
  const autos = autoReps(s);
  ok(autos.length === 1, '混合报错步骤被自动隐藏', String(autos.length));
  ok(noteOf(autos[0]) === 'auto-hide:error', '原因标记为 error', String(noteOf(autos[0])));
  const badSeq = seqOfCall(s, 'mix-bad');
  ok(!s.surface.nodes.includes(badSeq), '混合报错步骤的调用消息离开工作面');
  ok(!textOf(s).includes('任务成果'), '同一步里 bash 的成果也随整组隐藏');
}

console.log(NL + '④ autoHide:false 时完全不隐藏');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah-set4', { ops: [{ spans: ['(1,5)'], new_text: '⟨预览⟩' }], option: 'set' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec4', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 2 }, autoHide: false }, quiet);
  ok(r.applied === 1, 'execute 落地', JSON.stringify(r));
  ok(r.auto === 0, 'autoHide:false 时不自动隐藏', JSON.stringify(r));
  ok(autoReps(s).length === 0, '没有自动隐藏事件', String(autoReps(s).length));
  const setSeq = seqOfCall(s, 'ah-set4');
  ok(s.surface.nodes.includes(setSeq), 'set 那一步仍留在工作面上', String(setSeq));
}

console.log(NL + '⑤ 幂等：重复 flush 不重复隐藏');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah-set5', { ops: [{ spans: ['(1,5)'], new_text: '⟨预览⟩' }], option: 'set' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec5', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论⟩' }], option: 'execute' });
  flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  const before = s.seq;
  const n1 = reps(s).length;
  const r2 = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(s.seq === before, '第二次 flush 不产生新事件', String(s.seq - before));
  ok(reps(s).length === n1, '不重复隐藏', n1 + ' -> ' + reps(s).length);
  ok(r2.applied === 0 && r2.auto === 0, '第二次没有动作', JSON.stringify(r2));
}

console.log(NL + '⑥ 没有打开的 step 时自动隐藏推迟，下一个边界补上');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah-set6', { ops: [{ spans: ['(1,5)'], new_text: '⟨预览⟩' }], option: 'set' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah-exec6', { ops: [{ spans: ['(5,6)'], new_text: '⟨结论⟩' }], option: 'execute' });
  // 边界不知道 step 开着（turn 末的兜底调用就是这样）：显式投影可写，空洞要推迟。
  const r1 = flush(s, { openStep: undefined }, quiet);
  ok(r1.applied === 1 && r1.auto === 0, '第一拍：显式投影落地，自动隐藏推迟', JSON.stringify(r1));
  ok(autoReps(s).length === 0, '第一拍没有自动隐藏事件');
  const r2 = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r2.applied === 0 && r2.auto === 1, '第二拍补上自动隐藏', JSON.stringify(r2));
  ok(autoReps(s).length === 1, '现在有 1 条自动隐藏', String(autoReps(s).length));
  // 补做之后，被遮的 set 组已经不在工作面上 —— 再 flush 也不会重复。
  const before = s.seq;
  flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(s.seq === before, '补做之后幂等', String(s.seq - before));
}

console.log(NL + '⑦ 待决的 set 预览**不能**被自动隐藏（真实事故：模型反复重发 set）');
{
  // 现场：机械测试第三次「先 set 看预览、再 execute 落实」。
  // set 的 tool/result 刚落地，下一次边界的自动隐藏就把它当「已兑现的 set」吞了 ——
  // 模型看不到预览，只能按提示再发一次 set，如此循环卡死在第三步。
  const s = mk();
  // 先制造一次**成功的 execute**（让 appliedBefore = true，自动隐藏从此每拍都会跑）
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah7-exec0', { ops: [{ spans: ['(5,6)'], new_text: '⟨先例⟩' }], option: 'execute' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(autoReps(s).length === 0 && explicitReps(s).length === 1, '先例 execute 落地（无自动隐藏目标）', String(reps(s).length));

  // 第 2 步：set（预览）。没有 execute 来兑现它。
  // 注意这里让 set 的区间指向别处（不是 this）—— 这样 set 自己的步骤组会留在工作面上，
  // 才能验证「兑现后由自动隐藏收拾它」。
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah7-set', { ops: [{ spans: ['(5,6)'], new_text: '⟨预览⑦⟩' }], option: 'set' });
  const setSeq = seqOfCall(s, 'ah7-set');
  const r1 = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r1.auto === 0, 'set 落地后的边界不隐藏它', JSON.stringify(r1));
  ok(autoReps(s).length === 0, '没有 auto-hide:set 事件', String(autoReps(s).length));
  ok(s.surface.nodes.includes(setSeq), '待决 set 的调用消息仍在工作面上', String(setSeq));
  // 再跑一拍（无待办）也不能把它吞掉
  flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(s.surface.nodes.includes(setSeq), '后续边界同样保留待决 set');

  // 第 3 步：execute 兑现它 —— 这时才允许隐藏那个 set 步骤组
  s.append('step/end', { turn: 2, step: 2 });
  s.append('step/start', { turn: 2, step: 3 });
  plasticizeCall(s, { turn: 2, step: 3 }, 'ah7-exec', { ops: [], option: 'execute', also_execute_last_set: true });
  const r2 = flush(s, { openStep: { turn: 2, step: 3 } }, quiet);
  ok(r2.applied >= 1 && r2.auto === 1, 'execute 兑现了待决 set，并顺手隐藏它', JSON.stringify(r2));
  const autos = autoReps(s);
  ok(autos.length === 1 && noteOf(autos[0]) === 'auto-hide:set', '此刻才隐藏该 set 组', String(autos.length));
  ok(autos[0].sourceEventSeqs.includes(setSeq), '被隐藏的正是那个 set 调用');
  ok(!s.surface.nodes.includes(setSeq), 'set 组已离开工作面');
  ok(textOf(s).includes('⟨预览⑦⟩'), 'set 的区间也被兑现（替代文本进入工作面）', String(explicitReps(s).length));
}

console.log(NL + '⑧ 报错的 PM 步骤组：也要等**下一次成功 execute** 才清理');
{
  const s = mk();
  // 先例：一次成功的 execute（此后自动隐藏的「闸门」才可能打开）
  plasticizeCall(s, { turn: 2, step: 1 }, 'ah8-exec0', { ops: [{ spans: ['(5,6)'], new_text: '⟨先例⑧⟩' }], option: 'execute' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);

  // 第 2 步：一个**报错**的 PM 调用（现在没有新的 execute）
  step2(s);
  plasticizeCall(s, { turn: 2, step: 2 }, 'ah8-bad', { ops: [{ spans: ['(5,6)'] }], option: 'execute' }, { isError: true, resultText: 'Error: 故意失败' });
  const badSeq = seqOfCall(s, 'ah8-bad');
  const r1 = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(autoReps(s).length === 0, '没有 execute 时，报错的步骤组不被清理', JSON.stringify(r1));
  ok(s.surface.nodes.includes(badSeq), '报错调用仍在工作面上', String(badSeq));

  // 第 3 步：一次成功的 execute —— 这时才该清理它
  s.append('step/end', { turn: 2, step: 2 });
  s.append('step/start', { turn: 2, step: 3 });
  plasticizeCall(s, { turn: 2, step: 3 }, 'ah8-exec1', { ops: [{ spans: ['(1,5)'], new_text: '⟨结论⑧⟩' }], option: 'execute' });
  const r2 = flush(s, { openStep: { turn: 2, step: 3 } }, quiet);
  ok(r2.auto === 1, '成功 execute 之后才清理', JSON.stringify(r2));
  const autos = autoReps(s);
  ok(autos.length === 1 && noteOf(autos[0]) === 'auto-hide:error', '清理的是报错那一组', String(autos.length));
  ok(autos[0].sourceEventSeqs.includes(badSeq), '遮蔽的正是报错的调用');
  ok(!s.surface.nodes.includes(badSeq), '报错调用已离开工作面');
}

done();