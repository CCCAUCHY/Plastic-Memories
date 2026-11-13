/**
 * PM · 执行规格回归（execute → surfaceOp）。
 *
 * 左侧是 pmspec.mjs 的纯语义规格，右侧是真实 plasticize(execute) + flush 写出的事件。
 * 两边都不经过 DSH 的消息推导：只比「写了哪几段、替换成什么」。
 */
import { makeCounter, makeStore, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush, lockedSeqs, appendSafetyRecord } from './engine.js';
import { specExecute, diffEvents, unitsOf } from './pmspec.mjs';
import { verifyPmSemantics } from './verify.js';

const { ok, done } = makeCounter('spectest');
const quiet = { warn() {}, info() {} };
const NL = String.fromCharCode(10);

function fresh(name) {
  const ctx = makeStore();
  const session = ctx.sessions.create(name, { seed: cookieSeed('subagent-95230f54.jsonl') });
  openStep(session, 2, 1);
  return session;
}

function nodesOf(session) {
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event.type]));
  return session.surface.nodes.map((seq) => ({ seq, type: bySeq.get(seq) }));
}

function runCase(name, ops, options = {}) {
  const session = fresh(name);
  const callId = name + '-call';
  const args = { ops, option: 'execute' };
  let thrown = null;
  try {
    plasticizeCall(session, { turn: 2, step: 1 }, callId, args);
    const callSeq = session.snapshotEvents()
      .find((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.id === callId)).seq;
    const nodes = nodesOf(session);
    const spec = specExecute(nodes, ops, { locks: options.locks ?? new Set(), thisSeq: callSeq });
    const flushed = flush(session, { openStep: { turn: 2, step: 1 } }, quiet);
    const actual = session.snapshotEvents().filter((event) => event.surfaceOp?.op === 'replace');
    const diffs = diffEvents(spec, actual);
    const audit = verifyPmSemantics(session.snapshotEvents());
    return { spec, actual, diffs, audit, thrown, flushed, session };
  } catch (error) {
    thrown = error;
    const nodes = nodesOf(session);
    const spec = specExecute(nodes, ops, { locks: options.locks ?? new Set() });
    return { spec, actual: [], diffs: [], audit: [], thrown, flushed: null, session };
  }
}

console.log(NL + '① 单段替换 / 区间 / 隐藏');
for (const [label, ops] of [
  ['单单元替换', [{ positions: 'unit 2', new_text: '⟨A⟩' }]],
  ['区间替换', [{ positions: 'unit 2 to 4', new_text: '⟨B⟩' }]],
  ['纯隐藏', [{ positions: 'unit 3' }]],
  ['两条不相交', [{ positions: 'unit 2', new_text: '⟨C⟩' }, { positions: 'unit 4 to 5' }]],
]) {
  const result = runCase('spec-' + label, ops);
  ok(result.thrown === null, label + ' 不报错', result.thrown === null ? '' : String(result.thrown.message).slice(0, 80));
  ok(result.diffs.length === 0, label + ' 与规格一致', JSON.stringify(result.diffs).slice(0, 240));
  ok(result.audit.length === 0, label + ' 通过审计', JSON.stringify(result.audit).slice(0, 160));
}

console.log(NL + '② this');
{
  const result = runCase('spec-this', [{ positions: 'this', new_text: '⟨T⟩' }]);
  ok(result.thrown === null, 'this 不报错', result.thrown === null ? '' : String(result.thrown.message).slice(0, 80));
  ok(result.diffs.length === 0, 'this 与规格一致', JSON.stringify(result.diffs).slice(0, 240));
}

console.log(NL + '③ 拒绝：系统提示 / 越界 / 安全区');
{
  const sys = runCase('spec-sys', [{ positions: 'unit 0', new_text: 'X' }]);
  ok(sys.spec.error?.code === 'system-prompt', '规格判定为 system-prompt', JSON.stringify(sys.spec.error));
  ok(sys.flushed !== null && sys.flushed.applied === 0 && sys.flushed.skipped === 1, '真实实现也拒绝（applied 0 / skipped 1）', JSON.stringify(sys.flushed));
  ok(!String(sys.thrown?.message ?? '').includes('安全区'), '系统提示报错不借用安全区措辞');

  const out = runCase('spec-oor', [{ positions: 'unit 999' }]);
  ok(out.spec.error?.code === 'out-of-range', '规格判定为 out-of-range', JSON.stringify(out.spec.error));
  ok(out.flushed !== null && out.flushed.applied === 0 && out.flushed.skipped === 1, '真实实现也拒绝（applied 0 / skipped 1）', JSON.stringify(out.flushed));
}

console.log(NL + '③b 安全区');
{
  const session = fresh('spec-lock');
  const target = nodesOf(session)[3];
  appendSafetyRecord(session, { op: 'lock', seqs: [target.seq], comment: 'test' });
  const locks = lockedSeqs(session);
  const units = unitsOf(nodesOf(session));
  const unitIndex = units.findIndex((unit) => nodesOf(session).slice(unit.from, unit.to + 1).some((node) => node.seq === target.seq));
  const ops = [{ positions: 'unit ' + String(unitIndex), new_text: 'X' }];
  plasticizeCall(session, { turn: 2, step: 1 }, 'spec-lock-call', { ops, option: 'execute' });
  const callSeq = session.snapshotEvents()
    .find((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.id === 'spec-lock-call')).seq;
  const spec = specExecute(nodesOf(session), ops, { locks, thisSeq: callSeq });
  const flushed = flush(session, { openStep: { turn: 2, step: 1 } }, quiet);
  const actual = session.snapshotEvents().filter((event) => event.surfaceOp?.op === 'replace');
  ok(spec.error?.code === 'safety-zone', '规格判定为 safety-zone', JSON.stringify(spec.error));
  ok(flushed.applied === 0 && actual.length === 0, '真实实现不写任何事件', JSON.stringify(flushed));
}

console.log(NL + '④ 随机差分（30 例）');
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
let pass = 0;
const fails = [];
for (let index = 0; index < 30; index += 1) {
  const random = rng(7000 + index);
  const session = fresh('spec-rand-' + String(index));
  const scratch = [];
  const total = unitsOf(nodesOf(session)).length;
  const picks = 1 + Math.floor(random() * 2);
  for (let attempt = 0; attempt < 12 && scratch.length < picks; attempt += 1) {
    const a = 1 + Math.floor(random() * Math.max(1, total - 2));
    const b = Math.min(total - 1, a + Math.floor(random() * 2));
    if (scratch.some(([lo, hi]) => !(b < lo || a > hi))) continue;
    scratch.push([a, b]);
  }
  scratch.sort((left, right) => left[0] - right[0]);
  const ops = scratch.map(([a, b], order) => ({
    positions: a === b ? 'unit ' + String(a) : 'unit ' + String(a) + ' to ' + String(b),
    new_text: random() < 0.5 ? '' : '⟨R' + String(index) + '-' + String(order) + '⟩',
  }));
  const result = runCase('spec-rand-' + String(index), ops);
  if (result.thrown === null && result.diffs.length === 0 && result.audit.length === 0) pass += 1;
  else fails.push({ index, ops, diffs: result.diffs.slice(0, 2), err: String(result.thrown?.message ?? '').slice(0, 60) });
}
ok(pass === 30, '随机 30 例与规格一致：' + String(pass) + '/30', JSON.stringify(fails.slice(0, 2)).slice(0, 400));

done();
