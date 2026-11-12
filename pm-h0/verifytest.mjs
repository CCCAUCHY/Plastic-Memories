/**
 * PM · 语义审计器回归。
 *
 * 验证两件事：
 *   1. 一个正常会话经 verifyPmSemantics 审计为 0 错误；
 *   2. 人为破坏 sourceEventSeqs / 内容 / 锁记录时，审计器能抓到。
 *
 * 运行：node verifytest.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { makeCounter, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';
import { verifyPmSemantics } from './verify.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('verifytest');
const quiet = { warn: () => {}, info: () => {} };
const ctx = new Context(); new SessionStore(ctx);
const s = ctx.sessions.create('verify-semantics', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(s, 2, 1);
plasticizeCall(s, { turn: 2, step: 1 }, 'v-set', { ops: [{ positions: ['unit 3'], new_text: '⟨预览⟩' }], option: 'set' });
s.append('step/end', { turn: 2, step: 1 });
s.append('step/start', { turn: 2, step: 2 });
plasticizeCall(s, { turn: 2, step: 2 }, 'v-exec', { ops: [{ positions: ['this'], new_text: '⟨结论⟩' }], option: 'execute' });
const r = flush(s, { openStep: { turn: 2, step: 2 } }, quiet);
ok(r.applied >= 1, '执行落地', JSON.stringify(r));

const events = s.snapshotEvents();
const errors = verifyPmSemantics(events);
ok(errors.length === 0, '正常会话通过 PM 语义审计', JSON.stringify(errors.slice(0, 3)));

{
  const copy = structuredClone(events);
  const rep = copy.find((event) => event.surfaceOp?.op === 'replace' && (event.data?.message?.source ?? event.data?.source)?.kind === 'pm-surface');
  rep.sourceEventSeqs = rep.sourceEventSeqs.slice(0, -1);
  const bad = verifyPmSemantics(copy);
  ok(bad.some((message) => message.includes('sourceEventSeqs')), '能抓到 sourceEventSeqs 缺节点', JSON.stringify(bad.slice(0, 2)));
}
{
  const copy = structuredClone(events);
  const rep = copy.find((event) => event.surfaceOp?.op === 'replace' && (event.data?.message?.source ?? event.data?.source)?.op === 'stabilize');
  rep.data.message.content = [];
  const bad = verifyPmSemantics(copy);
  ok(bad.some((message) => message.includes('content shape')), '能抓到替代内容与 op 不一致', JSON.stringify(bad.slice(0, 2)));
}
{
  const copy = structuredClone(events);
  copy.push({ type: 'plugin:plastic-memories/locks', seq: 999999, time: Date.now(), data: { op: 'lock', seqs: [999998] } });
  const bad = verifyPmSemantics(copy);
  ok(bad.some((message) => message.includes('not on the current surface')), '能抓到锁定非工作面 seq', JSON.stringify(bad.slice(0, 2)));
}

done();
