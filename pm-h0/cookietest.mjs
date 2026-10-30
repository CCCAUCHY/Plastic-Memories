/**
 * PM · cookie 与区间语法的回归。
 *
 * cookie 现在是**自动插入**的（模型不再主动调用），所以这套测的是：
 *   1. 文本格式与反解
 *   2. 编号规则（扫全量日志、取 max+1、跨世代不重复）
 *   3. 六种区间语法的解析与解析成工作面下标
 *   4. this 端点 = 本次调用所在的 assistant + 它的工具结果
 *   5. **按 ID 解析**：某个 cookie 被遮蔽后，其余编号不漂移
 *
 * 运行：node cookietest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, fixture } from './testkit.mjs';
import { snapshotSurface } from './coords.js';
import {
  COOKIE_KIND, cookieText, parseCookieText, isCookie, cookieIdOf, listCookies, nextCookieId,
  cookieIndex, maxVisibleCookieId, planCookie, bracketUserMessages,
} from './cookie.js';
import { parseSpan, resolveSpan, SELF } from './spans.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('cookietest');
const ctx = new Context(); new SessionStore(ctx);

console.log(NL + '① 文本格式与反解');
{
  ok(cookieText(17) === '[Plastic-Memories][cookie][17]', '格式 = [Plastic-Memories][cookie][序号]', cookieText(17));
  ok(cookieText(17, 42) === '[42% of context used][Plastic-Memories][cookie][17]', 'context 水位前缀', cookieText(17, 42));
  ok(parseCookieText(cookieText(17, 42)) === 17, '带水位前缀也能反解编号', String(parseCookieText(cookieText(17, 42))));
  ok(cookieText(1, 150) === '[100% of context used][Plastic-Memories][cookie][1]', '水位夹在 0..100', cookieText(1, 150));
  ok(parseCookieText(cookieText(1)) === 1, '反解 1');
  ok(parseCookieText(cookieText(4096)) === 4096, '反解 4096');
  ok(parseCookieText('普通文本') === undefined, '普通文本解不出来');
  // 整行锚定：夹在别的文本里的同样字样不算 cookie 文本。
  ok(parseCookieText('前文 [Plastic-Memories][cookie][7] 后文') === undefined, '夹在文本中不会被反解');
  ok(parseCookieText('  ' + cookieText(7) + '  ') === 7, '前后空白被容忍');
}

console.log(NL + '①b 身份只来自元数据 —— 文本样式本身不会被误认成 cookie');
{
  // 这一条直接对着「在 PM 开发会话里，样式会被反复引用」这个场景。
  const s = ctx.sessions.create('ct1b', {});
  s.append('turn/start', { turn: 1 });
  s.append('step/start', { turn: 1, step: 1 });
  // ① 助手回复里写出这个样式（就像我在对话里回复的那样）
  s.append('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: 'a-quote', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'text', text: 'cookie 的样式是 ' + cookieText(1) + '，请确认。' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  // ② 普通用户消息里写出这个样式（没有元数据标记）
  s.append('user/message', {
    id: 'u-quote', role: 'user', content: [{ type: 'text', text: cookieText(2) }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  // ③ 真正的 cookie：用户消息 + 标记
  s.append('user/message', {
    id: 'ck-3', role: 'user', content: [{ type: 'text', text: cookieText(3) }], source: { kind: COOKIE_KIND, v: 1, id: 3 },
  }, { surfaceOp: 'append' });
  const events = s.snapshotEvents();
  const quotedAssistant = events.find((e) => e.type === 'assistant/message');
  const quotedUser = events.find((e) => e.type === 'user/message' && e.data.id === 'u-quote');
  const real = events.find((e) => e.type === 'user/message' && e.data.id === 'ck-3');
  ok(isCookie(quotedAssistant) === false, '助手消息里的同样字样不算 cookie');
  ok(isCookie(quotedUser) === false, '普通用户消息里的同样字样不算 cookie（无标记）');
  ok(cookieIdOf(quotedAssistant) === undefined && cookieIdOf(quotedUser) === undefined, '也解不出编号');
  ok(isCookie(real) === true && cookieIdOf(real) === 3, '带标记的用户消息才算 cookie');
  ok(listCookies(s).length === 1, '全量扫描只找到 1 条 cookie', String(listCookies(s).length));
  ok(nextCookieId(s) === 4, '编号不受文本引用影响', String(nextCookieId(s)));
}

console.log(NL + '② 编号：扫全量日志，取 max+1，跨世代不重复');
{
  const s = ctx.sessions.create('ct1', { seed: fixture('subagent-95230f54.jsonl').filter((r) => r.type !== 'session') });
  ok(nextCookieId(s) === 1, '空日志下一个是 1');
  const add = (n) => s.append('user/message', {
    id: 'ck' + n, role: 'user', content: [{ type: 'text', text: cookieText(n) }],
    source: { kind: COOKIE_KIND, v: 1, id: n },
  }, { surfaceOp: 'append' });
  add(1);
  ok(nextCookieId(s) === 2, '一条之后下一个是 2', String(nextCookieId(s)));
  add(2);
  add(3);
  ok(listCookies(s).map((c) => c.id).join() === '1,2,3', '编号按日志顺序 1,2,3');
  ok(nextCookieId(s) === 4, '下一个是 4');
  ok(isCookie(s.eventAt(s.surface.nodes.find((q) => s.eventAt(q)?.data?.source?.kind === COOKIE_KIND))) === true, 'isCookie 认得出来');
  // source.id 缺失时用正文兜底
  s.append('user/message', {
    id: 'ck-legacy', role: 'user', content: [{ type: 'text', text: cookieText(9) }],
    source: { kind: COOKIE_KIND, v: 1 },
  }, { surfaceOp: 'append' });
  ok(cookieIdOf([...s.snapshotEvents()].at(-1)) === 9, 'source.id 缺失时从正文反解');
  ok(nextCookieId(s) === 10, 'max+1 = 10（不是「最后一条 +1」）', String(nextCookieId(s)));
}

console.log(NL + '③ 区间语法：六种写法');
{
  const eq = (raw, want, openA, openB) => {
    const p = parseSpan(raw);
    const same = String(p.a) === String(want[0]) && String(p.b) === String(want[1]);
    ok(same && p.openA === openA && p.openB === openB, raw + ' 解析正确', JSON.stringify({ a: String(p.a), b: String(p.b), openA: p.openA, openB: p.openB }));
  };
  eq('3', [3, 3], false, false);
  eq('[3,4]', [3, 4], false, false);
  eq('(3,4)', [3, 4], true, true);
  eq('[3,4)', [3, 4], false, true);
  eq('(3,4]', [3, 4], true, false);
  const self = parseSpan('this');
  ok(self.a === SELF && self.b === SELF, 'this 解析成 SELF 哨兵');
  const mixed = parseSpan('[3,this]');
  ok(mixed.a === 3 && mixed.b === SELF, '可以与 this 混用');
  const bad = (raw) => { try { parseSpan(raw); return undefined; } catch (e) { return e.message; } };
  ok(bad('[3]') !== undefined, '缺逗号会被拒', String(bad('[3]')).slice(0, 40));
  ok(bad('abc') !== undefined, '非法端点会被拒', String(bad('abc')).slice(0, 40));
  ok(bad('[3,4') !== undefined, '没闭合会被拒', String(bad('[3,4')).slice(0, 40));
  ok(bad('') !== undefined, '空串会被拒');
}

console.log(NL + '④ 解析成工作面下标：开闭决定是否含 cookie 自己');
{
  // #0 ck1 | #1 user | #2 assistant | #3 tool/result | #4 ck2
  const s = ctx.sessions.create('ct2', {});
  s.append('turn/start', { turn: 1 });
  s.append('step/start', { turn: 1, step: 1 });
  const ck = (n) => s.append('user/message', { id: 'k' + n, role: 'user', content: [{ type: 'text', text: cookieText(n) }],
    source: { kind: COOKIE_KIND, v: 1, id: n } }, { surfaceOp: 'append' });
  ck(1);
  s.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '做事' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
    content: [{ type: 'reasoning', text: '想' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] }, stream: [] }, { surfaceOp: 'append' });
  s.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', toolCallId: 'c1',
    content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'c1' } } }, { surfaceOp: 'append' });
  ck(2);

  const snap = snapshotSurface(s);
  const nodes = snap.nodes;
  const view = { surface: { nodes }, eventAt: (q) => s.eventAt(q) };
  const here = { thisSeq: nodes[2], thisEndSeq: nodes[3] };
  const span = (raw) => {
    const r = resolveSpan(view, raw, here);
    return r.startIndex + '..' + r.endIndex;
  };
  ok(span('1') === '0..0', '仅端点 → 只有那条 cookie', span('1'));
  ok(span('[1,2]') === '0..4', '闭区间含两个 cookie', span('[1,2]'));
  ok(span('(1,2)') === '1..3', '开区间不含 cookie', span('(1,2)'));
  ok(span('[1,2)') === '0..3', '半开 [1,2)', span('[1,2)'));
  ok(span('(1,2]') === '1..4', '半开 (1,2]', span('(1,2]'));
  ok(span('this') === '2..3', 'this = assistant + 它的工具结果', span('this'));
  ok(span('[1,this]') === '0..3', 'cookie 与 this 混用', span('[1,this]'));
  ok(span('(1,this)') === '1..1', '开括号排除整个 this 组', span('(1,this)'));
  ok(span('[2,1]') === span('[1,2]'), '两端自动排序（没有方向）', span('[2,1]'));
  ok(span('(2,1)') === span('(1,2)'), '开区间也自动排序');

  let msg;
  try { resolveSpan(view, '99', here); } catch (e) { msg = e.message; }
  ok(typeof msg === 'string' && msg.includes('99'), '引用不存在的编号会报错', String(msg).slice(0, 60));

  const idx = cookieIndex(view, 2);
  ok(idx !== undefined && idx.index === 4, 'cookieIndex 定位到第二条 cookie', JSON.stringify(idx));
  ok(cookieIndex(view, 99) === undefined, '不存在的编号返回 undefined');
  ok(maxVisibleCookieId(view) === 2, '可见的最大编号是 2');
}

console.log(NL + '⑤ 按 ID 解析：某个 cookie 被遮蔽后，其余编号不漂移');
{
  const s = ctx.sessions.create('ct3', {});
  s.append('turn/start', { turn: 1 });
  s.append('step/start', { turn: 1, step: 1 });
  const ck = (n) => s.append('user/message', { id: 'k' + n, role: 'user', content: [{ type: 'text', text: cookieText(n) }],
    source: { kind: COOKIE_KIND, v: 1, id: n } }, { surfaceOp: 'append' });
  for (let n = 1; n <= 5; n++) {
    ck(n);
    s.append('user/message', { id: 'u' + n, role: 'user', content: [{ type: 'text', text: '第' + n + '段' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  }
  // 遮蔽 ck1 与它后面那条 user 消息（闭区间 [1,2] 会连 ck2 一起，所以用 (1,1)? 用 [1,1] 只遮 ck1）
  s.append('developer/message', { turn: 1, step: 1, message: { id: 'hole', role: 'developer', content: [],
    source: { kind: 'pm-surface', v: 1, op: 'hide', callId: 'x', generation: 1, refs: [s.surface.nodes[0]] } } },
  { surfaceOp: { op: 'replace', startSeq: s.surface.nodes[0], endSeq: s.surface.nodes[0] }, sourceEventSeqs: [s.surface.nodes[0]] });
  const snap = snapshotSurface(s);
  const view = { surface: { nodes: snap.nodes }, eventAt: (q) => s.eventAt(q) };
  ok(cookieIndex(view, 1) === undefined, 'ck1 已不在工作面上');
  const found = cookieIndex(view, 5);
  ok(found !== undefined, 'ck5 仍能按 ID 找到');
  ok(s.eventAt(found.seq)?.data?.content?.[0]?.text === cookieText(5), '找到的确实是 ck5（不是「第 4 个可见」）');
  ok(maxVisibleCookieId(view) === 5, '最大编号仍是 5（编号不随可见性漂移）');
}

console.log(NL + '⑥ planCookie：队尾规则');
{
  const s = ctx.sessions.create('ct4', {});
  ok(planCookie(s) === undefined, '空工作面不补');
  s.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '普通' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  ok(planCookie(s) !== undefined, '队尾不是 cookie → 需要补');
  s.append('user/message', { id: 'k1', role: 'user', content: [{ type: 'text', text: cookieText(1) }], source: { kind: COOKIE_KIND, v: 1, id: 1 } }, { surfaceOp: 'append' });
  ok(planCookie(s) === undefined, '队尾已是 cookie → 不补');
}

console.log(NL + '⑦ bracketUserMessages：只补右端点（左端点由请求边界插入，编号预留防碰撞）');
{
  const s = ctx.sessions.create('ct-bracket', {});
  const U = (text, kind = 'user') => ({ id: 'u-' + text, role: 'user', content: [{ type: 'text', text }], source: { kind } });

  const first = bracketUserMessages(s, [U('第一条')]);
  ok(first.length === 2, '决策里只有 user + 右端点（左端点由 request 边界插入）', String(first.length));
  ok(first[0].source.kind === 'user' && first[1].source.kind === COOKIE_KIND,
    '顺序 = 用户 / cookie', JSON.stringify(first.map((m) => m.source.kind)));
  ok(first[1].source.id === 2, '右端点预留 request 边界要用的编号（next + 1）', String(first[1].source.id));

  for (const message of first) s.append('user/message', message, { surfaceOp: 'append' });
  const second = bracketUserMessages(s, [U('第二条')]);
  ok(second.length === 2 && second[0].source.kind === 'user' && second[1].source.kind === COOKIE_KIND,
    '队尾已是 cookie → request 不插左端点，右端点直接用 next', JSON.stringify(second.map((m) => m.source.kind)));
  ok(second[1].source.id === 3, '编号接着日志最大值', String(second[1].source.id));

  ok(bracketUserMessages(s, [U('Current runtime context', 'runtime-context')]) === undefined,
    '时间快照（runtime-context）不夹 cookie');
  ok(bracketUserMessages(s, []) === undefined && bracketUserMessages(s, undefined) === undefined,
    '空消息列表不夹');

  const pair = bracketUserMessages(s, [U('A'), U('B')]);
  ok(pair.map((m) => m.source.kind).join(',') === 'user,' + COOKIE_KIND + ',user,' + COOKIE_KIND,
    '连续两条用户消息 = u,c,u,c', JSON.stringify(pair.map((m) => m.source.kind)));
}

done();