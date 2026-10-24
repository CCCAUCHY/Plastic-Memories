/**
 * PM · plasticize 核心语义（cookie / spans 版）。
 *
 * 覆盖：区间语法（仅端点 / 开闭区间 / 反序 / this）、纯空洞、一段多区间、
 * set 不写日志、execute 边界写入、世代递增、also_execute_last_set 的 this 零点、
 * 幂等、cookie 被遮蔽后编号不漂移。
 *
 * 运行：node selftest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, cookieSeed, cookieNodes, openStep, plasticizeCall, textOf } from './testkit.mjs';
import { flush } from './engine.js';
import { resolveOps } from './plasticize.js';
import { surfaceNodes } from './coords.js';
import { openSetProfile } from './grouping.js';
import { cookieText } from './cookie.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('selftest');
const quiet = { warn: () => {}, info: () => {} };

const ctx = new Context();
new SessionStore(ctx);
let n = 0;
const mk = () => {
  const s = ctx.sessions.create('st-' + (++n), { seed: cookieSeed('subagent-95230f54.jsonl') });
  openStep(s, 2, 1);
  return s;
};
const reps = (s) => s.snapshotEvents().filter((e) => e.surfaceOp?.op === 'replace');
const holes = (s) => reps(s).filter((e) => e.type === 'developer/message');
const run = (s, callId, args) => {
  plasticizeCall(s, { turn: 2, step: 1 }, callId, args);
  return flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
};
const hereOf = (s) => {
  const nodes = surfaceNodes(s);
  return { thisSeq: nodes[nodes.length - 1], thisEndSeq: nodes[nodes.length - 1] };
};

// 夹具布局（cookieSeed 在「单元边界」后各插一个 cookie）：
//   0 system / 1 ck1 / 2 user任务 / 3 ck2 / 4 user运行时 / 5 ck3 / 6 user技能 / 7 ck4
//   8 user时间 / 9 ck5 / 10 assistant+11 tool/result / 12 ck6 / 13+14 / 15 ck7
//   16+17 / 18 ck8 / 19+20 / 21 ck9 / 22 assistant(终) / 23 ck10

console.log(NL + '① 基本投影：开区间 (1,10) 遮蔽掉 system 之外的全部历史');
{
  const s = mk();
  const before = s.surface.nodes.length;
  const r = run(s, 'c1', { ops: [{ spans: ['(1,10)'], new_text: '⟨结论一⟩' }], option: 'execute' });
  ok(r.applied === 1, 'flush 应用 1 条', JSON.stringify(r));
  ok(reps(s).length === 1, '写下 1 条 replace', String(reps(s).length));
  ok(s.surface.replaceGeneration === 1, '世代递增到 1', String(s.surface.replaceGeneration));
  ok(textOf(s).includes('⟨结论一⟩'), '替代文本进入工作面');
  ok(s.surface.nodes.length < before, '工作面收缩', before + ' -> ' + s.surface.nodes.length);
  ok(holes(s).length === 0, '非空 new_text 不是空洞', String(holes(s).length));
  const shadowed = reps(s)[0].sourceEventSeqs;
  ok(shadowed.length === 21, '遮蔽 21 条（2..22）', String(shadowed.length));
  // 节点 id 是**确定性**的（不用随机 UUID）：日志可对账、可重放。
  ok(reps(s)[0].data.id === 'pm-surface-c1-0', '替换节点 id = pm-surface-<callId>-<序号>', String(reps(s)[0].data.id));
}

console.log(NL + '② new_text 为空 = 纯空洞（这是 hide 的表达）');
{
  const s = mk();
  const before = s.deriveMessages().length;
  const r = run(s, 'c2', { ops: [{ spans: ['(1,10)'], new_text: '' }], option: 'execute' });
  ok(r.applied === 1, 'flush 应用 1 条', JSON.stringify(r));
  ok(holes(s).length === 1, '写下的是 developer/message 空洞', String(holes(s).length));
  ok(s.deriveMessages().length <= 6, '空洞不产生消息（历史被大量遮蔽）', before + ' -> ' + s.deriveMessages().length);
  const msgs = s.deriveMessages();
  ok(!msgs.some((m) => m.role === 'developer' && m.content.length === 0), '空 content 的 developer 不可见');
}

console.log(NL + '③ 一个段落多个区间：前面的全隐藏，替代文本只落在最后一个');
{
  const s = mk();
  const r = run(s, 'c3', {
    ops: [{ spans: ['(1,2)', '(5,6)'], new_text: '⟨甲⟩' }],
    option: 'execute',
  });
  ok(r.applied === 1, '一次 flush 处理了这条声明', JSON.stringify(r));
  ok(reps(s).length === 2, '写下 2 条 replace（一段两区间）', String(reps(s).length));
  ok(holes(s).length === 1, '前面的区间是纯空洞', String(holes(s).length));
  const texts = reps(s).map((e) => (e.type === 'user/message' ? e.data.content[0].text : ''));
  ok(texts.includes('⟨甲⟩'), '替代文本落在最后的区间上');
  ok(textOf(s).includes('⟨甲⟩'), '替代文本进入工作面');
}

console.log(NL + '④ 区间语法：仅端点 / 闭 / 半开 / 反序 / this');
{
  const s = mk();
  const here = hereOf(s);
  const nodes = surfaceNodes(s);
  const seqOf = (id) => cookieNodes(s).find((c) => c.id === id).seq;
  const one = resolveOps(s, [{ spans: ['3'] }], here);
  ok(one.length === 1 && one[0].shadowed.length === 1 && one[0].shadowed[0] === seqOf(3), '仅端点 "3" = 那一条 cookie 消息');
  const closed = resolveOps(s, [{ spans: ['[3,4]'] }], here);
  ok(closed[0].shadowed.length === 3, '[3,4] 闭区间 = 3 条（ck3 / 中间消息 / ck4）', String(closed[0].shadowed.length));
  const open = resolveOps(s, [{ spans: ['(3,4)'] }], here);
  ok(open[0].shadowed.length === 1, '(3,4) 开区间 = 1 条', String(open[0].shadowed.length));
  const half = resolveOps(s, [{ spans: ['(3,4]'] }], here);
  ok(half[0].shadowed.length === 2, '(3,4] = 2 条', String(half[0].shadowed.length));
  const reversed = resolveOps(s, [{ spans: ['[4,3]'] }], here);
  ok(reversed[0].shadowed.length === 3, '端点反序自动排序 [4,3] = 3 条', String(reversed[0].shadowed.length));
  const self = resolveOps(s, [{ spans: ['this'] }], { thisSeq: nodes[10], thisEndSeq: nodes[11] });
  ok(self[0].shadowed.length === 2 && self[0].shadowed[0] === nodes[10] && self[0].shadowed[1] === nodes[11],
    'this = 承载调用的 assistant 消息 + 它的工具结果', JSON.stringify(self[0].shadowed));
}

console.log(NL + '⑤ 校验：错误必须点名说清楚');
{
  const s = mk();
  const here = hereOf(s);
  const msg = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
  ok(msg(() => resolveOps(s, [{ spans: ['3'], new_text: 'x', text_start: ['a'] }], here)).includes('未知字段'),
    '未知字段被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: [] }], here)).includes('非空数组'), '空 spans 被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: [3] }], here)).includes('必须是字符串'), '非字符串区间被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: ['99'] }], here)).includes('找不到 99 号 cookie'), '不存在的 cookie 编号被点名');
  ok(msg(() => resolveOps(s, [{ spans: ['(3,3)'] }], here)).includes('空的'), '空区间被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: ['[3,4'] }], here)).includes('没有闭合'), '括号不闭合被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: ['ck3'] }], here)).includes('不合法'), '非法端点被拒绝');
  ok(msg(() => resolveOps(s, [{ spans: ['0'] }], here)).includes('从 1 开始'), '0 号被拒绝');
}

console.log(NL + '⑥ 切在工具块中间的区间：**自动扩到整块边界**，而不是被拒');
{
  // 生产里 cookie 只落在边界上，所以正常路径根本切不进工具块。
  // 这里故意造一个「cookie 夹在 assistant 与它的 tool/result 之间」的 seed，
  // 检验防线本身：起点滑回调用消息、终点滑到结果之后。
  const raw = cookieSeed('subagent-95230f54.jsonl');
  const resultAt = raw.findIndex((e) => e.type === 'tool/result');
  const at = raw.slice(0, resultAt).map((e) => e.type).lastIndexOf('assistant/message');
  ok(at !== -1 && resultAt !== -1, 'seed 里找到「assistant … tool/result」的位置', String(at) + '/' + String(resultAt));
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
  const s = ctx.sessions.create('grp', { seed: spliced });
  openStep(s, 2, 1);
  const nodes = surfaceNodes(s);
  const cookieIndex = nodes.findIndex((q) => s.eventAt(q)?.data?.source?.id === 99);
  ok(cookieIndex !== -1, 'cookie 99 夹在工具块中间', String(cookieIndex));
  const nextCookie = cookieNodes(s).find((c) => c.index > cookieIndex);
  ok(nextCookie !== undefined, '它后面还有 cookie 边界', String(nextCookie?.id));
  const here = hereOf(s);
  const resolved = resolveOps(s, [{ spans: ['(' + 99 + ',' + nextCookie.id + ')'] }], here);
  const shadowed = resolved[0].shadowed;
  ok(shadowed[0] === nodes[cookieIndex - 1], '起点滑回调用消息（块边界）', String(shadowed[0]) + ' vs ' + String(nodes[cookieIndex - 1]));
  ok(shadowed[shadowed.length - 1] === nodes[cookieIndex + 1], '终点滑到结果之后（块边界）',
    String(shadowed[shadowed.length - 1]) + ' vs ' + String(nodes[cookieIndex + 1]));
  ok(shadowed.length === 3, '整块 + 块内那个 cookie 都被覆盖', String(shadowed.length));
  // 防御的底层保证：开集在块中间不为 0，所以那里本来就不是合法切口。
  const { before } = openSetProfile(s);
  ok(before.get(nodes[cookieIndex]) !== 0, '块中间不是合法起点（开集不为 0）', String(before.get(nodes[cookieIndex])));
}

console.log(NL + '⑦ this：吞掉自己这一步（调用消息 + 工具结果）');
{
  const s = mk();
  plasticizeCall(s, { turn: 2, step: 1 }, 'c7', { ops: [{ spans: ['this'], new_text: '' }], option: 'execute' });
  const r = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(r.applied === 1, 'flush 应用 1 条', JSON.stringify(r));
  const rep = reps(s)[0];
  ok(rep !== undefined && rep.sourceEventSeqs.length === 2, 'this 遮蔽 2 条（调用 + 结果）', String(rep?.sourceEventSeqs?.length));
  const types = rep.sourceEventSeqs.map((q) => s.eventAt(q).type);
  ok(types[0] === 'assistant/message' && types[1] === 'tool/result', '遮蔽的正是 assistant 与 tool/result', JSON.stringify(types));
  ok(!s.surface.nodes.includes(rep.sourceEventSeqs[0]), '调用消息已不在工作面上');
}

console.log(NL + '⑧ set 只预览，不写日志；execute 重传同一条 this 会落实 set 看过的那个');
{
  const s = mk();
  const seqBefore = s.seq;
  const genBefore = s.surface.replaceGeneration;
  plasticizeCall(s, { turn: 2, step: 1 }, 'c8-set', { ops: [{ spans: ['this'], new_text: '⟨预览用⟩' }], option: 'set' });
  const r0 = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(r0.applied === 0, 'set 不产生投影', JSON.stringify(r0));
  ok(reps(s).length === 0, 'set 不写 replace', String(reps(s).length));
  ok(s.surface.replaceGeneration === genBefore, '世代未变', String(s.surface.replaceGeneration));
  ok(s.seq > seqBefore, '日志只增加了调用本身（没有投影事件）');

  // 另开一步，重传同一条 this
  s.append('step/end', { turn: 2, step: 1 });
  s.append('step/start', { turn: 2, step: 2 });
  plasticizeCall(s, { turn: 2, step: 2 }, 'c8-exec', { ops: [{ spans: ['this'], new_text: '⟨预览用⟩' }], option: 'execute', also_execute_last_set: true });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  ok(r.applied >= 1, 'execute 被处理', JSON.stringify(r));
  ok(reps(s).length === 1, '只写一条 replace（set 与 execute 解出同一个区间）', String(reps(s).length));
  const shadowed = reps(s)[0].sourceEventSeqs;
  const setSeq = s.snapshotEvents().find((e) => e.type === 'assistant/message' && e.data.message.content.some((b) => b.id === 'c8-set')).seq;
  ok(shadowed.includes(setSeq), '**零点属于 set**：遮的是 set 那一步，不是 execute 那一步', JSON.stringify(shadowed));
  ok(textOf(s).includes('⟨预览用⟩'), '替代文本进入工作面');
}

console.log(NL + '⑨ 幂等：重复 flush 不重复执行');
{
  const s = mk();
  run(s, 'c9', { ops: [{ spans: ['(1,10)'], new_text: '⟨幂等⟩' }], option: 'execute' });
  const n1 = reps(s).length;
  const seqBefore = s.seq;
  const r2 = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(reps(s).length === n1, '不重复投影', n1 + ' -> ' + reps(s).length);
  ok(s.seq === seqBefore, '不产生新事件');
  ok(r2.applied === 0, '第二次 applied = 0', JSON.stringify(r2));
}

console.log(NL + '⑩ cookie 被遮蔽后，编号不漂移');
{
  const s = mk();
  // 先遮蔽 cookie 1（仅端点）。
  const r = run(s, 'c10', { ops: [{ spans: ['1'], new_text: '' }], option: 'execute' });
  ok(r.applied === 1, '第一条声明生效', JSON.stringify(r));
  ok(!cookieNodes(s).some((c) => c.id === 1), 'cookie 1 已不在工作面上');
  // 后面的编号必须仍然按 ID 解析：cookie 5/6 还在原位。
  const here = hereOf(s);
  const nodes = surfaceNodes(s);
  const resolved = resolveOps(s, [{ spans: ['(5,6)'] }], here);
  ok(resolved[0].shadowed.length === 2, '(5,6) 仍解析出 2 条', String(resolved[0].shadowed.length));
  ok(resolved[0].shadowed[0] === nodes[10] && resolved[0].shadowed[1] === nodes[11],
    '解析到的仍是 assistant+result 那一组');
  let err = '';
  try { resolveOps(s, [{ spans: ['(1,5)'] }], here); } catch (e) { err = e.message; }
  ok(err.includes('找不到 1 号 cookie'), '引用已遮蔽的 cookie 会明确报错', err.slice(0, 60));
}

console.log(NL + '⑪ execute 不带 ops（ops: []）时内容完全来自 set');
{
  const s = mk();
  const expectedStart = surfaceNodes(s)[2];   // (1,5) 的第一条：cookie1 之后的那个 user 消息
  plasticizeCall(s, { turn: 2, step: 1 }, 'c11-set', { ops: [{ spans: ['(1,5)'], new_text: '⟨来自 set⟩' }], option: 'set' });
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  s.append('step/end', { turn: 2, step: 1 });
  s.append('step/start', { turn: 2, step: 2 });
  plasticizeCall(s, { turn: 2, step: 2 }, 'c11-exec', { ops: [], option: 'execute', also_execute_last_set: true });
  const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
  const explicit = reps(s).filter((e) => (e.data?.message?.source?.note ?? '').startsWith('auto-hide') === false);
  ok(explicit.length === 1, '写下了 1 条显式投影', String(explicit.length) + ' | ' + JSON.stringify(r));
  ok(textOf(s).includes('⟨来自 set⟩'), '用的是 set 的内容');
  ok(explicit[0].sourceEventSeqs[0] === expectedStart, '起点仍是 set 时看到的那一条',
    String(explicit[0].sourceEventSeqs[0]) + ' vs ' + String(expectedStart));
}

done();
