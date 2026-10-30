/**
 * PM · 工具注册、执行与参数校验。
 *
 * 运行：node integration.mjs
 */
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SystemPrompt from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime, { assertObjectJsonSchema, assertSupportedJsonSchema } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { fixture, makeCounter } from './testkit.mjs';
import { apply, name, inject } from './index.js';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('integration');

const ctx = new Context();
new SessionStore(ctx);
new SystemPrompt(ctx, {});
new ToolRuntime(ctx);

console.log(NL + '① 插件元数据 + 注册');
ok(name === 'plastic-memories-h0', 'name 正确');
ok(JSON.stringify(inject) === JSON.stringify(['tools']), 'inject = [tools]');
let applied = true;
try { apply(ctx, { trace: false }); } catch (e) { applied = false; console.log('    注册抛错:', e.message); }
ok(applied, 'apply() 无异常');

console.log(NL + '② 两个工具已注册且 schema 合法');
const NAMES = ['plasticize', 'retrospect', 'letter'];
const defs = new Map();
for (const n of NAMES) {
  const d = (() => { try { return ctx.tools.get(n); } catch { return undefined; } })();
  if (d !== undefined) defs.set(n, d);
}
ok(defs.size === 3, 'plasticize / retrospect / letter 都已注册', [...defs.keys()].join(', '));
for (const [n, d] of defs) {
  const shapeOk = typeof d.description === 'string' && d.description.length > 40
    && d.parameters?.type === 'object'
    && typeof d.output?.render === 'function'
    && typeof d.execute === 'function';
  ok(shapeOk, n + ' 形状合法（description / parameters / output.render / execute）');
}
ok(ctx.tools.get('pm_hide') === undefined, '旧的 pm_* 工具已不存在');

console.log(NL + '③ 旧工具名不再注册');
{
  for (const old of ['pm_hide', 'pm_stabilize', 'pm_rehydrate', 'pm_inspect', 'pm_status']) {
    ok(ctx.tools.get(old) === undefined, old + ' 已移除');
  }
}

console.log(NL + '④ 参数校验层（补回 defineTool 的行为）');
{
  const s = ctx.sessions.create('itest', { seed: fixture('subagent-95230f54.jsonl').filter((r) => r.type !== 'session') });
  const exec = { agent: { session: s }, callId: 'itest-call', name: 'plasticize', arguments: {}, signal: new AbortController().signal };
  const sync = (fn) => { try { const r = fn(); return r && typeof r.then === 'function' ? null : null; } catch (e) { return e.message; } };
  const d = defs.get('plasticize');
  const e1 = sync(() => d.execute({ ops: 'not-array', option: 'set' }, exec));
  ok(typeof e1 === 'string' && e1.includes('Invalid tool arguments'), '类型错误被 schema 层拦下', String(e1).slice(0, 70));
  const e2 = sync(() => d.execute({ ops: [] }, exec));
  ok(typeof e2 === 'string' && e2.includes('option'), '缺 option 被拦下', String(e2).slice(0, 70));
}

console.log(NL + '⑤ 非 agent 调用被拒绝');
{
  const d = defs.get('retrospect');
  let msg = null;
  try { d.execute({ generation: 0 }, {}); } catch (e) { msg = e.message; }
  ok(typeof msg === 'string' && msg.includes('agent'), '非 agent 调用抛错', String(msg).slice(0, 60));
}

console.log(NL + '⑥ option/also_execute_last_set 的组合约束');
{
  const s = ctx.sessions.create('itest2', { seed: fixture('subagent-95230f54.jsonl').filter((r) => r.type !== 'session') });
  s.append('turn/start', { turn: 2 });
  s.append('step/start', { turn: 2, step: 1 });
  const callId = 'c1';
  const args = { ops: [{ spans: ['this'], new_text: 'X' }], option: 'set' };
  s.append('assistant/message', {
    turn: 2, step: 1,
    message: { id: 'am', role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' }, content: [{ type: 'tool-call', id: callId, name: 'plasticize', arguments: JSON.stringify(args) }] },
    stream: [],
  }, { surfaceOp: 'append' });
  const exec = { agent: { session: s }, callId, name: 'plasticize', arguments: args, signal: new AbortController().signal };
  const d = defs.get('plasticize');
  let msg = null;
  try { d.execute({ ops: args.ops, option: 'set', also_execute_last_set: true }, exec); } catch (e) { msg = e.message; }
  ok(typeof msg === 'string' && msg.includes('also_execute_last_set'), 'set + also_execute_last_set 被拒绝', String(msg).slice(0, 70));
  let msg2 = null;
  try { d.execute({ ops: args.ops, option: 'bogus' }, exec); } catch (e) { msg2 = e.message; }
  ok(typeof msg2 === 'string' && msg2.includes('option'), '非法 option 被拒绝', String(msg2).slice(0, 60));
}

console.log(NL + '⑥b 用宿主的 assertSupportedJsonSchema 验一遍（权威判据）');
{
  // 之前只用手写白名单 —— 手写的名单可能与宿主不同步。
  // 宿主的子集是**封闭白名单**，不在其中的关键字会直接被拒绝：
  //   「Unsupported or misplaced keywords reject rather than being accepted without enforcement.」
  // 实测教训：加过 minItems/maxItems，被这条抓住。
  for (const [name, def] of defs) {
    let err;
    try { assertSupportedJsonSchema(def.parameters); } catch (e) { err = String(e.message); }
    ok(err === undefined, name + ' 的参数 schema 在宿主支持子集内', String(err));
  }
  let outErr;
  try { assertObjectJsonSchema(defs.get('plasticize').output.schema); } catch (e) { outErr = String(e.message); }
  ok(outErr === undefined, 'output schema 也在子集内（且 object 根）', String(outErr));
}

console.log(NL + '⑦ schema 关键字白名单（迁移 defineTool 的前置条件）');
{
  const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
  const collect = (node, path, bad) => {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) if (!ALLOWED.has(key)) bad.push(path + '.' + key);
    for (const [name, child] of Object.entries(node.properties ?? {})) collect(child, path + '.' + name, bad);
    if (node.items !== undefined) collect(node.items, path + '[]', bad);
    for (const [i, branch] of (node.oneOf ?? []).entries()) collect(branch, path + '|' + i, bad);
  };
  for (const [n, d] of defs) {
    const bad = [];
    collect(d.parameters, n, bad);
    collect(d.output.schema, n + '(output)', bad);
    ok(bad.length === 0, n + ' 只含白名单关键字', bad.join(', '));
  }
}

done();