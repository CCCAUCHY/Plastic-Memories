/**
 * PM · 区间配对平衡回归（一次真实事故换来的）。
 *
 * 事故形态：投影区间的一端切在**工具对中间** ——
 * assistant/message（带 tool-call）留在工作面上，它的 tool/result 被吞掉。
 * 后果是 pairingMaps 的开集**永不闭合**：
 *   - 之后每一次 plasticize 都被拒绝；
 *   - 插件彻底卡死（在 session-d7e22544 那份日志里实测到 8 个位置开集不为 0）。
 *
 * 三道防线各测一遍：
 *   1. 工具调用期：resolveOps 里把端点滑到开集归零处（切不进块）；
 *   2. 工具调用期：checkBalanced 兜底；
 *   3. 提交边界期：engine 的 flush 写入前再验一次。
 *
 * 运行：node balanced.mjs
 */
import { makeCounter, makeStore, seeded, cookieSeed, cookieNodes, openStep, plasticizeCall, balancedIndexes } from './testkit.mjs';
import { pairingMaps, snapshotSurface, checkBalanced, surfaceNodes } from './coords.js';
import { flush } from './engine.js';
import { resolveOps } from './plasticize.js';
import { cookieText } from './cookie.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('balanced');
const FX = 'subagent-95230f54.jsonl';
const quiet = { warn: () => {}, info: () => {} };

console.log(NL + '⓪ 基座形态');
{
  const ctx = makeStore();
  const s = seeded(ctx, 'ba', FX);
  const snap = snapshotSurface(s);
  const pm = pairingMaps(s);
  ok(pm.malformed === 0, '没有形态无法识别的块', String(pm.malformed));
  const leak = snap.entries.filter((e) => pm.after.get(e.seq) !== 0);
  const firstLeak = leak.length > 0 ? leak[0].index : snap.entries.length;
  ok(firstLeak > 0 || leak.length === 0, '开集只在预期位置非 0', '首个非闭合 #' + firstLeak);
  const closed = balancedIndexes(s, pairingMaps);
  ok(closed.length > 0, '存在平衡切口', JSON.stringify(closed));
}

console.log(NL + '① 平衡切口 = step 边界');
{
  const ctx = makeStore();
  const s = seeded(ctx, 'bb', FX);
  const snap = snapshotSurface(s);
  const pm = pairingMaps(s);
  const balanced = balancedIndexes(s, pairingMaps);
  const withCall = snap.entries.find((e) => e.event.type === 'assistant/message'
    && e.message.content.some((b) => b.type === 'tool-call'));
  ok(withCall !== undefined, '找到一条带 tool-call 的 assistant 消息');
  if (withCall !== undefined) {
    const callCount = withCall.message.content.filter((b) => b.type === 'tool-call').length;
    ok(pm.after.get(withCall.seq) === callCount, '它之后开集 = 其 tool-call 数（' + callCount + '）', String(pm.after.get(withCall.seq)));
    ok(!balanced.includes(withCall.index), '因此它不是平衡切口');
  }
}

console.log(NL + '② 切在工具对中间的区间：checkBalanced 必须判否');
{
  const ctx = makeStore();
  const s = seeded(ctx, 'bc', FX);
  const snap = snapshotSurface(s);
  const pm = pairingMaps(s);
  const result = snap.entries.find((e) => e.event.type === 'tool/result' && pm.before.get(e.seq) > 0);
  ok(result !== undefined, '找到一条「起点切在工具对中间」的 tool/result');
  if (result !== undefined) {
    const verdict = checkBalanced(s, result.index, snap.entries.length - 1);
    ok(verdict.ok === false, '被判为不平衡', JSON.stringify(verdict).slice(0, 80));
    ok(typeof verdict.reason === 'string' && verdict.reason.includes('split'), '给出可读原因', String(verdict.reason).slice(0, 60));
  }
}

console.log(NL + '③ 切在工具块中间的区间：**自动扩到整块边界**，而不是被拒');
{
  // 生产里 cookie 只落在边界上，正常路径切不进工具块。
  // 这里故意造一个「cookie 夹在 assistant 与它的 tool/result 之间」的 seed，检验防线。
  const raw = cookieSeed(FX);
  const resultAt = raw.findIndex((e) => e.type === 'tool/result');
  const at = raw.slice(0, resultAt).map((e) => e.type).lastIndexOf('assistant/message');
  ok(at !== -1, 'seed 里找到「assistant … tool/result」的位置', String(at));
  const spliced = [];
  for (let i = 0; i < raw.length; i++) {
    spliced.push({ ...raw[i], seq: spliced.length });
    if (i === at) {
      spliced.push({
        type: 'user/message', seq: spliced.length, time: raw[i].time,
        data: {
          id: 'ck-inner', role: 'user',
          content: [{ type: 'text', text: cookieText(99) }],
          source: { kind: 'pm-cookie', v: 1, id: 99 },
        },
        surfaceOp: 'append',
      });
    }
  }
  const ctx = makeStore();
  const s = ctx.sessions.create('bd', { seed: spliced });
  openStep(s, 2, 1);
  const nodes = surfaceNodes(s);
  const ci = nodes.findIndex((q) => s.eventAt(q)?.data?.source?.id === 99);
  ok(ci !== -1, 'cookie 99 夹在工具块中间', String(ci));
  const next = cookieNodes(s).find((c) => c.index > ci);
  ok(next !== undefined, '它后面还有 cookie 边界', String(next?.id));
  const pmBefore = pairingMaps(s);
  const resolved = resolveOps(s, [{ spans: ['(' + 99 + ',' + next.id + ')'] }], { thisSeq: nodes[nodes.length - 1], thisEndSeq: nodes[nodes.length - 1] });
  const refs = resolved[0].shadowed;
  ok(pmBefore.before.get(refs[0]) === 0 && pmBefore.after.get(refs[refs.length - 1]) === 0,
    '扩展后的区间落在块边界（配对完整）', refs.length + ' 条');
  ok(refs[0] === nodes[ci - 1] && refs[refs.length - 1] === nodes[ci + 1], '端点滑到了调用消息与结果之后');

  plasticizeCall(s, { turn: 2, step: 1 }, 'b3', { ops: [{ spans: ['(' + 99 + ',' + next.id + ')'], new_text: 'X' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(r.applied === 1, '块内区间被接受并落地', JSON.stringify(r));
  const reps = s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
  ok(reps.length === 1, '写下 1 条 replace', String(reps.length));
}

console.log(NL + '④ 穷举：任意两个 cookie 之间的区间，扩展后都必须合法');
{
  const ctx = makeStore();
  const s = ctx.sessions.create('be', { seed: cookieSeed(FX) });
  openStep(s, 2, 1);
  const nodes = surfaceNodes(s);
  const pm = pairingMaps(s);
  const ids = cookieNodes(s).map((c) => c.id);
  const here = { thisSeq: nodes[nodes.length - 1], thisEndSeq: nodes[nodes.length - 1] };
  let okCount = 0;
  const leaked = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      for (const form of ['(' + a + ',' + b + ')', '[' + a + ',' + b + ']']) {
        let refs;
        try { refs = resolveOps(s, [{ spans: [form] }], here)[0].shadowed; } catch { continue; }
        const before = pm.before.get(refs[0]);
        const after = pm.after.get(refs[refs.length - 1]);
        if (before === 0 && after === 0) okCount++;
        else leaked.push(form + '(' + refs.length + ':b' + before + '/a' + after + ')');
      }
    }
  }
  ok(okCount > 0, '有 ' + okCount + ' 个区间能解析', String(okCount));
  ok(leaked.length === 0, '**没有一个**扩展后仍然非法', leaked.slice(0, 5).join(', '));
}

console.log(NL + '⑤ 反面对照：平衡区间必须放行');
{
  const ctx = makeStore();
  const s = seeded(ctx, 'bf', FX);
  openStep(s, 2, 1);
  const balanced = balancedIndexes(s, pairingMaps);
  const startIdx = balanced[1] ?? balanced[0];
  const endIdx = balanced[balanced.length - 1];
  const verdict = checkBalanced(s, startIdx, endIdx);
  ok(verdict.ok === true, '平衡区间放行（#' + startIdx + '..#' + endIdx + '）', JSON.stringify(verdict).slice(0, 80));
}

done();