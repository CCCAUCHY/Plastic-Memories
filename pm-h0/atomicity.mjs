/**
 * 步骤原子性回归：PM 的合法投影必须「整步闭合」。
 *
 * 领域事实（用户确认）：
 *   - 一步 = 一条助手消息（思考 + 正文 + 工具调用） + 它的全部工具结果；
 *   - 工具结果必须跟随工具调用（API 强约束），PM 的最小操作单位是一条消息，
 *     因此不存在「只遮工具结果 / 只遮助手消息」的合法投影。
 *
 * 该性质由 grouping 的开集归零保证（端点滑到组合边界 = 一步的边界）；
 * 本套件从三个角度钉住它：
 *   ① 滑点：命中一步里的任意节点 → 区间覆盖整步（含全部结果）；
 *   ② 真实日志：历史上两条真实投影都整步闭合；
 *   ③ 插件真实执行：this 生成的投影也整步闭合（resolveOps 内部不变量）。
 *
 * 运行：node atomicity.mjs
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, fixture, cookieSession, openStep, plasticizeCall } from './testkit.mjs';
import { closureViolations, openSetProfile, slideToGroupEdge, stepUnitsOf } from './grouping.js';
import { flush } from './engine.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('atomicity');
const quiet = { warn: () => {}, info: () => {} };

/** 构造一个假的 view（只给 grouping 用）。 */
function makeView(events) {
  const nodes = events.map((_, index) => index);
  return { surface: { nodes }, eventAt: (seq) => events[seq] };
}

console.log(NL + '① 滑点：命中一步里任意节点 → 区间覆盖整步');
{
  const call = (id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' });
  const events = [
    { type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [call('c1'), call('c2')] } } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1' } } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2' } } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'again' }] } } },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  ];
  const view = makeView(events);
  const profile = openSetProfile(view);
  const nodes = view.surface.nodes;
  ok(slideToGroupEdge(nodes, profile, 3, 'start') === 2, '命中第二个结果：起点滑到助手消息', String(slideToGroupEdge(nodes, profile, 3, 'start')));
  ok(slideToGroupEdge(nodes, profile, 2, 'end') === 4, '命中助手消息：终点滑到最后一个结果', String(slideToGroupEdge(nodes, profile, 2, 'end')));
  ok(slideToGroupEdge(nodes, profile, 4, 'start') === 2 && slideToGroupEdge(nodes, profile, 3, 'end') === 4,
    '命中任一结果 / 任意组合：区间都覆盖整步（助手消息 + 全部结果）');
  ok(closureViolations(view, [0]).length === 0, 'system prompt 是独立消息，单独隐藏不拆步');
  ok(closureViolations(view, [6]).length === 0, '纯文本的一步（只有助手消息）单独隐藏合法');
  ok(closureViolations(view, [2, 3]).length === 1, '只遮一步里的部分节点 → 报出拆步', JSON.stringify(closureViolations(view, [2, 3])));
}

console.log(NL + '② 真实会话日志：现行语义下没有拆步，只有旧版本事故遗留');
{
  // 用户观点：合法投影不可能拆步（一步 = 助手消息 + 全部工具结果）。
  // 用**真实会话导出**验证：逐条历史投影做整步闭合检查。
  // 已知例外：早期版本（balanced.mjs 记录的那次事故）曾把区间切在工具对中间，
  // 两份旧日志里各留了 1 条拆步记录；修复后的引擎不再产生（③ 用真实执行证明）。
  const dir = fileURLToPath(new URL('../会话日志原件', import.meta.url));
  const ctx = new Context();
  new SessionStore(ctx);
  let filesWithReplacements = 0;
  let shadowCounter = 0;
  let totalReplacements = 0;
  const violations = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.zip')) continue;
    const text = execFileSync('unzip', ['-p', dir + '/' + name, 'session.v4.jsonl'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const events = text.trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line)).filter((event) => event.type !== 'session');
    const replacements = events.filter((event) => event.surfaceOp !== undefined && typeof event.surfaceOp === 'object');
    if (replacements.length === 0) continue;
    filesWithReplacements += 1;
    totalReplacements += replacements.length;
    for (const [index, replacement] of replacements.entries()) {
      const prefix = events.filter((event) => event.seq < replacement.seq);
      const shadow = ctx.sessions.create('atomic-real-' + String(shadowCounter++) + '-' + String(index), { seed: prefix });
      const nodes = [...shadow.surface.nodes];
      const view = { surface: { nodes }, eventAt: (seq) => shadow.eventAt(seq) };
      const shadowed = nodes.filter((seq) => seq >= replacement.surfaceOp.startSeq && seq <= replacement.surfaceOp.endSeq);
      for (const violation of closureViolations(view, shadowed)) {
        violations.push({ session: name, generation: index, ...violation });
      }
    }
  }
  ok(filesWithReplacements >= 5 && totalReplacements >= 100,
    '真实日志里找到足够多的历史投影', String(filesWithReplacements) + ' 份会话 / ' + String(totalReplacements) + ' 条投影');
  const legacySessions = new Set([
    'dsh-session-session-3b4ce363-7466-4cb7-98b3-d862a4225323.zip',
    'dsh-session-session-d7e22544-2fac-40fb-9d84-cfea02621dff.zip',
  ]);
  ok(violations.every((violation) => legacySessions.has(violation.session)),
    '除旧版本事故会话外，没有任何拆步投影', JSON.stringify(violations.slice(0, 3)));
  ok(violations.length === 2, '拆步记录 = 2 条（旧版本遗留，不是现行语义）', String(violations.length));
  ok(violations.every((violation) => violation.inside === 1 && violation.size === 2),
    '遗留拆步的形态都是「助手消息可见、工具结果被遮」（正是旧 bug）', JSON.stringify(violations));
}

console.log(NL + '③ 插件真实执行：this 生成的投影整步闭合');
{
  const ctx = new Context();
  new SessionStore(ctx);
  const session = cookieSession(ctx, 'atomic-this');
  openStep(session, 9, 1);
  plasticizeCall(session, { turn: 9, step: 1 }, 'atomic-exec', { ops: [{ spans: ['this'], new_text: '⟨整步⟩' }], option: 'execute' });
  const result = flush(session, { openStep: { turn: 9, step: 1 } }, quiet);
  ok(result.applied === 1, 'this 投影落地', JSON.stringify(result));
  const log = session.snapshotEvents();
  const replacement = log.filter((event) => event.surfaceOp !== undefined && typeof event.surfaceOp === 'object').at(-1);
  const prefix = log.filter((event) => event.seq < replacement.seq);
  const shadow = ctx.sessions.create('atomic-this-shadow', { seed: prefix });
  const nodes = [...shadow.surface.nodes];
  const view = { surface: { nodes }, eventAt: (seq) => shadow.eventAt(seq) };
  const shadowed = nodes.filter((seq) => seq >= replacement.surfaceOp.startSeq && seq <= replacement.surfaceOp.endSeq);
  ok(closureViolations(view, shadowed).length === 0, 'this = 整步（助手消息 + 结果），没有拆步');
}

done();