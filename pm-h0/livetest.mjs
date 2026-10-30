/**
 * PM · 真实会话日志上的行为回归（cookie / spans 版）。
 *
 * 夹具是**真实导出**的会话日志（含并行调用、reasoning 块、PTC 派发），
 * 而不是手工构造的理想结构 —— 几次真实事故都只在真实日志里复现。
 *
 * 覆盖：坐标解析（stepGroup / this / cookie 编号）、retrospect 的世代坐标、
 * 一步多调用的配对、以及对旧 pm_* 会话的读取。
 *
 * 运行：node livetest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, fixture, cookieSeed, cookieNodes, cookieEvent, textOf, openStep, plasticizeCall, makeStore } from './testkit.mjs';
import { pairingMaps, snapshotSurface, stepGroup, indexOfCall, checkBalanced } from './coords.js';
import { appendPluginRecord, snapshotSessionEvent } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { flush, stageUserOperation, flushUserOperations, clearStagedOperations, countLogicalGenerations, assertSinglePendingExecute, installPrivateRecordAppender, lockedSeqs, safetyZoneIntervals } from './engine.js';
import { initState, applyEvent, viewOf } from './generations.js';
import { retrospect } from './retrospect.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('livetest');
const quiet = { warn: () => {}, info: () => {} };
installPrivateRecordAppender(appendPluginRecord);

const FX = 'session-native-multicall.jsonl';
// 布局：0 system / 1 ck1 / 2 user / 3 ck2 / 4 运行时常量 / 5 ck3 / 6 时间快照 / 7 ck4
//       8 assistant(并行 3 调用) / 9,10,11 三个 tool/result / 12 ck5 / 13 assistant(终) / 14 ck6
let n = 0;
const mk = () => {
  const ctx = new Context();
  new SessionStore(ctx);
  return ctx.sessions.create('lt-' + (++n), { seed: cookieSeed(FX) });
};

console.log(NL + '① 真实日志：一步多调用的结构');
{
  const s = mk();
  const snap = snapshotSurface(s);
  const pm = pairingMaps(s);
  ok(pm.malformed === 0, '没有形态无法识别的块', String(pm.malformed));
  const multi = snap.entries.find((e) => e.event.type === 'assistant/message'
    && e.message.content.filter((b) => b.type === 'tool-call').length > 1);
  ok(multi !== undefined, '找到一条带多个 tool-call 的 assistant 消息');
  if (multi !== undefined) {
    const calls = multi.message.content.filter((b) => b.type === 'tool-call').length;
    ok(pm.after.get(multi.seq) === calls, '开集 = tool-call 数（' + calls + '）', String(pm.after.get(multi.seq)));
    ok(pm.before.get(multi.seq) === 0, '它在块边界上（可作起点）');
  }
}

console.log(NL + '② indexOfCall：用 callId 反查承载消息');
{
  const s = mk();
  const snap = snapshotSurface(s);
  const withCall = snap.entries.find((e) => e.event.type === 'assistant/message'
    && e.message.content.some((b) => b.type === 'tool-call'));
  if (withCall !== undefined) {
    const callId = withCall.message.content.find((b) => b.type === 'tool-call').id;
    const found = indexOfCall(s, callId);
    ok(found !== undefined, '找到承载该调用的消息', String(callId));
    ok(found?.seq === withCall.seq, 'seq 对得上', String(found?.seq));
    ok(found?.calls?.[0]?.callId === callId, 'calls 带实时 callId');
  }
}

console.log(NL + '③ stepGroup：本步整组 = 调用消息 + 它的全部结果');
{
  const s = mk();
  openStep(s, 99, 1);
  const callId = 'sg-1';
  plasticizeCall(s, { turn: 99, step: 1 }, callId, { ops: [{ spans: ['this'] }], option: 'set' });
  const g = stepGroup(s, callId);
  ok(g !== undefined, 'stepGroup 找得到');
  ok(g?.complete === true, 'complete = true（结果已落地）', String(g?.complete));
  const snap = snapshotSurface(s);
  if (g !== undefined) {
    ok(snap.entries[g.startIndex].event.type === 'assistant/message', '起点是承载调用的 assistant 消息');
    ok(g.endIndex > g.startIndex, '终点在起点之后（含结果）', g.startIndex + '..' + g.endIndex);
  }
}

console.log(NL + '④ this = 本步整组终点：一次吞掉调用消息与它的结果');
{
  const s = mk();
  openStep(s, 99, 1);
  const callId = 'sg-2';
  const { resultSeq } = plasticizeCall(s, { turn: 99, step: 1 }, callId, {
    ops: [{ spans: ['this'], new_text: '⟨自噬⟩' }],
    option: 'execute',
  });
  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 1, 'this 区间被接受', JSON.stringify(r));
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1, '写下 1 条 replace', String(reps.length));
  ok(reps[0].surfaceOp.endSeq === resultSeq, '区间终点 = 本步最后一个 tool/result', String(reps[0].surfaceOp.endSeq) + ' vs ' + String(resultSeq));
  ok(!s.surface.nodes.includes(resultSeq), '本步结果已不在工作面上');
  ok(textOf(s).includes('⟨自噬⟩'), '替代文本进入工作面');
}

console.log(NL + '⑥ retrospect：只返回历史世代自己的上下文（结构化 JSON）');
{
  const s = mk();
  openStep(s, 99, 1);
  // 独立 letter 工具：第一次成功 execute 之前的 letter 归入第 0 代。
  const preLetter = plasticizeCall(s, { turn: 99, step: 1 }, 'letter-pre', { text: 'S: 第 0 代之前的话' }, { name: 'letter', resultText: '' });
  const preIndex = s.surface.nodes.indexOf(preLetter.declSeq);
  // 时间快照夹在 cookie3 与 cookie4 之间 → (3,4) 精确遮掉它。
  const victim = s.eventAt(s.surface.nodes[6]);
  ok(victim.type === 'user/message', '目标是时间快照那条消息', victim.type);
  const keyword = victim.data.content[0].text.slice(0, 12);
  plasticizeCall(s, { turn: 99, step: 1 }, 'hide-1', { ops: [{ spans: ['(3,4)'], new_text: '' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 1, '空洞写入成功', JSON.stringify(r));
  ok(!s.surface.nodes.includes(6), '那条消息已离开工作面');
  const afterFirst = [...s.surface.nodes];
  const firstFrozen = JSON.parse(retrospect(s, { generation: 0 }));
  ok(firstFrozen.logical === 0 && firstFrozen.count === afterFirst.length, '第一次 execute 冻结后，逻辑世代 0 立刻可查', JSON.stringify({ logical: firstFrozen.logical, count: firstFrozen.count }));

  // 第一次 execute 冻结逻辑世代 0，继续推理进入 self=1；当前世代 self 不允许查询。
  let currentError = null;
  try { retrospect(s, { generation: 1 }); } catch (error) { currentError = error.message; }
  ok(typeof currentError === 'string' && currentError.includes('self'), '当前世代 self 拒绝查询', String(currentError).slice(0, 60));

  // 第二代：先在第 0 代生命周期内留一条 letter（独立 step），再执行 execute。
  openStep(s, 99, 2);
  const zeroLetter = plasticizeCall(s, { turn: 99, step: 2 }, 'letter-zero', { text: 'L0: 第 0 代的话' }, { name: 'letter', resultText: '' });
  const zeroIndex = s.surface.nodes.indexOf(zeroLetter.declSeq);
  openStep(s, 99, 3);
  plasticizeCall(s, { turn: 99, step: 3 }, 'hide-2', { ops: [{ spans: ['this'], new_text: '⟨第二代⟩' }], option: 'execute' });
  const r2 = flush(s, { openStep: { turn: 99, step: 3 } }, quiet);
  ok(r2.applied === 1, '第二个逻辑世代写入成功', JSON.stringify(r2));

  const byNumber = JSON.parse(retrospect(s, { generation: 0 }));
  const byLabel = JSON.parse(retrospect(s, { generation: 'self - 2' }));
  ok(byNumber.logical === 0, '返回 logical（历史世代号）', String(byNumber.logical));
  ok(JSON.stringify(byNumber) === JSON.stringify(byLabel), '绝对编号与 self - 2 写法返回完全一致');
  ok(byNumber.count === afterFirst.length, '历史上下文 = 当时写入后的 surface', String(byNumber.count));
  ok(!byNumber.messages.some((message) => String(message.text).includes(keyword)), '历史世代上下文不含它隐藏的上一代原文');
  ok(byNumber.messages.some((message) => message.role === 'developer' && message.text === ''), '历史上下文包含该世代写出的空替代消息');
  ok(byNumber.letter.length === 2
    && byNumber.letter[0].index === preIndex && byNumber.letter[0].text === 'S: 第 0 代之前的话'
    && byNumber.letter[1].index === zeroIndex && byNumber.letter[1].text === 'L0: 第 0 代的话',
    'letter 只含第 0 代生命周期内的输入且带消息序号', JSON.stringify(byNumber.letter));
  ok(byNumber.messages.every((message) => Number.isSafeInteger(message.time)), 'messages 每项带底层日志时间');
  ok(byNumber.letter.every((entry) => Number.isSafeInteger(entry.time)), 'letter 每项带底层日志时间');

  // 第三代：第 1 代生命周期内的 letter 归入 gen1（独立 step）。
  openStep(s, 99, 4);
  const oneLetter = plasticizeCall(s, { turn: 99, step: 4 }, 'letter-one', { text: 'L1: 第 1 代的话' }, { name: 'letter', resultText: '' });
  const oneIndex = s.surface.nodes.indexOf(oneLetter.declSeq);
  openStep(s, 99, 5);
  plasticizeCall(s, { turn: 99, step: 5 }, 'hide-3', { ops: [{ spans: ['this'], new_text: '⟨第三代⟩' }], option: 'execute' });
  const r3 = flush(s, { openStep: { turn: 99, step: 5 } }, quiet);
  ok(r3.applied === 1, '第三个逻辑世代写入成功', JSON.stringify(r3));
  const gen1 = JSON.parse(retrospect(s, { generation: 1 }));
  ok(gen1.letter.length === 1 && gen1.letter[0].index === oneIndex && gen1.letter[0].text === 'L1: 第 1 代的话', 'letter 按逻辑世代归属，不跨代累积', JSON.stringify(gen1.letter));

  let againError = null;
  try { retrospect(s, { generation: 'self - 0' }); } catch (error) { againError = error.message; }
  ok(typeof againError === 'string', 'self - 0（当前世代）被拒绝');
  let futureError = null;
  try { retrospect(s, { generation: 3 }); } catch (error) { futureError = error.message; }
  ok(typeof futureError === 'string', '当前/未来世代号被拒绝');
}

console.log(NL + '⑥.9 plasticize types：区间内按类型匹配，cookie 不参与');
{
  const buildRoleSession = () => {
    const s = mk();
    openStep(s, 99, 1);
    const baseId = Math.max(...cookieNodes(s).map((cookie) => cookie.id)) + 1;
    const cookieSeqs = [];
    cookieSeqs.push(s.append('user/message', cookieEvent(baseId).data, { surfaceOp: 'append' }).seq);
    s.append('user/message', { id: 'role-u', role: 'user', content: [{ type: 'text', text: 'ROLE-USER' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    s.append('developer/message', { message: { id: 'role-d', role: 'developer', content: [{ type: 'text', text: 'ROLE-DEV' }], source: { kind: 'runtime-context' } } }, { surfaceOp: 'append' });
    plasticizeCall(s, { turn: 99, step: 2 }, 'role-bash', {}, { name: 'bash', resultText: 'ROLE-BASH' });
    plasticizeCall(s, { turn: 99, step: 3 }, 'role-err', {}, { name: 'bash', resultText: 'ROLE-ERR', isError: true });
    plasticizeCall(s, { turn: 99, step: 4 }, 'role-letter', { text: 'ROLE-LETTER' }, { name: 'letter', resultText: 'ROLE-LETTER' });
    cookieSeqs.push(s.append('user/message', cookieEvent(baseId + 1).data, { surfaceOp: 'append' }).seq);
    return { s, span: '[' + baseId + ',' + (baseId + 1) + ']', cookieSeqs };
  };
  const run = (types, marker) => {
    const { s, span } = buildRoleSession();
    plasticizeCall(s, { turn: 99, step: 9 }, 'role-exec', { ops: [{ spans: [span], new_text: marker, types }], option: 'execute' });
    const r = flush(s, { openStep: { turn: 99, step: 9 } }, quiet);
    ok(r.applied === 1, 'types ' + JSON.stringify(types) + ' 写入成功', JSON.stringify(r));
    return s;
  };

  const assistants = run(['assistant'], '⟨ROLE-A⟩');
  ok(!textOf(assistants).includes('ROLE-BASH') && !textOf(assistants).includes('ROLE-ERR'), 'assistant 角色隐藏了对应单元', textOf(assistants).slice(0, 80));
  ok(textOf(assistants).includes('ROLE-USER') && textOf(assistants).includes('ROLE-DEV'), '非匹配角色保留');
  ok(textOf(assistants).includes('⟨ROLE-A⟩'), '最后一个匹配单元得到 new_text');

  const users = run(['user'], '⟨ROLE-U⟩');
  ok(!textOf(users).includes('ROLE-USER'), 'user 角色只隐藏用户消息');
  ok(textOf(users).includes('ROLE-DEV') && textOf(users).includes('ROLE-BASH'), '其他角色保留');
  ok(textOf(users).includes('ROLE-LETTER'), 'letter 调用单元未被 user 角色连带');

  const errors = run(['error'], '⟨ROLE-E⟩');
  ok(!textOf(errors).includes('ROLE-ERR'), 'error 角色隐藏报错单元');
  ok(textOf(errors).includes('ROLE-BASH') && textOf(errors).includes('ROLE-LETTER'), '其他工具单元保留');

  const letters = run(['letter'], '⟨ROLE-L⟩');
  ok(!textOf(letters).includes('ROLE-LETTER'), 'letter 角色隐藏 letter 单元');
  ok(textOf(letters).includes('ROLE-USER') && textOf(letters).includes('ROLE-DEV'), '其他角色保留');

  const cookieCheck = buildRoleSession();
  plasticizeCall(cookieCheck.s, { turn: 99, step: 9 }, 'role-cookie', { ops: [{ spans: [cookieCheck.span], new_text: '⟨ROLE-C⟩', types: ['user'] }], option: 'execute' });
  flush(cookieCheck.s, { openStep: { turn: 99, step: 9 } }, quiet);
  ok(cookieCheck.cookieSeqs.every((seq) => cookieCheck.s.surface.nodes.includes(seq)), 'cookie 消息本身永远不被 types 匹配');
}

console.log(NL + '⑥.10 逻辑世代标记：同号物理世代成组，第一个是边界');
{
  const s = mk();
  openStep(s, 99, 1);
  plasticizeCall(s, { turn: 99, step: 1 }, 'lg-1', {
    ops: [
      { spans: ['(3,4)'], new_text: '⟨LG-A⟩' },
      { spans: ['(5,6)'], new_text: '⟨LG-B⟩' },
    ],
    option: 'execute',
  });
  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 1 && s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace').length === 2, '一次 execute 写出两个物理世代', JSON.stringify(r));
  let state = initState();
  for (const event of s.snapshotEvents()) state = applyEvent(state, event);
  const pages = viewOf(state).logicalPages;
  ok(JSON.stringify(pages) === JSON.stringify([{ logical: 0, physical: 1 }]), '逻辑页码：逻辑 0 指向第一个物理页', JSON.stringify(pages));
  ok(countLogicalGenerations(s) === 1, '逻辑世代数为 1', String(countLogicalGenerations(s)));
  const freezeEvents = s.snapshotEvents().filter((e) => e.type === 'plugin:plastic-memories/logical' && e.data?.kind === 'execute');
  ok(freezeEvents.length === 1 && freezeEvents[0].data.logical === 0 && freezeEvents[0].data.physical === 1, 'execute 冻结写入私有 logical 事件（logical=0, physical=1）', JSON.stringify(freezeEvents.map((e) => e.data)));

  openStep(s, 99, 2);
  plasticizeCall(s, { turn: 99, step: 2 }, 'lg-2', { ops: [{ spans: ['this'], new_text: '⟨LG-C⟩' }], option: 'execute' });
  const r2 = flush(s, { openStep: { turn: 99, step: 2 } }, quiet);
  ok(r2.applied === 1, '第二个逻辑世代写入', JSON.stringify(r2));
  state = initState();
  for (const event of s.snapshotEvents()) state = applyEvent(state, event);
  const pages2 = viewOf(state).logicalPages;
  ok(JSON.stringify(pages2) === JSON.stringify([{ logical: 0, physical: 1 }, { logical: 1, physical: 3 }]), '逻辑页码：中间物理世代不生成新逻辑页', JSON.stringify(pages2));
  ok(countLogicalGenerations(s) === 2, '逻辑世代数递增到 2', String(countLogicalGenerations(s)));
}

console.log(NL + '⑥.11 一个提交边界只允许一条 execute');
{
  const s = mk();
  openStep(s, 99, 1);
  plasticizeCall(s, { turn: 99, step: 1 }, 'one-1', { ops: [{ spans: ['(3,4)'], new_text: '⟨ONE-A⟩' }], option: 'execute' });
  plasticizeCall(s, { turn: 99, step: 1 }, 'one-2', { ops: [{ spans: ['(5,6)'], new_text: '⟨ONE-B⟩' }], option: 'execute' });
  let guard = null;
  try { assertSinglePendingExecute(s, 'one-2'); } catch (error) { guard = error.message; }
  ok(typeof guard === 'string' && guard.includes('only one execute'), '第二条 execute 在工具边界被拒绝', String(guard).slice(0, 60));
  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 0 && r.skipped === 2 && s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace').length === 0, 'flush 侧同样拒绝，不写任何投影', JSON.stringify(r));
}

console.log(NL + '⑥.5 安全区：lock 后 plasticize 不能命中锁定区间');
{
  const s = mk();
  openStep(s, 99, 1);
  const staged = stageUserOperation(s, { kind: 'lock', mode: 'range', interval: '(3,4)', comment: '/plasticize lock (3,4)' });
  ok(staged.shadowed.length > 0, '登记 lock 区间', String(staged.shadowed.length));
  await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  const lockRecords = s.snapshotEvents().filter((event) => event.type === 'plugin:plastic-memories/locks');
  ok(lockRecords.some((event) => String(event.data?.comment ?? '').includes('/plasticize lock')), '私有记录保存当时的命令原文');
  plasticizeCall(s, { turn: 99, step: 1 }, 'lock-exec', { ops: [{ spans: ['(3,4)'], new_text: '⟨不应命中⟩' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 0 && r.skipped === 1, '命中安全区的 execute 被拒绝', JSON.stringify(r));
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 0, '没有写出任何投影', String(reps.length));
  stageUserOperation(s, { kind: 'unlock', mode: 'range', interval: '(3,4)' });
  await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  const unlocked = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(unlocked.applied === 1, 'unlock 后同一区间可以执行', JSON.stringify(unlocked));
}

console.log(NL + '⑥.6 安全区持久化：plugin record 重放后仍生效');
{
  const s = mk();
  openStep(s, 99, 1);
  stageUserOperation(s, { kind: 'lock', mode: 'range', interval: '(3,4)' });
  await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  const snapshots = s.snapshotEvents().map((event) => snapshotSessionEvent(event));
  const ctx2 = makeStore();
  const s2 = ctx2.sessions.create('persist-reload', { seed: snapshots });
  openStep(s2, 99, 1);
  plasticizeCall(s2, { turn: 99, step: 1 }, 'reload-exec', { ops: [{ spans: ['(3,4)'], new_text: '⟨reload 不应命中⟩' }], option: 'execute' });
  const r = flush(s2, { openStep: { turn: 99, step: 1 } }, quiet);
  ok(r.applied === 0 && r.skipped === 1, '重放后锁定仍然生效', JSON.stringify(r));
}

console.log(NL + '⑥.7 /plasticize 待落盘操作（可交换；发送消息时约化写入）');
{
  const s = mk();
  openStep(s, 99, 1);
  const staged = stageUserOperation(s, { kind: 'project', mode: 'range', interval: '(3,4)', newText: '⟨内存投影⟩' });
  ok(staged.pending === 1, '登记投影', String(staged.pending));
  let overlap;
  try { stageUserOperation(s, { kind: 'project', mode: 'range', interval: '(3,4)', newText: 'x' }); } catch (error) { overlap = String(error.message); }
  ok(typeof overlap === 'string' && overlap.includes('重叠'), '区间重叠被拒绝', overlap?.slice(0, 40));
  const written = await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  ok(written.projections === 1, '发送消息时写入投影', JSON.stringify(written));
  ok(textOf(s).includes('⟨内存投影⟩'), '替代文本进入工作面');
  ok(countLogicalGenerations(s) === 1, '用户投影产生一个逻辑世代', String(countLogicalGenerations(s)));
  const s2 = mk();
  openStep(s2, 99, 1);
  stageUserOperation(s2, { kind: 'project', mode: 'range', interval: '(3,4)', newText: '⟨将被清空⟩' });
  ok(clearStagedOperations(s2) === 1, '清空待落盘操作');
}
console.log(NL + '⑥.8 all / prelock / lock_this 与区间描述');
{
  const s = mk();
  openStep(s, 99, 1);
  stageUserOperation(s, { kind: 'lock', mode: 'all' });
  const allResult = await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  ok(allResult.safety === 1 && lockedSeqs(s).size === s.surface.nodes.length, 'lock all 锁定当前全部轨迹', String(lockedSeqs(s).size));
  ok(safetyZoneIntervals(s).includes('cookie'), '安全区用区间（cookie）描述', safetyZoneIntervals(s).slice(0, 80));
}
{
  const s = mk();
  openStep(s, 99, 1);
  stageUserOperation(s, { kind: 'lock', mode: 'prelock' });
  const userMessage = s.append('user/message', { id: 'prelock-u', role: 'user', content: [{ type: 'text', text: '这条进入安全区' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  await flushUserOperations(s, { turn: 99, step: 1 }, quiet);
  ok(lockedSeqs(s).has(userMessage.seq), 'prelock 锁定触发落盘的用户消息', String(userMessage.seq));
}
{
  const s = mk();
  openStep(s, 99, 1);
  plasticizeCall(s, { turn: 99, step: 1 }, 'lock-this-exec', { ops: [{ spans: ['(3,4)'], new_text: '⟨锁住的替代⟩', lock_this: true }], option: 'execute' });
  flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = s.snapshotEvents().find((event) => event.surfaceOp?.op === 'replace' && event.data?.message?.source?.op === 'stabilize');
  ok(replacement !== undefined && lockedSeqs(s).has(replacement.seq), 'lock_this 把替代文本自身纳入安全区', String(replacement?.seq));
  ok(safetyZoneIntervals(s).includes('孤立消息'), '孤立锁定点用文本锚描述', safetyZoneIntervals(s).slice(0, 80));
}

console.log(NL + '⑧ 旧 pm_* 会话仍可读（向后兼容）');
{
  const ctx = new Context(); new SessionStore(ctx);
  const s = ctx.sessions.create('legacy', { seed: fixture('session-ptc-stabilized.jsonl').filter((r) => r.type !== 'session') });
  const snap = snapshotSurface(s);
  ok(snap.entries.length > 0, '旧会话能加载（工作面 ' + snap.entries.length + ' 条）');
  const pm = pairingMaps(s);
  ok(pm.malformed === 0, '旧会话的形态自检通过');
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 2, '旧会话里的 2 条历史投影仍在', String(reps.length));
}

console.log(NL + '⑨ checkBalanced 在真实日志上的判定');
{
  const s = mk();
  const snap = snapshotSurface(s);
  const pm = pairingMaps(s);
  const unbalanced = snap.entries.filter((e) => pm.before.get(e.seq) !== 0 || pm.after.get(e.seq) !== 0);
  ok(unbalanced.length > 0, '真实日志里有不平衡位置（' + unbalanced.length + ' 个）');
  // 起点不平衡的判据是 before > 0（after 不为 0 只说明它是本步的调用消息，
  // 只要它的结果都在区间内，整个区间仍然平衡）。
  const first = snap.entries.find((e) => pm.before.get(e.seq) > 0);
  ok(first !== undefined, '找到一条 before > 0 的节点（真正的坏起点）');
  const verdict = checkBalanced(s, first.index, snap.entries.length - 1);
  ok(verdict.ok === false, '以它为起点的区间被判不平衡', JSON.stringify(verdict).slice(0, 60));
}

done();