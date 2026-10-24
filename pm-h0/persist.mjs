/**
 * PM · 持久化往返测试（一次真实事故换来的）。
 *
 * 2026-10-05 的事故：插件在 step 之外写 developer/message 空洞，
 * 读侧以 does not match an open turn and step 拒绝整份日志 ——
 * **写的时候不报错，重新加载才炸**。
 *
 * 四套内存断言全绿也抓不到，因为校验只发生在**读**的时候。这一套补的就是那一环：
 * 基座用**真实会话日志**，跑真实 flush，再用**宿主的 released-v4 校验器**验。
 *
 * 运行：node persist.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore, { KNOWN_SESSION_EVENT_TYPES } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { assertReleasedV4Relationships } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
import { makeCounter, fixture, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('persist');
const quiet = { warn: () => {}, info: () => {} };

const records = fixture('subagent-95230f54.jsonl');
const header = (() => { const h = { ...records.find((r) => r.type === 'session') }; delete h.type; return h; })();

let n = 0;
const mk = () => {
  const ctx = new Context();
  new SessionStore(ctx);
  return ctx.sessions.create('persist-' + (++n), { seed: cookieSeed('subagent-95230f54.jsonl') });
};
const validate = (s) => {
  const artifact = { header, events: JSON.parse(JSON.stringify(s.snapshotEvents())), inheritedEventCount: 0 };
  try {
    assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const holes = (s) => s.snapshotEvents().filter((e) => e.type === 'developer/message');
const ALL = '(1,10)';   // cookie1..cookie10 之间 = system 之外的全部历史

console.log(NL + '⓪ 基座：真实会话日志必须合法');
{
  const s = mk();
  ok(validate(s) === undefined, 'seed 后通过 released-v4 校验', String(validate(s)));
  ok(s.seq > 30, '日志足够长（' + s.seq + ' 条事件）');
}

console.log(NL + '① 边界不知道打开的 step 时，纯空洞必须**推迟**，绝不写');
{
  const s = mk();
  openStep(s, 2, 1);
  // 声明本身是合法的（在打开的 step 里），但边界调用**不给** openStep ——
  // 复刻事故处境：此刻插件不知道哪个 turn/step 开着，就不能猜。
  const args = { ops: [{ spans: [ALL], new_text: '' }], option: 'execute' };
  plasticizeCall(s, { turn: 2, step: 1 }, 'h1', args);
  const r = flush(s, { openStep: undefined }, quiet);
  ok(holes(s).length === 0, '没有写出 developer/message 空洞', String(holes(s).length));
  ok(r.applied === 0 || r.skipped >= 1, 'flush 报告了未落地', JSON.stringify(r));
  ok(validate(s) === undefined, '有没有写出东西，日志都仍然合法', String(validate(s)));
}

console.log(NL + '② 有打开的 step 时，空洞落在**当前** turn/step 上，且写盘后仍合法');
{
  const s = mk();
  openStep(s, 2, 1);
  const args = { ops: [{ spans: [ALL], new_text: '' }], option: 'execute' };
  plasticizeCall(s, { turn: 2, step: 1 }, 'h2', args);
  const r = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  const hs = holes(s);
  ok(hs.length === 1, '写出了 1 条空洞', String(hs.length) + ' | ' + JSON.stringify(r));
  if (hs.length === 1) {
    ok(hs[0].data.turn === 2 && hs[0].data.step === 1,
      '空洞用的是**当前** turn/step（不是声明发出时的旧值）',
      'turn' + hs[0].data.turn + '/step' + hs[0].data.step);
  }
  const err = validate(s);
  ok(err === undefined, '**写盘后用宿主校验器重新加载：通过**（事故当天缺的就是这一步）', String(err));
}

console.log(NL + '③ 推迟后能在下一个边界补上（不会永久丢）');
{
  const s = mk();
  openStep(s, 2, 1);
  const args = { ops: [{ spans: [ALL], new_text: '' }], option: 'execute' };
  plasticizeCall(s, { turn: 2, step: 1 }, 'h3', args);
  // 第一次 flush **不给 openStep** —— 模拟「此刻没有打开的 step」
  flush(s, { openStep: undefined }, quiet);
  ok(holes(s).length === 0, '第一拍（无 openStep）推迟');
  // 第二次给上 —— 同一个 step 仍然开着
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(holes(s).length === 1, '第二拍补上', String(holes(s).length));
  ok(validate(s) === undefined, '补上后日志合法', String(validate(s)));
}

console.log(NL + '④ 幂等：重复 flush 不重复写空洞');
{
  const s = mk();
  openStep(s, 2, 1);
  const args = { ops: [{ spans: [ALL], new_text: '' }], option: 'execute' };
  plasticizeCall(s, { turn: 2, step: 1 }, 'h4', args);
  flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  const n1 = holes(s).length;
  const r2 = flush(s, { openStep: { turn: 2, step: 1 } }, quiet);
  ok(n1 === 1 && holes(s).length === 1, '不重复写空洞', n1 + ' -> ' + holes(s).length);
  ok(r2.applied === 0, '第二次 applied = 0', JSON.stringify(r2));
  ok(validate(s) === undefined, '日志合法', String(validate(s)));
}

console.log(NL + '⑤ 真实 PTC 会话（含历史投影）本身必须合法');
{
  const ptc = fixture('session-ptc-stabilized.jsonl');
  const h2 = (() => { const h = { ...ptc.find((r) => r.type === 'session') }; delete h.type; return h; })();
  const art = { header: h2, events: ptc.filter((r) => r.type !== 'session'), inheritedEventCount: 0 };
  let err;
  try { assertReleasedV4Relationships(art, KNOWN_SESSION_EVENT_TYPES); } catch (e) { err = String(e.message); }
  ok(err === undefined, 'pm preset 的真实会话通过校验', String(err));
  const reps = ptc.filter((r) => r.surfaceOp?.op === 'replace').length;
  ok(reps === 2, '其中含 2 条真实 replace 投影', String(reps));
}

done();
