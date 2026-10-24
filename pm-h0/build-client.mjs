/**
 * 生成 client.js：私有化官方轨迹 bundle（trajectory-vendor.js）+ 打 PM 世代图层补丁 + glue。
 *
 * 每条补丁都必须命中，否则抛错 —— 不允许静默生成半成品。
 * 升级 DSH 时：重新复制 trajectory-vendor.js → node build-client.mjs。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { applyExtraPatches } from './client-patches.js';

const here = new URL('.', import.meta.url);
const vendor = readFileSync(new URL('./trajectory-vendor.js', here), 'utf8');

/** 简单补丁：[描述, 查找, 替换, 最少命中次数]。 */
const simplePatches = [
  ['loader id', 'id: "@deepseek-ai/dsh-client-ui-trajectory"', 'id: "pm-trajectory-vendor"', 1],
  ['package name leftovers', '@deepseek-ai/dsh-client-ui-trajectory', 'pm-trajectory-vendor', 1],
  ['locale NS', 'const NS = "trajectory";', 'const NS = "pm-trajectory";', 1],
  ['tab label zh', '"view.trajectory": "轨迹"', '"view.trajectory": "世代"', 1],
  ['tab label en', '"view.trajectory": "Trajectory"', '"view.trajectory": "Generations"', 1],
  ['target id', 'target: "trajectory"', 'target: "pmTrajectory"', 9],
  ['target lookup', '.target("trajectory")', '.target("pmTrajectory")', 2],
  ['view request', 'viewRequest?.view === "trajectory"', 'viewRequest?.view === "pm-generations"', 1],
  ['provider hook name', 'hooks: ["trajectory"]', 'hooks: ["pmTrajectory"]', 1],
  ['provider hook key', 'hooks: { trajectory: trajectorySource(binding) }', 'hooks: { pmTrajectory: trajectorySource(binding) }', 1],
  ['component hook prop', 'useTrajectory', 'usePmTrajectory', 2],
  ['images slot', 'conversation.trajectory.images', 'pmTrajectory.images', 3],
  ['view id', 'id: "trajectory",', 'id: "pm-generations",', 1],
];

let patched = vendor;
for (const [label, find, replace, minimum] of simplePatches) {
  const count = patched.split(find).length - 1;
  if (count < minimum) {
    throw new Error('patch "' + label + '" matched ' + count + ' times (< ' + minimum + '); upstream changed, re-copy trajectory-vendor.js');
  }
  patched = patched.split(find).join(replace);
}

/** 替换一次（必须恰好命中 1 次）。 */
function replaceOnce(text, find, replacement, label) {
  const count = text.split(find).length - 1;
  if (count !== 1) throw new Error('patch "' + label + '" matched ' + count + ' times (expected 1); upstream changed');
  return text.split(find).join(replacement);
}

// ---- PM 图层补丁 1：事件定义 kind 前缀（注册表按 kind 去重）----
patched = patched.replace(/kind: "trajectory-/g, 'kind: "pmtrajectory-');
if (patched.includes('kind: "trajectory-')) throw new Error('event definition kinds not fully privatized');

// ---- PM 图层补丁 2：视图顺序 9000（紧跟官方轨迹之后）----
const orderPattern = /id: "pm-generations",(\s*)order: 10,/;
if (!orderPattern.test(patched)) throw new Error('view registration not found for order patch');
patched = patched.replace(orderPattern, 'id: "pm-generations",$1order: 9000,');

// 所有事件定义注册改走 pmDefinitionRegister。
const registerCount = (patched.split('ctx.uiConversation.events.register(').length - 1);
if (registerCount !== 9) throw new Error('definition registration count changed: ' + String(registerCount));
patched = patched.split('ctx.uiConversation.events.register(').join('pmDefinitionRegister(ctx, ');

// ---- PM 图层补丁 3：事件定义走私有注册器（过滤隐藏事件 + 可重注册）----
patched = replaceOnce(patched, 'function registerTrajectoryMessageDefinitions(ctx) {',
  `// PM：事件定义注册器。包装 match 以过滤掉「不属于当前世代」的事件；
		// 页码切换时 dispose + 重新 register，触发官方装配器按新世代重建快照。
		let pmDefinitionRegistrations = [];
		function pmDefinitionRegister(ctx, definition) {
			const wrapped = globalThis.__PM_UI__ === void 0 ? definition : globalThis.__PM_UI__.wrapDefinition(definition);
			const dispose = ctx.uiConversation.events.register(wrapped);
			pmDefinitionRegistrations.push({ ctx, definition, dispose });
			return dispose;
		}
		function registerTrajectoryMessageDefinitions(ctx) {`,
  'definition registry');

// 把「重注册」入口交给 client bridge（页码切换用）。
patched = replaceOnce(patched, 'const t = ctx.locale.bind(NS);',
  `const t = ctx.locale.bind(NS);
			if (globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.installReregister !== void 0) {
				globalThis.__PM_UI__.installReregister(() => {
					const entries = pmDefinitionRegistrations.splice(0, pmDefinitionRegistrations.length);
					for (const entry of entries) entry.dispose();
					for (const entry of entries) pmDefinitionRegister(entry.ctx, entry.definition);
				});
			}`,
  'reregister bridge');

// ---- PM 图层补丁 4：TrajectoryView 接收 sessionId/useProjection 并发布世代数据 ----
patched = replaceOnce(patched,
  'function TrajectoryView({ useSession, usePmTrajectory, useDuration, loadOlder, loadImage, setActualDuration, viewRequest, completeViewRequest, renderSlot, t, jsonStringWrapping }) {',
  `function TrajectoryView({ useSession, usePmTrajectory, useDuration, loadOlder, loadImage, setActualDuration, viewRequest, completeViewRequest, renderSlot, t, jsonStringWrapping, sessionId, useProjection }) {
			const pmProjection = typeof useProjection === "function" ? useProjection("pmGenerations") : void 0;
			react.useEffect(() => {
				if (globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.publish !== void 0) globalThis.__PM_UI__.publish(sessionId, pmProjection);
			}, [sessionId, pmProjection]);`,
  'view projection bridge');

// ---- PM 图层补丁 5：工具栏里、搜索框之前插入世代页码 ----
patched = replaceOnce(patched, `					}), (0, react_jsx_runtime.jsxs)("div", {
						className: TrajectoryToolbar_module_css_default.search,`, `					}), globalThis.__PM_UI__ === void 0 ? null : globalThis.__PM_UI__.pagination(t), (0, react_jsx_runtime.jsxs)("div", {
						className: TrajectoryToolbar_module_css_default.search,`, 'toolbar pagination');

// ---- PM 图层补丁 6：世代差异（已塑形）在轨迹行里的类型标签 / 折叠按钮 / 空文本 ---
// 标签颜色与折叠按钮由 client 侧的 __PM_UI__ 提供；只有「本代替代消息」这一条记录会命中。
patched = replaceOnce(patched,
  'className: `${TrajectoryTable_module_css_default.kindTag} ${record.cell.kind === "system" ?',
  'className: `${TrajectoryTable_module_css_default.kindTag}${globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell) ? " pm-reshaped-tag" : ""} ${record.cell.kind === "system" ?',
  'reshaped tag class');

patched = replaceOnce(patched,
  'children: t(KIND_LABEL_KEY[record.cell.kind])',
  'children: globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.reshapeTagLabel !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell) ? globalThis.__PM_UI__.reshapeTagLabel(record.cell) : t(KIND_LABEL_KEY[record.cell.kind])',
  'reshaped tag label');

const recordListCall = /(\(0, react_jsx_runtime\.jsx\)\(RecordListText, \{\s*)displayText,/;
if (!recordListCall.test(patched)) throw new Error('RecordListText call site not found');
patched = patched.replace(recordListCall, '$1cell: record.cell, displayText,');

patched = replaceOnce(patched,
  'function RecordListText({ displayText, toolCallOnly, toolCallText, t }) {',
  `function RecordListText({ displayText, toolCallOnly, toolCallText, t, cell }) {
			if (displayText === "" && globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(cell)) return (0, react_jsx_runtime.jsx)("span", {
				className: TrajectoryTable_module_css_default.toolCallOnly,
				children: "已隐藏"
			});`,
  'reshaped hidden text');

patched = applyExtraPatches(patched);

// 去掉指向不存在的 sourcemap 的尾注。
patched = patched.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '\n');

// 残留检查
const forbidden = [
  '@deepseek-ai/dsh-client-ui-trajectory',
  'target: "trajectory"',
  'id: "trajectory"',
  'conversation.trajectory.images',
  'useTrajectory',
  'kind: "trajectory-',
];
for (const needle of forbidden) {
  if (patched.includes(needle)) throw new Error('privatization leftover: ' + needle);
}

const glue = readFileSync(new URL('./client-glue.js', here), 'utf8');

const header = [
  '/**',
  ' * AUTO-GENERATED by build-client.mjs — 不要手改。',
  ' * 内容 = 私有化后的官方轨迹 bundle（trajectory-vendor.js 打补丁）+ 我们的 glue（client-glue.js）。',
  ' */',
  '',
].join(String.fromCharCode(10));

writeFileSync(new URL('./client.js', here), header + patched + glue);
console.log('client.js written:', (header + patched + glue).length, 'bytes');