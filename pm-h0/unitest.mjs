/**
 * PM · 单元序号与 unit 模式测试。
 */
import { makeStore, makeCounter, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush, lockedSeqs, appendSafetyRecord } from './engine.js';
import { currentUnits, renderUnitPreview } from './units.js';
import { retrospectUnits } from './unitretro.js';
import { replayCompactedSafety } from './safetyreplay.js';
import { initState, applyEvent, viewOf } from './generations.js';

const { ok, done } = makeCounter('unitest');
const quiet = { warn: () => {}, info: () => {} };
const ctx = makeStore();
const s = ctx.sessions.create('unitest', { seed: cookieSeed('subagent-95230f54.jsonl') });

const units = currentUnits(s);
ok(units.length > 0 && units[0].n === 0, '0 起编号', String(units.length));
ok(units[0].type === 'system' && units[0].text.length > 0, '0 号是系统提示词');
const toolUnit = units.find((unit) => unit.calls.length > 0 && unit.results.length > 0);
ok(toolUnit !== undefined, '存在 assistant+tool result 单元');
ok(toolUnit !== undefined && toolUnit.seqs.length >= 2 && toolUnit.results.length >= 1, '工具结果并入同一单元');
ok(toolUnit !== undefined && !units.some((unit) => unit.seqs.includes(toolUnit.results[0].seq) && unit.n !== toolUnit.n), '工具结果没有独立单元');

const data = JSON.parse(retrospectUnits(s, { preview: true }));
ok(data.preview === true && Array.isArray(data.units) && data.units.length === units.length, 'retrospect 默认 preview 返回单元数组');
ok(data.units[1].n === 1 && data.units[1].safety === false, '单元带 n/safety');

const before = currentUnits(s);
openStep(s, 99, 1);
plasticizeCall(s, { turn: 99, step: 1 }, 'pos-unit', { ops: [{ positions: [1], new_text: '⟨UNIT⟩' }], option: 'execute' });
const result = flush(s, { openStep: { turn: 99, step: 1 } }, quiet);
ok(result.applied === 1, 'positions execute 落地', JSON.stringify(result));
const after = currentUnits(s);
ok(after[1].text.includes('⟨UNIT⟩') && !after[1].text.includes('cookie][1]'), '位置 1 被替换');
ok(after[0].n === 0 && after[0].type === 'system', '系统提示词仍在 0');

// this 自噬：把生成 execute 的单元替换成 new_text
const sctx = makeStore();
const ss = sctx.sessions.create('unitest-self', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(ss, 98, 1);
plasticizeCall(ss, { turn: 98, step: 1 }, 'self-unit', { ops: [{ positions: ['this'], new_text: '⟨SELF⟩' }], option: 'execute' });
const selfResult = flush(ss, { openStep: { turn: 98, step: 1 } }, quiet);
const selfUnits = currentUnits(ss);
ok(selfResult.applied === 1 && selfUnits.some((unit) => unit.text.includes('⟨SELF⟩')), 'this 自噬替换 execute 单元');
ok(!selfUnits.some((unit) => unit.text.includes('self-unit')), '自噬后旧 execute 单元不在当前世代');

// 安全区自动补充单元不可锁
const actx = makeStore();
const as = actx.sessions.create('unitest-auto', { seed: cookieSeed('subagent-95230f54.jsonl') });
const autoUnit = currentUnits(as).find((unit) => unit.autoRefresh);
let autoError = null;
try {
  appendSafetyRecord(as, { op: 'lock', seqs: [autoUnit.seq], comment: 'test' });
} catch (error) { autoError = String(error.message); }
ok(autoUnit !== undefined, '存在自动补充单元');

const pctx = makeStore();
const ps = pctx.sessions.create('unitest-safety', { seed: cookieSeed('subagent-95230f54.jsonl') });
const locks = lockedSeqs(ps);
const target = currentUnits(ps, { locks })[1];
appendSafetyRecord(ps, { op: 'lock', seqs: [target.seq], comment: 'test' });
const safetyData = JSON.parse(retrospectUnits(ps, { preview: true }));
ok(safetyData.units[1].safety === true && safetyData.units[1].locked === true, 'retrospect 标出安全区单元');

// 自动隐藏：retrospect 单元被下一次 execute 清掉
const ahctx = makeStore();
const ahs = ahctx.sessions.create('unitest-autohide', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(ahs, 97, 1);
plasticizeCall(ahs, { turn: 97, step: 1 }, 'retro-ah', { generation: 'self', units: true }, { name: 'retrospect', resultText: '{"units":[]}' });
ahs.append('step/end', { turn: 97, step: 1 });
ahs.append('step/start', { turn: 97, step: 2 });
plasticizeCall(ahs, { turn: 97, step: 2 }, 'exec-ah', { ops: [{ positions: [1], new_text: 'X' }], option: 'execute' });
const ah = flush(ahs, { openStep: { turn: 97, step: 2 } }, quiet);
ok(ah.auto >= 1 && !currentUnits(ahs).some((unit) => unit.calls.some((call) => call.name === 'retrospect')), 'retrospect 单元被自动隐藏');

// 逻辑世代边界：execute 后 self=1
const lbctx = makeStore();
const lbs = lbctx.sessions.create('unitest-boundary', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(lbs, 96, 1);
plasticizeCall(lbs, { turn: 96, step: 1 }, 'exec-b', { ops: [{ positions: [1], new_text: 'B' }], option: 'execute' });
flush(lbs, { openStep: { turn: 96, step: 1 } }, quiet);
const bdata = JSON.parse(retrospectUnits(lbs, { preview: true }));
ok(bdata.logical === 1, 'execute 后 self=1', String(bdata.logical));

// 压缩后安全区重放（追加到尾部；surfaceOp 无 insert）
const srctx = makeStore();
const srs = srctx.sessions.create('unitest-replay', { seed: cookieSeed('subagent-95230f54.jsonl') });
const nodes = [...srs.surface.nodes];
appendSafetyRecord(srs, { op: 'lock', seqs: [nodes[1]], comment: 'test' });
const cid = 'unitest-compaction';
srs.append('compaction/start', { compactionId: cid, turn: 1 });
srs.append('compaction/summary', { compactionId: cid, summary: [{ type: 'text', text: 'S' }], shadowedRange: { start: nodes[1], end: nodes[2] }, shadowedSeqs: [nodes[1], nodes[2]], shadowedTokenCount: 1 });
srs.append('user/message', { content: [{ type: 'text', text: 'SUMMARY' }], source: { kind: 'compact-checkpoint', compactionId: cid } }, { surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes[2] }, sourceEventSeqs: [nodes[1], nodes[2]] });
srs.append('compaction/end', { compactionId: cid, turn: 1 });
const replayed = replayCompactedSafety(srs, { turn: 1, step: 1 });
ok(replayed === 1 && currentUnits(srs).some((unit) => unit.text.includes('condensed summary appears earlier')), '压缩后安全区重放注入');

// 压缩边界在后续 append 后仍保留（state.boundaries 不能被 surface 更新吞掉）
let vst = initState();
for (const event of srs.snapshotEvents()) vst = applyEvent(vst, event);
const vv = viewOf(vst);
ok(vv.logicalPages.length >= 2 && vv.logicalPages.some((page) => page.kind === 'compaction'), '压缩边界跨后续消息保留', JSON.stringify(vv.logicalPages));

done();