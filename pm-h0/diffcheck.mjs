/**
 * 世代投影 vs 官方 surface：逐世代差分校验。
 *
 * 用户关心的是：我们算出来的「可见 seq 集合」会不会和官方投影（真正提交给推理服务的
 * 那一套）差一丝。这里用**官方代码**做裁判：
 *   - 取真实会话日志（fixture）；
 *   - 对每个世代边界（asOfSeq），用官方 SessionStore 以「截断到该边界的日志前缀」重建一个
 *     影子会话 —— 它会用官方 surface fold 重放；
 *   - 比较影子会话的 `surface.nodes` / `replaceGeneration` 与我们的投影快照。
 *
 * 如果每一代都相等，客户端拿到的「可见 seq 字典」就等价于官方投影在该时刻的结果；
 * 若哪天 DSH 改了 fold 语义，这条测试会直接报红。
 *
 * 运行：node diffcheck.mjs
 */

import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, fixture } from './testkit.mjs';
import { initState, applyEvent, viewOf } from './generations.js';
import { cookieSession, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('diffcheck');

/**
 * 把一份日志折成我们的世代视图。
 * @param {Array<object>} events - 会话事件（seq 连续）。
 * @returns {object} viewOf 的 wire 值。
 */
function fold(events) {
  let state = initState();
  for (const event of events) state = applyEvent(state, event);
  return viewOf(state);
}

/**
 * 用官方 SessionStore 重放日志前缀，返回官方 surface。
 * @param {object} ctx - 带 SessionStore 的 cordis Context。
 * @param {Array<object>} events - 完整事件数组。
 * @param {number} uptoSeq - 截断到的 seq（含）。
 * @param {string} id - 影子会话 id。
 * @returns {{nodes: number[], generation: number}} 官方 surface。
 */
function officialSurfaceAt(ctx, events, uptoSeq, id) {
  const seed = events.filter((event) => event.seq <= uptoSeq);
  const shadow = ctx.sessions.create(id, { seed });
  return { nodes: [...shadow.surface.nodes], generation: shadow.surface.replaceGeneration };
}

console.log(NL + '① 真实日志：每一代的可见 seq 都与官方 surface 完全一致');
{
  const ctx = new Context();
  new SessionStore(ctx);
  const events = fixture('session-ptc-stabilized.jsonl').filter((event) => event.type !== 'session');
  const view = fold(events);
  ok(view.generations.length >= 3, '夹具里至少有 3 个世代边界', String(view.generations.length));
  let mismatches = 0;
  let checked = 0;
  for (const generation of view.generations) {
    const official = officialSurfaceAt(ctx, events, generation.asOfSeq, 'diff-fixture-' + String(generation.gen));
    checked += 1;
    const sameNodes = official.nodes.length === generation.seqs.length
      && official.nodes.every((seq, index) => seq === generation.seqs[index]);
    const sameGeneration = official.generation === generation.gen;
    if (!sameNodes || !sameGeneration) {
      mismatches += 1;
      console.log('  ❌ 第 ' + String(generation.gen) + ' 代不一致：官方 ' + JSON.stringify(official) + ' vs 我们 ' + JSON.stringify({ nodes: generation.seqs, generation: generation.gen }));
    }
  }
  ok(mismatches === 0, '全部 ' + String(checked) + ' 个世代边界都与官方 fold 一致', String(mismatches) + ' 个不一致');
  console.log('     （逐世代比较了 ' + String(checked) + ' 次：' + view.generations.map((g) => '#' + String(g.gen) + '@' + String(g.asOfSeq)).join(' ') + '）');
}

console.log(NL + '② 真实插件操作产生的日志：每一代边界都与官方一致');
{
  const ctx = new Context();
  new SessionStore(ctx);
  const session = cookieSession(ctx, 'diff-live');
  // 造三个世代：每代做一次 execute，中间夹一些普通消息，让日志形态接近真实运行。
  const runs = [
    { spans: ['this'], text: '⟨第一代⟩' },
    { spans: ['this'], text: '⟨第二代⟩' },
    { spans: ['this'], text: '⟨第三代⟩' },
  ];
  const current = session.snapshotEvents();
  const events = [...current];
  for (const [index, run] of runs.entries()) {
    const step = index + 1;
    const at = { turn: 2, step };
    session.append('turn/start', { turn: 2 + index });
    session.append('step/start', { turn: 2 + index, step: 1 });
    plasticizeCall(session, { turn: 2 + index, step: 1 }, 'diff-exec-' + String(index), {
      ops: [{ spans: run.spans, new_text: run.text }],
      option: 'execute',
    });
    flush(session, { openStep: { turn: 2 + index, step: 1 } });
    session.append('step/end', { turn: 2 + index, step: 1 });
    void at;
  }
  const log = session.snapshotEvents();
  const view = fold(log);
  ok(view.current >= 3, '插件操作产生了至少 3 个世代', String(view.current));
  let mismatches = 0;
  for (const generation of view.generations) {
    const official = officialSurfaceAt(ctx, log, generation.asOfSeq, 'diff-live-' + String(generation.gen));
    const sameNodes = official.nodes.length === generation.seqs.length
      && official.nodes.every((seq, index) => seq === generation.seqs[index]);
    if (!sameNodes || official.generation !== generation.gen) {
      mismatches += 1;
      console.log('  ❌ 第 ' + String(generation.gen) + ' 代不一致：官方 gen=' + String(official.generation) + ' vs 我们 gen=' + String(generation.gen));
    }
  }
  ok(mismatches === 0, '插件真实操作产生的每一代都与官方 fold 一致', String(mismatches) + ' 个不一致');
}

done();