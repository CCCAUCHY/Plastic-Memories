/**
 * PM · 契约测试（CONTRACT.md 的可执行版本）。
 *
 * 三层：
 *   A. 纯语法：选择器 / 命令文本 / op 归一化（不需要会话）
 *   B. 工具层：构造 JSON 参数直接调 execute
 *   C. 行为层：set→execute、空 ops、自动隐藏、安全区、持久化往返、世代
 *
 * 运行：node contract.mjs
 */
import { makeCounter, makeStore, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { apply } from './index.js';
import { parseUnitRange, isThisSelector } from './units.js';
import { normalizeOp, parseOpText, normalizeSelector } from './opshape.js';
import { parsePlasticizeCommand } from './commands.js';
import { flush, lockedSeqs, appendSafetyRecord } from './engine.js';
import { currentUnits } from './units.js';
import { initState, applyEvent, viewOf } from './generations.js';

const { ok, done } = makeCounter('contract');
const quiet = { warn() {}, info() {} };

/** 捕获一次错误消息；没抛错就返回 undefined。 */
function errorOf(fn) {
  try {
    fn();
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
}
async function asyncErrorOf(fn) {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

// ── 工具注册（复用 globaltest 的 stub ctx）──────────────────────────────────
const definitions = new Map();
const toolCtx = {
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined; },
  inject() {},
  effect(effect) { try { return effect(); } catch { return undefined; } },
  on() { return () => {}; },
  tools: { register(definition) { definitions.set(definition.name, definition); } },
};
apply(toolCtx, {});

/** 在打开的 step 里写下一条工具调用（assistant + tool/call + tool/result）。 */
function declare(session, at, id, name, args) {
  session.append('assistant/message', {
    turn: at.turn, step: at.step,
    message: {
      id: 'am-' + id, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: at.turn, step: at.step, callId: id, name, arguments: JSON.stringify(args) });
  session.append('tool/result', {
    turn: at.turn, step: at.step,
    message: {
      id: 'tr-' + id, role: 'tool', toolCallId: id,
      content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: id },
    },
  }, { surfaceOp: 'append' });
}

/** 调工具；返回 { text } 或 { error }。 */
async function callTool(name, args, session, id, declareFirst = true) {
  if (declareFirst) declare(session, { turn: 9, step: 1 }, id, name, args);
  try {
    const result = await definitions.get(name).execute(args, { agent: { session }, callId: id, name, arguments: args });
    return { text: String(result?.text ?? '') };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function freshSession(id) {
  const ctx = makeStore();
  const session = ctx.sessions.create(id, { seed: cookieSeed('subagent-95230f54.jsonl') });
  session.append('turn/start', { turn: 9 });
  session.append('step/start', { turn: 9, step: 1 });
  return session;
}

console.log('A 纯语法');

ok(JSON.stringify(parseUnitRange('unit 17')) === '[17]', 'unit 17 → [17]');
ok(JSON.stringify(parseUnitRange('unit 17 to 20')) === '[17,18,19,20]', 'unit 17 to 20 → 闭区间');
ok(JSON.stringify(parseUnitRange('unit 17 through 20')) === '[17,18,19,20]', 'through 同义');
ok(JSON.stringify(parseUnitRange(17)) === '[17]' && JSON.stringify(parseUnitRange('17')) === '[17]', '裸数字两种写法');
ok(JSON.stringify(parseUnitRange('unit 17:')) === '[17]', '尾随冒号可选');
for (const bad of ['[17,28]', '(17,20)', 'unit 20 to 17', '', 'unit', 'unit x']) {
  ok(errorOf(() => parseUnitRange(bad)) !== undefined, '拒绝非法选择器 ' + JSON.stringify(bad));
}
ok(errorOf(() => parseUnitRange('this')) !== undefined, 'parseUnitRange 拒绝 this（需调用方解析）');
ok(isThisSelector('this') && isThisSelector('this:') && !isThisSelector('unit 17'), 'isThisSelector 判定');

ok(parseOpText('unit 17 to 28: 摘要').positions === 'unit 17 to 28', '文本 → 单值 positions（区间）');
ok(parseOpText('unit 17: to be continued').new_text === 'to be continued', '冒号后以 to 开头的文本不被当区间');
ok(parseOpText('unit 17').new_text === '', '无冒号即纯隐藏');
ok(parseOpText('this: x').positions === 'this', 'this 在工具侧可用');
ok(errorOf(() => parseOpText('unit 17 文本'))?.includes('冒号') === true, '缺冒号时提示加冒号');
ok(errorOf(() => parseOpText('this: x', { allowThis: false }))?.includes('this') === true, 'allowThis:false 拒绝 this');

ok(JSON.stringify(normalizeOp({ positions: 'unit 1' }, 0)) === JSON.stringify({ positions: 'unit 1', new_text: '', lock_this: false }), 'normalizeOp 默认值');
ok(errorOf(() => normalizeOp({ spans: ['(1,2)'] }, 0))?.includes('unknown field') === true, 'spans 已不是合法字段');
ok(errorOf(() => normalizeOp({}, 0))?.includes('positions') === true, '缺 positions 报错');
ok(errorOf(() => normalizeOp({ positions: [] }, 0))?.includes('ONE selector') === true, '数组 positions 报错（现在是单值）');
ok(errorOf(() => normalizeOp({ positions: '' }, 0))?.includes('ONE selector') === true, '空字符串 positions 报错');
ok(errorOf(() => normalizeOp({ positions: 'unit 1', new_text: 1 }, 0))?.includes('new_text') === true, 'new_text 必须是字符串');
ok(errorOf(() => normalizeOp({ positions: 'unit 1', lock_this: 1 }, 0))?.includes('lock_this') === true, 'lock_this 必须是布尔');
ok(errorOf(() => normalizeOp({ positions: 'unit 1', types: ['user'] }, 0))?.includes('unknown field') === true, 'types 已删除（未知字段）');
ok(errorOf(() => normalizeSelector([])) !== undefined && normalizeSelector(undefined) === undefined, 'normalizeSelector 形状校验');

const cmd = (text) => parsePlasticizeCommand(text, 'zh');
ok(cmd('clear').action === 'clear', 'clear');
ok(cmd('prelock').mode === 'prelock', 'prelock');
ok(cmd('hide unit 3').kind === 'project' && cmd('hide unit 3').newText === '', 'hide 选择器');
ok(cmd('lock unit 3 to 7').kind === 'lock', 'lock 区间');
ok(cmd('unlock unit 3').kind === 'unlock', 'unlock');
ok(cmd('unlock all').mode === 'all', 'unlock all');
ok(cmd('unit 17: 新文本').newText === '新文本', '投影命令');
ok(errorOf(() => cmd('lock all')) !== undefined, 'lock all 已取消');
ok(errorOf(() => cmd('hide')) !== undefined, '缺选择器报错');
ok(errorOf(() => cmd('this: x'))?.includes('this') === true, '命令拒绝 this');
ok(errorOf(() => cmd('unit 17 缺冒号'))?.includes('冒号') === true, '命令缺冒号提示');

for (const sample of ['unit 17: 文本', 'unit 17 to 28: 文本', 'unit 17']) {
  const fromText = parseOpText(sample);
  const fromJson = normalizeOp({ positions: fromText.positions, new_text: fromText.new_text }, 0);
  ok(JSON.stringify(fromText) === JSON.stringify(fromJson), '命令文本 ≡ 同一个 op：' + sample);
}

console.log('B 工具层');

{
  const session = freshSession('contract-retro');
  const self = await callTool('retrospect', { generation: 'self' }, session, 'c-retro', false);
  const data = JSON.parse(self.text);
  ok(typeof data.logical === 'number' && Array.isArray(data.messages) && data.messages.length > 0, 'retrospect(self) 返回 messages');
  ok(data.messages[0].type === 'system' && data.messages[0].unit === 0, '0 号行是 system/unit 0');
  const contiguous = data.messages.every((row, index) => row.n === index);
  ok(contiguous, 'n 连续');
  const monotonic = data.messages.every((row, index) => index === 0 || row.unit >= data.messages[index - 1].unit);
  ok(monotonic, 'unit 单调不降');
  ok(Object.hasOwn(data, 'units') === false, '不再有 units 字段');

  const window = JSON.parse((await callTool('retrospect', { generation: 'self', result_positions: 'unit 1' }, session, 'c-window', false)).text);
  ok(window.count === 1 && window.messages[0].unit === 1 && window.total > 1 && JSON.stringify(window.units) === '[1]', 'result_positions 窗口');
  ok((await callTool('retrospect', { generation: 'self', result_positions: 'this' }, session, 'c-this', false)).error?.includes('this') === true, 'result_positions 拒绝 this');
  ok((await callTool('retrospect', { generation: 'self', result_positions: 'unit 999' }, session, 'c-oor', false)).error?.includes('out of range') === true, 'result_positions 越界报错');
  ok((await callTool('retrospect', { generation: 99 }, session, 'c-future', false)).error?.includes('future') === true, '未来世代报错');
  const history = JSON.parse((await callTool('retrospect', { generation: 0 }, session, 'c-g0', false)).text);
  ok(history.count > 0 && history.messages.every((row) => row.locked === undefined), '历史世代不含 locked');

  const letter = await callTool('letter', { text: 'note' }, session, 'c-letter');
  ok(letter.text.trim() === 'Registered.', 'letter 返回 Registered.');
}

{
  const session = freshSession('contract-plasticize');
  const set = await callTool('plasticize', { option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨X⟩' }], preview_positions: 'unit 2' }, session, 'p-set');
  ok(set.text.startsWith('Preview only') && set.text.includes('showing units'), 'set 预览带窗口说明');
  const emptySet = await callTool('plasticize', { option: 'set', ops: [] }, session, 'p-empty-set');
  ok(emptySet.error?.includes('at least one op') === true, 'set 传空 ops 报错', String(emptySet.error).slice(0, 50));
  const replayInSet = await callTool('plasticize', { option: 'set', ops: [{ 'the last plasticize(set)': true }] }, session, 'p-replay-set');
  ok(replayInSet.error?.includes('cannot replay') === true, 'set 不能重放上一条 set', String(replayInSet.error).slice(0, 50));
  const replayOk = await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, session, 'p-replay-ok');
  ok(replayOk.error === undefined && replayOk.text.includes('Registered'), 'execute 可以重放待决 set', String(replayOk.error ?? replayOk.text).slice(0, 50));
  const mixed = await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }, { positions: 'unit 1', new_text: 'Y' }] }, session, 'p-mixed');
  ok(mixed.error === undefined, '宏可以和普通 op 并存', String(mixed.error ?? '').slice(0, 60));
  const twoMacros = await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }, { 'the last plasticize(set)': true }] }, session, 'p-two-macros');
  ok(twoMacros.error?.includes('only once') === true, '宏只能出现一次', String(twoMacros.error).slice(0, 50));
  const withText = await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true, new_text: 'x' }] }, session, 'p-with-text');
  ok(withText.error !== undefined, '宏不能附带其它字段', String(withText.error).slice(0, 60));
}

console.log('C 行为层');

{
  const session = freshSession('contract-set-exec');
  const before = session.surface.replaceGeneration;
  await callTool('plasticize', { option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨SET⟩' }] }, session, 'b-set');
  await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, session, 'b-exec');
  const result = flush(session, { openStep: { turn: 9, step: 1 } }, quiet);
  ok(result.applied >= 1, '显式重放落地（兑现 set）', JSON.stringify(result));
  const replaces = session.snapshotEvents().filter((event) => event.surfaceOp?.op === 'replace');
  const explicit = replaces.filter((event) => event.data?.message?.source?.note === undefined);
  ok(explicit.length === 1, '只写一条显式 replace（其余是自动隐藏）', String(explicit.length) + '/' + String(replaces.length));
  ok(session.surface.replaceGeneration > before, '物理世代推进', String(session.surface.replaceGeneration));
  const text = currentUnits(session).map((unit) => unit.text).join('\n');
  ok(text.includes('⟨SET⟩'), '替代文本进入工作面');
}

{
  const session = freshSession('contract-empty-ops-none');
  const none = await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, session, 'n-exec');
  ok(none.error?.includes('no pending') === true, '无待决 set 时重放报错', String(none.error).slice(0, 60));}

{
  const session = freshSession('contract-safety');
  const target = currentUnits(session)[1];
  appendSafetyRecord(session, { op: 'lock', seqs: [target.seq], comment: 'contract' });
  ok(lockedSeqs(session).has(target.seq), '锁已写入');
  const hit = await callTool('plasticize', { option: 'set', ops: [{ positions: 'unit ' + target.n, new_text: 'X' }] }, session, 's-hit');
  ok(hit.error?.includes('safety zone') === true, '命中安全区报错', String(hit.error).slice(0, 60));
  const rows = JSON.parse((await callTool('retrospect', { generation: 'self' }, session, 's-self', false)).text);
  ok(rows.messages.some((row) => row.unit === target.n && row.locked === true), 'self 标出锁定单元');
}

{
  const session = freshSession('contract-reload');
  await callTool('plasticize', { option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨RELOAD⟩' }] }, session, 'r-set');
  await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, session, 'r-exec');
  flush(session, { openStep: { turn: 9, step: 1 } }, quiet);
  const events = JSON.parse(JSON.stringify(session.snapshotEvents())).filter((event) => event.type !== 'session');
  const ctx2 = makeStore();
  const reloaded = ctx2.sessions.create('contract-reload-2', { seed: events });
  ok(JSON.stringify([...reloaded.surface.nodes]) === JSON.stringify([...session.surface.nodes]), '重放后工作面一致');
  ok(reloaded.surface.replaceGeneration === session.surface.replaceGeneration, '重放后世代一致');
}

{
  const session = freshSession('contract-generations');
  await callTool('plasticize', { option: 'set', ops: [{ positions: 'unit 2', new_text: '⟨G⟩' }] }, session, 'g-set');
  await callTool('plasticize', { option: 'execute', ops: [{ 'the last plasticize(set)': true }] }, session, 'g-exec');
  flush(session, { openStep: { turn: 9, step: 1 } }, quiet);
  let state = initState();
  for (const event of session.snapshotEvents()) state = applyEvent(state, event);
  const view = viewOf(state);
  ok(view.current >= 1 && view.generations.length === view.current + 1, '物理页 = 初始页 + 每次 replace', JSON.stringify({ current: view.current, gens: view.generations.length }));
  ok(view.logicalLabels.length === 2, '一次 execute 只加一个逻辑世代', JSON.stringify(view.logicalLabels));
  ok(view.logicalLabels[0].logical === 0 && view.logicalLabels[0].physical === 0, '逻辑 0 指向物理 0');
  ok(view.logicalLabels[1].logical === 1, '逻辑 1 存在');
}

done();
