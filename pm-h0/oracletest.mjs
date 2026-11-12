/**
 * PM · 差分测试：独立规格 oracle vs 真实管线。
 *
 * 每个用例：随机构造若干互不重叠的操作，交给 plasticize(execute) + flush，
 * 然后比较
 *   1. 结果消息是否等于 oracle.expectedMessages 的预测；
 *   2. 会话事件是否通过 verify.js 的独立审计；
 *   3. 每个 replace 事件的 sourceEventSeqs 是否连续且落在执行前的工作面上。
 */
import { makeCounter, makeStore, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';
import { expectedMessages, shapeOf, unitRangesOf } from './oracle.mjs';
import { verifyPmSemantics } from './verify.js';

const { ok, done } = makeCounter('oracletest');
const quiet = { warn() {}, info() {} };

/** 确定性 PRNG（mulberry32），保证失败可复现。 */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = 40;
let passed = 0;
const failures = [];

for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
  const random = rng(1000 + caseIndex);
  const ctx = makeStore();
  const session = ctx.sessions.create('oracle-' + String(caseIndex), { seed: cookieSeed('subagent-95230f54.jsonl') });
  openStep(session, 2, 1);
  plasticizeCall(session, { turn: 2, step: 1 }, 'oc' + String(caseIndex), { ops: [{ positions: 'unit 1' }], option: 'set' });

  // 执行前表面（此时 set 的调用已经在工作面上，会和 execute 同批解析）
  const pre = session.deriveMessages();
  const unitCount = unitRangesOf(pre).length;
  // unit 0 是系统提示，只能查看；生成器从 unit 1 起。
  const targetable = Math.max(1, unitCount - 1);

  // 随机挑 1..3 段互不重叠的单元区间
  const ranges = [];
  const attempts = 1 + Math.floor(random() * 3);
  for (let attempt = 0; attempt < attempts * 6 && ranges.length < attempts; attempt += 1) {
    const a = 1 + Math.floor(random() * Math.max(1, targetable - 1));
    const b = Math.min(targetable - 1, a + Math.floor(random() * 3));
    if (a < 1) continue;
    if (ranges.some(([lo, hi]) => !(b < lo || a > hi))) continue;
    ranges.push([a, b]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges.length === 0) ranges.push([0, 0]);

  const ops = ranges.map(([a, b]) => {
    const text = random() < 0.4 ? '' : '⟨替换' + String(caseIndex) + '-' + String(a) + '⟩';
    return { positions: a === b ? 'unit ' + String(a) : 'unit ' + String(a) + ' to ' + String(b), new_text: text };
  });

  plasticizeCall(session, { turn: 2, step: 1 }, 'oe' + String(caseIndex), { ops, option: 'execute' });
  const preNodes = [...session.surface.nodes];
  const result = flush(session, { openStep: { turn: 2, step: 1 } }, quiet);

  const got = shapeOf(session.deriveMessages());
  const want = shapeOf(expectedMessages(pre, ops));
  const same = JSON.stringify(got) === JSON.stringify(want);
  const auditErrors = verifyPmSemantics(session.snapshotEvents());
  const replaces = session.snapshotEvents().filter((event) => event.surfaceOp?.op === 'replace');
  // 显式投影（source.note 为空）必须与操作一一对应；自动隐藏是额外事件。
  const explicit = replaces.filter((event) => event.data?.message?.source?.note === undefined);
  // 不变量：每个 replace 的 sourceEventSeqs 必须是执行前工作面上连续的一段，
  // 各段互不重叠且按位置递增，显式事件数量与操作数一致。
  let invariantOk = explicit.length === ops.length;
  let lastIndex = -1;
  for (const event of replaces) {
    const refs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
    if (refs.length === 0) { invariantOk = false; break; }
    const start = preNodes.indexOf(refs[0]);
    if (start < 0 || start <= lastIndex) { invariantOk = false; break; }
    for (let offset = 0; offset < refs.length; offset += 1) {
      if (preNodes[start + offset] !== refs[offset]) { invariantOk = false; break; }
    }
    if (!invariantOk) break;
    lastIndex = start + refs.length - 1;
  }

  if (same && auditErrors.length === 0 && result.applied === 1 && invariantOk) passed += 1;
  else failures.push({ case: caseIndex, ops, same, invariantOk, auditErrors: auditErrors.slice(0, 2), applied: result.applied, got: same ? undefined : { got: got.slice(0, 6), want: want.slice(0, 6) } });
}

ok(passed === CASES, 'oracle 差分：' + String(passed) + '/' + String(CASES) + ' 通过', JSON.stringify(failures.slice(0, 2)).slice(0, 600));
done();
