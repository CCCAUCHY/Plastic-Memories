/**
 * 世代上下文的「事实源链」校验：
 *   会话日志 → 官方 SessionStore 重放 → 官方 surface.nodes → 官方 deriveEventMessage → rows。
 *
 * 这里不验证我们自己写的任何投影逻辑，只验证 generation-context.js 确实完全走官方代码：
 *   - rows 的 message 序列必须等于官方 session.deriveMessages()（逐条、逐字节）；
 *   - rows 的 seq 序列必须等于官方 surface.nodes；
 *   - 每个世代的影子会话重放结果必须与「重新建一次影子会话」一致（无状态、可重复）。
 *
 * 运行：node contexttest.mjs
 */

import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, fixture, cookieSession, openStep, plasticizeCall } from './testkit.mjs';
import { generationRows, liveGenerationRows } from './generation-context.js';
import { initState, applyEvent, viewOf } from './generations.js';
import { flush } from './engine.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('contexttest');
const json = (value) => JSON.stringify(value);

console.log(NL + '① live session：rows 就是官方 deriveMessages()');
{
  const ctx = new Context();
  new SessionStore(ctx);
  const session = cookieSession(ctx, 'ctx-live');
  for (const index of [0, 1]) {
    const turn = 2 + index;
    openStep(session, turn, 1);
    plasticizeCall(session, { turn, step: 1 }, 'ctx-exec-' + String(index), {
      ops: [{ spans: ['this'], new_text: '⟨第' + String(index) + '代⟩' }],
      option: 'execute',
    });
    flush(session, { openStep: { turn, step: 1 } });
    session.append('step/end', { turn, step: 1 });
  }
  const live = liveGenerationRows(session);
  const officialMessages = session.deriveMessages();
  ok(live.generation === session.surface.replaceGeneration, 'rows 的世代号 = 官方 replaceGeneration', String(live.generation));
  ok(json(live.rows.map((row) => row.seq)) === json([...session.surface.nodes]), 'rows 的 seq 序列 = 官方 surface.nodes');
  ok(json(live.rows.filter((row) => row.message !== undefined && row.message !== null).map((row) => row.message)) === json(officialMessages),
    'rows 的消息序列 = 官方 deriveMessages()（逐条一致）');
}

console.log(NL + '② 历史世代：截断日志 + 官方重放，逐代一致且可重复');
{
  const ctx = new Context();
  new SessionStore(ctx);
  const events = fixture('session-ptc-stabilized.jsonl').filter((event) => event.type !== 'session');
  let state = initState();
  for (const event of events) state = applyEvent(state, event);
  const view = viewOf(state);
  let mismatches = 0;
  for (const generation of view.generations) {
    const first = generationRows(ctx.sessions, events, generation, 'ctx-shadow-a');
    const second = generationRows(ctx.sessions, events, generation, 'ctx-shadow-b');
    const seed = events.filter((event) => event.seq <= generation.asOfSeq);
    const official = ctx.sessions.create('ctx-official-' + String(generation.gen), { seed });
    if (json(first) !== json(second)) mismatches += 1;
    if (first.generation !== official.surface.replaceGeneration) mismatches += 1;
    if (json(first.rows.map((row) => row.seq)) !== json([...official.surface.nodes])) mismatches += 1;
    const officialMessages = official.deriveMessages();
    const rowMessages = first.rows.filter((row) => row.message !== undefined && row.message !== null).map((row) => row.message);
    if (json(rowMessages) !== json(officialMessages)) mismatches += 1;
  }
  ok(mismatches === 0, '每个世代：rows 与官方重放逐条一致，且两次调用完全可重复', String(mismatches) + ' 处不一致');
  console.log('     （检查了 ' + String(view.generations.length) + ' 个世代：' + view.generations.map((g) => '#' + String(g.gen) + '@' + String(g.asOfSeq)).join(' ') + '）');
}

done();