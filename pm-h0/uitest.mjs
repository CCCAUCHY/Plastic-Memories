/**
 * UI 半身的离线测试。
 *
 * 三件事：
 *   1. 世代 fold 与 dsh-session 的 surface fold **逐节点一致**（用真实夹具交叉验证）；
 *   2. 每次投影产生一代快照，wire 值能还原每一代的 seq 列表与正文；
 *   3. 客户端 bundle / 命令解析的基本形状（语法、字段、错误提示）。
 *
 * 运行：node uitest.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initState, applyEvent, viewOf, describeEvent, GENERATIONS_KEY } from './generations.js';
import { parsePlasticizeCommand } from './commands.js';
import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SessionProjectionRegistry from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import { generationProjection } from './generations.js';
import { flush } from './engine.js';
import { makeCounter, makeStore, seeded, cookieSession, openStep, plasticizeCall } from './testkit.mjs';

const NL = String.fromCharCode(10);
const { ok, done } = makeCounter('ui');

/**
 * 把一份会话日志 fold 成世代状态。
 * @param {object} session - 目标会话。
 * @returns {object} 投影状态。
 */
function foldSession(session) {
  let state = initState();
  for (const event of session.snapshotEvents()) state = applyEvent(state, event);
  return state;
}

console.log(NL + '① 世代 fold 与宿主 surface fold 逐节点一致（真实夹具交叉验证）');
{
  const ctx = makeStore();
  const session = seeded(ctx, 'ui-fold', 'session-ptc-stabilized.jsonl');
  const state = foldSession(session);
  ok(JSON.stringify(state.seqs) === JSON.stringify([...session.surface.nodes]),
    '节点序列与 session.surface.nodes 完全一致',
    state.seqs.length + ' vs ' + session.surface.nodes.length);
  ok(state.gen === session.surface.replaceGeneration,
    '世代号与 replaceGeneration 一致', state.gen + ' vs ' + session.surface.replaceGeneration);
  const lastSurface = session.snapshotEvents().filter((e) => e.surfaceOp !== undefined).at(-1);
  ok(state.asOfSeq === lastSurface.seq, 'asOfSeq 是最后一条工作面事件的 seq', state.asOfSeq + ' vs ' + lastSurface.seq);
}

console.log(NL + '② 一次投影 = 一代快照；wire 值能还原每一代');
{
  const ctx = makeStore();
  const session = cookieSession(ctx, 'ui-gen');
  const before = foldSession(session);

  openStep(session, 2, 1);
  plasticizeCall(session, { turn: 2, step: 1 }, 'ui-exec', {
    ops: [{ spans: ['(5,6)'], new_text: '⟨UI 测试投影⟩' }],
    option: 'execute',
  });
  // 第 0 代 = 投影**写入前**的工作面 —— 它包含这次 plasticize 调用自己的两步。
  const nodesBeforeFlush = [...session.surface.nodes];
  flush(session, { openStep: { turn: 2, step: 1 } });

  const after = foldSession(session);
  ok(after.gen === before.gen + 1, '投影后世代号 +1', before.gen + ' -> ' + after.gen);
  const view = viewOf(after);
  ok(view.current === after.gen, 'wire.current == 最新世代', String(view.current));
  ok(view.generations.length === after.gen + 1, '每代一个快照（含第 0 代）', String(view.generations.length));
  ok(JSON.stringify(view.generations[0].seqs) === JSON.stringify(nodesBeforeFlush),
    '第 0 代 = 投影前的工作面（含触发它的调用步骤）');
  ok(JSON.stringify(view.generations[view.generations.length - 1].seqs) === JSON.stringify(after.seqs),
    '最新一代 = 当前工作面');
  ok(JSON.stringify(view.generations.map((g) => g.seqs)) === JSON.stringify(JSON.parse(JSON.stringify(view.generations.map((g) => g.seqs)))),
    'wire 值可 JSON 往返');
  ok(Array.isArray(view.raw) && view.raw.length === nodesBeforeFlush.length,
    'raw = 投影前的全部 append 节点（遮罩的原料）', String(view.raw?.length) + ' vs ' + nodesBeforeFlush.length);
  ok(Array.isArray(view.replacements) && view.replacements.length === after.gen,
    '每次替换都记在 replacements 里（客户端据此叠遮罩）', String(view.replacements?.length));
  ok(view.replacements[view.replacements.length - 1].shadowed.length >= 1
    && view.raw.includes(view.replacements[view.replacements.length - 1].repl) === false,
    '替换节点不在 raw 里（raw 只收 append）', JSON.stringify(view.replacements[view.replacements.length - 1].shadowed));

  const projectedSeq = after.seqs.find((seq) => view.meta[String(seq)]?.projected === true);
  ok(projectedSeq !== undefined, '投影节点带 projected 标记', String(projectedSeq));
  ok(String(view.meta[String(projectedSeq)].text).includes('⟨UI 测试投影⟩'), '投影节点的正文是新文本');
  const replaceEvent = session.snapshotEvents().filter((e) => e.surfaceOp !== undefined && typeof e.surfaceOp === 'object').at(-1);
  const shadowed = Array.isArray(replaceEvent?.sourceEventSeqs) ? replaceEvent.sourceEventSeqs.length : 1;
  ok(after.seqs.length === nodesBeforeFlush.length - shadowed + 1,
    '替换是原位的（被遮 N 条 → 1 条替代）', nodesBeforeFlush.length + ' - ' + shadowed + ' + 1 = ' + after.seqs.length);
}

console.log(NL + '③ 节点摘要：角色 / 工具调用 / 隐藏空洞');
{
  const ctx = makeStore();
  const session = seeded(ctx, 'ui-meta', 'subagent-95230f54.jsonl');
  const events = session.snapshotEvents();
  const assistant = events.find((e) => e.type === 'assistant/message'
    && Array.isArray(e.data?.message?.content)
    && e.data.message.content.some((b) => b.type === 'tool-call'));
  if (assistant !== undefined) {
    const node = describeEvent(assistant);
    ok(node.role === 'assistant', 'assistant 节点角色正确', String(node.role));
    ok(Array.isArray(node.calls) && node.calls.length > 0, '工具调用被提取', JSON.stringify(node.calls?.length));
  } else {
    ok(true, '夹具里没有带工具调用的 assistant（跳过）');
    ok(true, '夹具里没有带工具调用的 assistant（跳过）');
  }
  const user = events.find((e) => e.type === 'user/message');
  if (user !== undefined) {
    const node = describeEvent(user);
    ok(node.role === 'user' && String(node.text).length > 0, 'user 节点有正文', String(node.text.slice(0, 20)));
  }
  const hole = { type: 'developer/message', seq: 999, surfaceOp: 'append', data: { message: { id: 'h', role: 'developer', content: [], source: { kind: 'pm-surface', v: 1, op: 'hide', generation: 2, refs: [1, 2, 3] } } } };
  const holeNode = describeEvent(hole);
  ok(holeNode.hidden === true, '空内容的 developer 消息标记为隐藏节点');
  ok(holeNode.hiddenCount === 3, '隐藏节点记录被遮条数', String(holeNode.hiddenCount));
  ok(holeNode.projected === true, '隐藏节点属于 PM 投影');
}

console.log(NL + '④ 客户端 bundle 与命令解析');
{
  const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
  let checkError;
  try {
    execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' });
  } catch (error) {
    checkError = String(error?.stderr ?? error?.message ?? error).slice(0, 300);
  }
  ok(checkError === undefined, 'client.js 语法通过 node --check', checkError);

  const parsed = parsePlasticizeCommand('(1,2) 替代文本');
  ok(parsed.kind === 'project' && parsed.interval === '(1,2)', 'parsePlasticizeCommand：区间 + 文本');
  ok(parsed.newText === '替代文本', '替代文本原样读取');
  ok(parsePlasticizeCommand('(1,2) 第一行\n第二行').newText === '第一行\n第二行', '替代文本可以含换行');
  ok(parsePlasticizeCommand('hide [3,4]').kind === 'project' && parsePlasticizeCommand('hide [3,4]').newText === '', 'hide <区间>');
  ok(parsePlasticizeCommand('lock [3,4]').kind === 'lock', 'lock <区间>');
  ok(parsePlasticizeCommand('unlock [3,4]').kind === 'unlock', 'unlock <区间>');
  let bad;
  try { parsePlasticizeCommand('(1,2)'); } catch (error) { bad = String(error.message); }
  ok(typeof bad === 'string' && bad.includes('/plasticize'), '缺少替代文本给出用法提示', bad?.slice(0, 60));
  let hideBad;
  try { parsePlasticizeCommand('hide'); } catch (error) { hideBad = String(error.message); }
  ok(typeof hideBad === 'string' && hideBad.includes('hide'), 'hide 缺区间报错', hideBad?.slice(0, 60));
  ok(GENERATIONS_KEY === 'pmGenerations', '投影键与客户端读取键一致', GENERATIONS_KEY);
}


console.log(NL + '⑤ 客户端 bundle：私有化官方轨迹（vendored）+ glue');
{
  const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
  const source = readFileSync(clientPath, 'utf8');
  const records = [];
  const fakeWindow = { __ModuleLoader__: { load(value) { records.push(value); } } };
  const fakeReact = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect(effect) { effect(); },
    useMemo(factory) { return factory(); },
  };
  let factoryError;
  try { new Function('window', source)(fakeWindow); } catch (error) { factoryError = error; }
  ok(factoryError === undefined, 'client.js 作为加载器脚本可执行', String(factoryError?.message).slice(0, 120));
  ok(source.length > 300000, 'client.js 内含完整官方轨迹 bundle（>300KB）', String(source.length));
  const vendor = records.find((record) => record.id === 'pm-trajectory-vendor');
  const plugin = records.find((record) => record.id === 'dsh-plugin-plastic-memories-h0');
  ok(records.length === 2 && vendor !== undefined && plugin !== undefined,
    '同一文件注册 vendor 与插件两个模块', JSON.stringify(records.map((record) => record.id)));
  ok(typeof vendor?.factory === 'function' && typeof plugin?.factory === 'function', '两个模块都注册了 lazy factory');

  // 私有化改名（不执行 vendor factory，只做静态断言）。
  const checks = [
    ['target 改名', 'target: "pmTrajectory"'],
    ['hook 改名', 'hooks: ["pmTrajectory"]'],
    ['事件定义 kind 改名', 'kind: "pmtrajectory-'],
    ['图片 slot 改名', 'pmTrajectory.images'],
    ['视图 id 改名', 'id: "pm-generations"'],
    ['视图 order', 'order: 9000,'],
    ['tab 标签 = 世代', '"view.trajectory": "世代"'],
  ];
  for (const [label, needle] of checks) ok(source.includes(needle), label + '（' + needle + '）');

  const forbidden = [
    '@deepseek-ai/dsh-client-ui-trajectory',
    'target: "trajectory"',
    'id: "trajectory"',
    'conversation.trajectory.images',
    'useTrajectory',
    'kind: "trajectory-',
  ];
  const leftovers = forbidden.filter((needle) => source.includes(needle));
  ok(leftovers.length === 0, '官方身份没有残留（可与官方轨迹并存）', leftovers.join(', '));

  // glue：factory 只 require vendor，并在 apply 时调用 vendor.apply。
  const calls = [];
  const requireStub = (specifier) => {
    if (specifier === 'react') return fakeReact;
    if (specifier === 'pm-trajectory-vendor') return { inject: ['slots', 'uiConversation'], apply: (ctx) => calls.push(ctx) };
    throw new Error('glue 不应 require ' + specifier);
  };
  let glue;
  try { glue = plugin.factory(requireStub); } catch (error) { glue = { __error: error }; }
  ok(glue.__error === undefined, 'glue 工厂可物化', String(glue.__error?.message).slice(0, 120));
  ok(JSON.stringify(glue.inject) === JSON.stringify(['slots', 'uiConversation']), 'glue 继承 vendor 的 inject', JSON.stringify(glue.inject));
  const fakeCtx = { marker: true };
  glue.apply(fakeCtx);
  ok(calls.length === 1 && calls[0] === fakeCtx, 'glue.apply 调用 vendor.apply(ctx)');

  // ── PM 图层：__PM_UI__ bridge（世代选择 + 事件级过滤）────────────────────
  const bridge = globalThis.__PM_UI__;
  ok(bridge !== undefined
    && typeof bridge.isHiddenEvent === 'function'
    && typeof bridge.wrapDefinition === 'function'
    && typeof bridge.installReregister === 'function'
    && typeof bridge.pagination === 'function',
    'glue 暴露 __PM_UI__ bridge（isHiddenEvent / wrapDefinition / installReregister / pagination）');

  const pmData = {
    current: 1,
    asOfSeq: 6,
    raw: [1, 2, 3, 4, 5],
    meta: {
      '1': { seq: 1, role: 'system', type: 'system/message', text: 'system prompt' },
      '2': { seq: 2, role: 'user', type: 'user/message', text: '用户' },
      '4': { seq: 4, role: 'assistant', type: 'assistant/message', text: '', calls: [{ name: 'bash', arguments: '{}', id: 'call-hidden' }] },
      '5': { seq: 5, role: 'tool', type: 'tool/result', text: '输出', toolCallId: 'call-hidden' },
      '6': { seq: 6, role: 'user', type: 'user/message', text: '⟨折叠结论⟩', projected: true },
    },
    generations: [
      { gen: 0, asOfSeq: 5, seqs: [1, 2, 3, 4, 5] },
      { gen: 1, asOfSeq: 6, seqs: [1, 2, 3, 6] },
    ],
    replacements: [{ gen: 1, shadowed: [4, 5], repl: 6 }],
  };
  ok(bridge.isHiddenEvent({ seq: 4, data: {} }) === false, '还没有世代数据时不隐藏任何事件');
  bridge.publish('sess', pmData);
  ok(bridge.isHiddenEvent({ seq: 4, data: {} }) === true, '最新世代：被遮蔽的 seq 不进入官方装配');
  ok(bridge.isHiddenEvent({ seq: 5, data: {} }) === true, '最新世代：被遮蔽的 tool/result 同样不进入装配');
  ok(bridge.isHiddenEvent({ seq: 2, data: {} }) === false, '最新世代：可见节点照常进入装配');
  ok(bridge.isHiddenEvent({ seq: 99, data: { callId: 'call-hidden' } }) === true,
    '隐藏 assistant 的 callId 会连带隐藏 tool/call / PTC 分发事件（即使 seq 不在 surface 上）');
  bridge.setGeneration(0);
  ok(bridge.isHiddenEvent({ seq: 6, data: {} }) === true, '历史世代：世代之后才出现的事件不进入装配');
  ok(bridge.isHiddenEvent({ seq: 4, data: {} }) === false, '历史世代：当时还可见的节点照常保留');
  let reregisterCount = 0;
  bridge.installReregister(() => { reregisterCount += 1; });
  bridge.setGeneration(1);
  ok(reregisterCount === 1, '切世代触发一次定义重注册（官方装配器按新世代重建）', String(reregisterCount));
  bridge.publish('sess', { ...pmData, current: 1, replacements: [...pmData.replacements] });
  ok(reregisterCount === 1, '投影没变（指纹相同）时不重复重注册', String(reregisterCount));

  let matchedFunctionDefinition = 0;
  const functionDefinition = bridge.wrapDefinition({
    kind: 'pm-test',
    match: (event) => { matchedFunctionDefinition += 1; return { id: event.seq }; },
  });
  ok(functionDefinition.match({ seq: 4, data: {} }) === null && matchedFunctionDefinition === 0,
    'wrapDefinition：match 函数命中隐藏事件时返回 null（不调用官方 match）');
  ok(JSON.stringify(functionDefinition.match({ seq: 2, data: {} })) === JSON.stringify({ id: 2 }),
    'wrapDefinition：可见事件原样交给官方 match');
  const tableDefinition = bridge.wrapDefinition({
    kind: 'pm-test-table',
    match: { 'assistant/message': (event) => ({ id: event.seq }) },
  });
  ok(tableDefinition.match['assistant/message']({ seq: 4, data: {} }) === null
    && JSON.stringify(tableDefinition.match['assistant/message']({ seq: 2, data: {} })) === JSON.stringify({ id: 2 }),
    'wrapDefinition：match 表形态同样过滤');

  // ── 相邻世代差异（已塑形）────────────────────────────────────────────────
  bridge.setGeneration(null);
  ok(typeof bridge.wrapTargetSource === 'function' && typeof bridge.installOfficialView === 'function' && typeof bridge.publishViewContext === 'function',
    'bridge 暴露缓存/内嵌视图接口（wrapTargetSource / installOfficialView / publishViewContext）');
  // 快照缓存：历史世代只让官方 target 装配一次；最新（live）世代不缓存。
  let delegateCalls = 0;
  const delegate = { getSnapshot: () => { delegateCalls += 1; return { eventNodes: [], eventLocations: new Map(), requests: [] }; }, subscribe: () => () => {} };
  const cachedSource = bridge.wrapTargetSource('sess', delegate);
  bridge.publish('sess', { ...pmData, current: 1, generations: [{ gen: 0, asOfSeq: 5, seqs: [1, 2, 3, 4, 5] }, { gen: 1, asOfSeq: 6, seqs: [1, 2, 3, 6] }] });
  bridge.setGeneration(0);
  cachedSource.getSnapshot();
  cachedSource.getSnapshot();
  ok(delegateCalls === 1, '历史世代快照命中缓存（官方 target 只装配一次）', String(delegateCalls));
  bridge.setGeneration(null);
  cachedSource.getSnapshot();
  cachedSource.getSnapshot();
  ok(delegateCalls === 3, '最新（live）世代不缓存，每次读都走官方实时快照', String(delegateCalls));
  // 内嵌视图模式：已塑形标签存在但不可点击。
  const embeddedT = (key) => key;
  embeddedT.__pmEmbedded = true;
  const pmData2 = {
    current: 2,
    asOfSeq: 9,
    raw: [1, 2, 3, 4, 5, 6, 7, 8],
    meta: {
      '4': { seq: 4, role: 'assistant', calls: [{ name: 'bash', arguments: '{}', id: 'c1' }] },
      '5': { seq: 5, role: 'tool', toolCallId: 'c1', text: 'ok' },
      '6': { seq: 6, role: 'user', text: '⟨第1代⟩', projected: true },
      '7': { seq: 7, role: 'user', text: '原始' },
      '8': { seq: 8, role: 'user', text: '⟨第2代⟩', projected: true },
    },
    generations: [
      { gen: 0, asOfSeq: 5, seqs: [1, 2, 3, 4, 5] },
      { gen: 1, asOfSeq: 7, seqs: [1, 2, 3, 6, 7] },
      { gen: 2, asOfSeq: 9, seqs: [1, 2, 3, 6, 8] },
    ],
    replacements: [{ gen: 1, shadowed: [4, 5], repl: 6 }, { gen: 2, shadowed: [7], repl: 8 }],
  };
  bridge.publish('sess', pmData2);
  bridge.setGeneration(null);
  ok(bridge.isReshapedCell({ sourceSeq: 8 }) === true, '主视图：第 2 代替代消息是已塑形');
  ok(bridge.reshapeTagLabel({ sourceSeq: 6 }, embeddedT) === null, '内嵌模式不渲染差异标签');
  const embeddedTag = bridge.reshapeTagLabel({ sourceSeq: 6 }, embeddedT);
  ok(embeddedTag === null, '内嵌模式不渲染已塑形标签（B 形态已下线）', String(embeddedTag));
  ok(bridge.reshapeTagLabel({ sourceSeq: 8 })?.type !== 'span', '主视图里的已塑形是折叠按钮组件');
  ok(bridge.pagination(embeddedT) === null, '内嵌视图隐藏世代选择条');
  ok(typeof bridge.prepareSnapshot === 'function', 'bridge 暴露按需装配接口 prepareSnapshot');
  // 缓存缺失时按需装配一次，之后同一世代直接命中缓存。
  bridge.publishViewContext({ sessionId: 'prepare-sess', t: (key) => key, hooks: {} });
  let prepareCalls = 0;
  const prepareDelegate = { getSnapshot: () => { prepareCalls += 1; return { eventNodes: [], eventLocations: new Map(), requests: [] }; }, subscribe: () => () => {} };
  bridge.wrapTargetSource('prepare-sess', prepareDelegate);
  bridge.publish('prepare-sess', pmData);
  bridge.setGeneration(null);
  bridge.prepareSnapshot(0);
  ok(prepareCalls === 1, '缓存缺失时按需装配一次', String(prepareCalls));
  bridge.setGeneration(0);
  bridge.wrapTargetSource('prepare-sess', prepareDelegate).getSnapshot();
  ok(prepareCalls === 1, '按需装配后该世代命中缓存（不再装配）', String(prepareCalls));
  // 差异标记：替代侧（本代）与被替代侧（上一代）都带粉色「已塑形」。
  bridge.publish('sess', pmData2);
  bridge.setGeneration(null);
  ok(bridge.isReshapedCell({ sourceSeq: 8 }) === true, '本代替代消息带差异标记');
  bridge.setGeneration(1);
  ok(bridge.diffNativeTag({ sourceSeq: 7 }, undefined) !== null, '上一代里即将被覆盖的消息带差异标记');
  bridge.setGeneration(null);
  bridge.publish('sess', pmData);
  bridge.setGeneration(null);
  bridge.publish('sess', pmData);
  bridge.setGeneration(null);
  bridge.publishViewContext({ sessionId: 'sess', t: (key) => key, hooks: {} });
  bridge.publish('sess', pmData);
  bridge.publish('sess', pmData);
  bridge.setGeneration(null);
  ok(bridge.isReshapedCell({ sourceSeq: 6 }) === true, '本代替代消息被识别为「已塑形」');
  ok(bridge.isReshapedCell({ sourceSeq: 4 }) === false, '被覆盖的上一代节点不是「已塑形」标签');
  const covered = bridge.coveredNodesOf({ sourceSeq: 6 });
  ok(covered.length === 2 && covered[0].seq === 4 && covered[1].seq === 5,
    '覆盖范围 = 上一代被替换的 2 条消息（按 seq 升序）', JSON.stringify(covered.map((row) => row.seq)));
  const tagElement = bridge.reshapeTagLabel({ sourceSeq: 6 });
  ok(tagElement !== null && tagElement !== undefined && tagElement.type !== undefined,
    '「已塑形」标签返回差异标记元素');
  ok(bridge.reshapeTagLabel({ sourceSeq: 4 }) === null, '普通记录不渲染折叠按钮');
  bridge.setGeneration(0);
  ok(typeof bridge.isReshapedCell === 'function', '差异识别接口保持可用（展示层只渲染被塑形）');
  bridge.setGeneration(null);
  ok(source.includes('pm-diff-badge') && source.includes('pm-diff-badge-reshaping') && source.includes('pm.hidden'),
    'client.js 内含差异徽标（已塑形/被塑形）与本地化「已隐藏」');

  bridge.setGeneration(null);
  const pagerElement = bridge.pagination((key) => key);
  ok(pagerElement !== null && pagerElement !== undefined && typeof pagerElement.type === 'function',
    'pagination(t) 返回世代选择组件元素');
  const pagerTree = pagerElement.type(pagerElement.props);
  const pagerButtons = [];
  const walkPager = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const item of node) walkPager(item); return; }
    if (typeof node !== 'object') return;
    if (typeof node.type === 'function') { walkPager(node.type(node.props)); return; }
    if (node.type === 'button') pagerButtons.push({ label: (node.children ?? []).flat(99).join(''), className: node.props?.className ?? '' });
    walkPager(node.children);
    walkPager(node.props?.children);
  };
  walkPager(pagerTree);
  ok(pagerButtons.length === 2, '两代时按钮 = 首代 0 + 末代 1', JSON.stringify(pagerButtons));
  ok(pagerButtons[0]?.label === '0' && pagerButtons[1]?.label === '1' && pagerButtons[1]?.className.includes('pm-pgs-current'),
    '按钮显示世代号 0/1，当前世代高亮', JSON.stringify(pagerButtons));
}

console.log(NL + '⑥ 投影单元真的能被 host 注册表驱动并发布 wire 值');
{
  const ctx = new Context();
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  const dispose = ctx.sessionProjections.register(generationProjection());
  const session = cookieSession(ctx, 'ui-proj');
  const snapshot = ctx.sessionProjections.snapshot(session);
  ok(Array.isArray(Object.keys(snapshot.values)) && snapshot.values.pmGenerations !== undefined,
    '快照里出现 pmGenerations（客户端 useProjection 读的就是它）', JSON.stringify(Object.keys(snapshot.values)));
  const value = snapshot.values.pmGenerations;
  ok(value.current === session.surface.replaceGeneration, 'wire.current == 宿主世代号', String(value.current));
  ok(Array.isArray(value.generations) && value.generations.length === value.current + 1,
    '每代一份快照', String(value.generations?.length));
  ok(Object.keys(value.meta).length === session.surface.nodes.length,
    '正文表覆盖当前工作面全部节点', Object.keys(value.meta).length + ' vs ' + session.surface.nodes.length);

  openStep(session, 2, 1);
  plasticizeCall(session, { turn: 2, step: 1 }, 'ui-proj-exec', {
    ops: [{ spans: ['(5,6)'], new_text: '⟨投影后的世代⟩' }],
    option: 'execute',
  });
  flush(session, { openStep: { turn: 2, step: 1 } });
  const after = ctx.sessionProjections.snapshot(session).values.pmGenerations;
  ok(after.current === value.current + 1, '投影后 wire.current +1', value.current + ' -> ' + after.current);
  const latest = after.generations[after.generations.length - 1];
  ok(latest.seqs.some((seq) => String(after.meta[String(seq)]?.text ?? '').includes('⟨投影后的世代⟩')),
    '最新一代里有替代文本');

  dispose();
  const gone = ctx.sessionProjections.snapshot(session).values;
  ok(gone.pmGenerations === undefined, '注销后键消失（能力缺席，而不是脏数据）', JSON.stringify(Object.keys(gone)));
}

done();