/**
 * PM · 消息组合抽象（grouping）的回归。
 *
 * 这一套不是测「工具块」—— 那有别的测试盯着。它测的是**抽象本身**：
 * 换一种组合类型，配对平衡与端点扩展是否**自动**跟上。
 *
 * 做法：凭空造一种现实里不存在的组合（user/message 开启、紧跟的 assistant 关闭），
 * 只往注册表加一个 trait，不改任何调用方 —— 然后断言切口集合与端点扩展都变了。
 *
 * 运行：node groupingtest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { fixture, makeCounter, openStep, plasticizeCall } from './testkit.mjs';
import { surfaceNodes } from './coords.js';
import { GROUPINGS, TOOL_CALL, describeGroupings, openSetProfile, relationsOf, slideToGroupEdge } from './grouping.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('groupingtest');

const ctx = new Context(); new SessionStore(ctx);
const s = ctx.sessions.create('grp', { seed: fixture('subagent-95230f54.jsonl').filter((r) => r.type !== 'session') });
let n = 0;
const step = (text, cid, out) => {
  n += 1;
  s.append('turn/start', { turn: n });
  s.append('step/start', { turn: n, step: 1 });
  s.append('user/message', { id: 'u' + n, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  s.append('assistant/message', { turn: n, step: 1, message: { id: 'a' + n, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
    content: [{ type: 'tool-call', id: cid, name: 'bash', arguments: '{}' }] }, stream: [] }, { surfaceOp: 'append' });
  s.append('tool/call', { turn: n, step: 1, callId: cid, name: 'bash', arguments: '{}' });
  s.append('tool/result', { turn: n, step: 1, message: { id: 't' + cid, role: 'tool', toolCallId: cid,
    content: [{ type: 'text', text: out }], isError: false, source: { kind: 'tool', callId: cid } } }, { surfaceOp: 'append' });
  s.append('step/end', { turn: n, step: 1 });
};
step('甲', 'cA', 'AAAA');
step('乙', 'cB', 'BBBB');
openStep(s, 99, 1);
plasticizeCall(s, { turn: 99, step: 1 }, 'xc', { ops: [], option: 'set' });

const nodes = surfaceNodes(s);
const view = {
  surface: { nodes, replaceGeneration: s.surface.replaceGeneration },
  eventAt: (q) => s.eventAt(q),
  deriveEventMessage: (e) => s.deriveEventMessage(e),
};
const cutsOf = (reg) => {
  const prof = openSetProfile(view, reg);
  return nodes.map((q, i) => (prof.before.get(q) === 0 && prof.after.get(q) === 0 ? i : null)).filter((x) => x !== null);
};

console.log(NL + '① 默认注册表只有 tool-call 组合');
{
  ok(GROUPINGS.has('tool-call'), 'tool-call 已注册');
  ok(describeGroupings().includes('tool call'), 'describe 可用于错误信息', describeGroupings());
  ok(cutsOf(GROUPINGS).length > 1, '存在多个合法切口', String(cutsOf(GROUPINGS).length));
}

console.log(NL + '② 每条 assistant 只开启「它自己那些」tool-call');
{
  const withCall = nodes.find((q) => {
    const e = s.eventAt(q);
    return e?.type === 'assistant/message' && e.data.message.content.some((b) => b?.type === 'tool-call');
  });
  const rel = relationsOf(s.eventAt(withCall), GROUPINGS);
  ok(rel.opens.length >= 1, '开启了关系键', JSON.stringify(rel.opens));
  ok(rel.opens.every((k) => k.startsWith('tool-call:')), '键带类型前缀（避免跨 trait 撞键）', rel.opens[0]);
  ok(rel.closes.length === 0, 'assistant 不关闭任何关系');
  const result = nodes.find((q) => s.eventAt(q)?.type === 'tool/result');
  const rel2 = relationsOf(s.eventAt(result), GROUPINGS);
  ok(rel2.closes.length === 1 && rel2.opens.length === 0, 'tool/result 只关闭、不开启', JSON.stringify(rel2.closes));
}

console.log(NL + '③ 关键：凭空加一种组合，切口集合与端点扩展**自动**跟上');
{
  const VIRTUAL = {
    id: 'virtual-pair',
    describe: '一个虚构的成对结构（仅用于验证扩展性）',
    keyOf(event) {
      if (event.type === 'user/message') {
        const id = event.data?.id;
        return typeof id === 'string' ? { opens: ['vpair:' + id] } : undefined;
      }
      if (event.type === 'assistant/message') return { closes: ['vpair:any'] };
      return undefined;
    },
  };
  const before = cutsOf(GROUPINGS);
  const reg = new Map([...GROUPINGS, [VIRTUAL.id, VIRTUAL]]);
  const after = cutsOf(reg);
  ok(after.length !== before.length || after.join() !== before.join(), '切口集合变了（新组合生效）', before.length + ' -> ' + after.length);
  ok(describeGroupings(reg).includes('虚构'), 'describe 也纳入新类型', describeGroupings(reg).slice(0, 60));

  // 端点扩展同样自动跟上：滑动结果应当不同
  const last = nodes.length - 1;
  const p1 = openSetProfile(view, GROUPINGS);
  const p2 = openSetProfile(view, reg);
  const e1 = slideToGroupEdge(nodes, p1, last, 'start');
  const e2 = slideToGroupEdge(nodes, p2, last, 'start');
  ok(typeof e1 === 'number' && typeof e2 === 'number', '两种注册表都能滑出端点', e1 + ' / ' + e2);
  ok(e1 !== e2, '新组合改变了扩展结果（调用方一行没改）', '#' + e1 + ' -> #' + e2);
}

console.log(NL + '④ 滑到的位置**必然**是合法切口（这是定义，不是巧合）');
{
  const prof = openSetProfile(view, GROUPINGS);
  let allClean = true;
  for (let i = 0; i < nodes.length; i++) {
    for (const side of ['start', 'end']) {
      const j = slideToGroupEdge(nodes, prof, i, side);
      const seq = nodes[j];
      const good = side === 'start' ? prof.before.get(seq) === 0 : prof.after.get(seq) === 0;
      if (!good) { allClean = false; console.log('     ❌ #' + i + ' ' + side + ' -> #' + j); }
    }
  }
  ok(allClean, '所有滑动结果都落在开集归零处', String(nodes.length * 2) + ' 次');
  ok(TOOL_CALL.keyOf({ type: 'nonsense' }) === undefined, '无关事件返回 undefined（不误伤）');
}

done();