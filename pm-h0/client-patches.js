/**
 * 0.14.0 客户端补丁：缓存官方快照 + 内嵌官方 TrajectoryView（展开已塑形用）。
 * 由 build-client.mjs 在私有化补丁之后调用；全部按行/唯一子串定位，兼容缩进变化。
 */

function insertAfterLine(lines, includes, newLines) {
  const index = lines.findIndex((line) => line.includes(includes));
  if (index === -1) throw new Error('extra patch anchor not found: ' + includes);
  lines.splice(index + 1, 0, ...newLines);
  return lines;
}

function insertBeforeLine(lines, includes, newLines) {
  const index = lines.findIndex((line) => line.includes(includes));
  if (index === -1) throw new Error('extra patch anchor not found: ' + includes);
  lines.splice(index, 0, ...newLines);
  return lines;
}

/**
 * @param {string} patched - 私有化 + PM 图层补丁后的官方 bundle 文本。
 * @returns {string} 追加了缓存 / 内嵌视图补丁的文本。
 */
export function applyExtraPatches(patched) {
  const lines = patched.split(String.fromCharCode(10));

  // 1. trajectorySource：包一层按世代快照的缓存（bridge.wrapTargetSource）。
  const sourceIndex = lines.findIndex((line) => line.includes('getSnapshot: () => target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT,'));
  if (sourceIndex === -1) throw new Error('extra patch: source snapshot line not found');
  const openIndex = sourceIndex - 1;
  if (!lines[openIndex] || !lines[openIndex].includes('source = {')) throw new Error('extra patch: source object open not found');
  const indent = lines[openIndex].slice(0, lines[openIndex].indexOf('source = {'));
  lines[sourceIndex] = indent + 'source = {';
  lines.splice(openIndex, 1); // 去掉旧 'source = {' 行，改为在下方重建
  const rebuilt = [
    indent + 'const pmDelegate = {',
    indent + '\tgetSnapshot: () => target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT,',
    indent + '\tsubscribe: (listener) => target.subscribe(listener)',
    indent + '};',
    indent + 'source = globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.wrapTargetSource !== void 0',
    indent + '\t? globalThis.__PM_UI__.wrapTargetSource(binding === null || binding === void 0 ? void 0 : binding.sessionId, pmDelegate)',
    indent + '\t: pmDelegate;',
  ];
  const nowSourceIndex = lines.findIndex((line) => line.includes('source = {'));
  const closeIndex = lines.indexOf(indent + '};', nowSourceIndex);
  if (nowSourceIndex === -1 || closeIndex === -1) throw new Error('extra patch: source object close not found');
  lines.splice(nowSourceIndex, closeIndex - nowSourceIndex + 1, ...rebuilt);

  // 2. TrajectoryView：嵌入模式标记 + 导出该组件。
  const viewLine = lines.findIndex((line) => line.includes('function TrajectoryView({ useSession, usePmTrajectory,'));
  if (viewLine === -1) throw new Error('extra patch: TrajectoryView not found');
  const viewIndent = lines[viewLine].slice(0, lines[viewLine].indexOf('function'));
  lines.splice(viewLine + 1, 0, viewIndent + '\tconst pmEmbedded = t !== void 0 && t.__pmEmbedded === true;');
  // 01：父视图把 view context（hooks/t/sessionId）发布给 bridge，内嵌官方视图要用它。
  const embeddedLine = lines.findIndex((line) => line.includes('const pmEmbedded = t !== void 0'));
  if (embeddedLine === -1) throw new Error('extra patch: pmEmbedded line not found');
  const viewBodyIndent = viewIndent + '\t\t\t';
  const contextLines = [
    viewBodyIndent + 'react.useEffect(() => {',
    viewBodyIndent + '\tif (pmEmbedded) return;',
    viewBodyIndent + '\tif (globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.publishViewContext !== void 0) globalThis.__PM_UI__.publishViewContext({',
    viewBodyIndent + '\t\tsessionId,',
    viewBodyIndent + '\t\tt,',
    viewBodyIndent + '\t\thooks: {',
    viewBodyIndent + '\t\t\tuseSession,',
    viewBodyIndent + '\t\t\tusePmTrajectory,',
    viewBodyIndent + '\t\t\tuseDuration,',
    viewBodyIndent + '\t\t\tloadImage,',
    viewBodyIndent + '\t\t\tsetActualDuration,',
    viewBodyIndent + '\t\t\trenderSlot,',
    viewBodyIndent + '\t\t\tuseProjection,',
    viewBodyIndent + '\t\t\tjsonStringWrapping,',
    viewBodyIndent + '\t\t\tloadOlder',
    viewBodyIndent + '\t\t}',
    viewBodyIndent + '\t});',
    viewBodyIndent + '}, [sessionId, t, useSession, usePmTrajectory, useDuration, loadImage, setActualDuration, renderSlot, useProjection, jsonStringWrapping, loadOlder, pmEmbedded]);',
  ];
  lines.splice(embeddedLine + 1, 0, ...contextLines);
  insertAfterLine(lines, 'exports.apply = apply;', ['\t\texports.pmTrajectoryView = TrajectoryView;']);

  // 3. publish 世代投影时跳过嵌入实例；同时把父视图 context 发布给 bridge。
  insertBeforeLine(lines, 'globalThis.__PM_UI__.publish(sessionId, pmProjection);', [viewIndent + '\t\t\tif (pmEmbedded) return;']);
  insertAfterLine(lines, 'const t = ctx.locale.bind(NS);', [
    '\t\t\tif (globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.installOfficialView !== void 0) globalThis.__PM_UI__.installOfficialView(TrajectoryView);',
  ]);

  let text = lines.join(String.fromCharCode(10));

  // 4. 内嵌视图里隐藏世代选择条。
  text = text.split('globalThis.__PM_UI__ === void 0 ? null : globalThis.__PM_UI__.pagination(t)')
    .join('globalThis.__PM_UI__ === void 0 || t.__pmEmbedded === true ? null : globalThis.__PM_UI__.pagination(t)');

  // 5. 行渲染把 t 传给 bridge（区分主视图 / 内嵌视图）。
  text = text.split('globalThis.__PM_UI__.isReshapedCell(record.cell) ? " pm-reshaped-tag"')
    .join('globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? " pm-reshaped-tag"');
  text = text.split('globalThis.__PM_UI__.isReshapedCell(record.cell) ? globalThis.__PM_UI__.reshapeTagLabel(record.cell)')
    .join('globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? globalThis.__PM_UI__.reshapeTagLabel(record.cell, t)');
  text = text.split('globalThis.__PM_UI__.isReshapedCell(cell)) return')
    .join('globalThis.__PM_UI__.isReshapedCell(cell, t)) return');

  // 6. A 形态：官方记录层注入（已塑形行搬到覆盖区间之前，收起时原样返回）。
  const virtualCall = 'const projectedVirtualRows = (0, react.useMemo)(() => groupTrajectoryVirtualRows(records), [records]);';
  const virtualReplacement = 'const projectedVirtualRows = (0, react.useMemo)(() => groupTrajectoryVirtualRows(globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.applyReshapeRecords !== void 0 ? globalThis.__PM_UI__.applyReshapeRecords(records) : records), [records, globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.reshapeVersion !== void 0 ? globalThis.__PM_UI__.reshapeVersion() : 0]);';
  if (text.split(virtualCall).length - 1 !== 1) throw new Error('extra patch: virtual rows call not found');
  text = text.split(virtualCall).join(virtualReplacement);
  // 7. 虚拟行层兜底重排（records 重排被分组抵消时生效）。
  const stableCall = "const virtualRowStructure = useStableVirtualRowStructure(projectedVirtualRows);";
  const stableReplacement = "const virtualRowStructure = useStableVirtualRowStructure(globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.applyReshapeVirtualRows !== void 0 ? globalThis.__PM_UI__.applyReshapeVirtualRows(projectedVirtualRows) : projectedVirtualRows);";
  if (text.split(stableCall).length - 1 !== 1) throw new Error('extra patch: stable rows call not found');
  text = text.split(stableCall).join(stableReplacement);

  // 8. 正文前显示固有轨迹类型（类型列留给粉色「已塑形」）。
  text = text.split('function RecordListText({ displayText, toolCallOnly, toolCallText, t, cell }) {').join('function RecordListTextInner({ displayText, toolCallOnly, toolCallText, t, cell }) {');
  const markdownAnchor = '		function MarkdownFragment({';
  if (text.split(markdownAnchor).length - 1 !== 1) throw new Error('extra patch: MarkdownFragment anchor not found');
  const wrapper = [
    '\t\tfunction RecordListText(props) {',
    '\t\t\tconst tag = globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.diffNativeTag !== void 0 ? globalThis.__PM_UI__.diffNativeTag(props.cell) : null;',
    '\t\t\tconst content = RecordListTextInner(props);',
    '\t\t\tif (tag === null || tag === undefined) return content;',
    '\t\t\treturn (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [tag, content] });',
    '\t\t}',
    '',
  ].join(String.fromCharCode(10));
  text = text.split(markdownAnchor).join(wrapper + markdownAnchor);
  // 9. UI 本地化 + 类型列恢复原生、差异徽标移到正文。
  text = text.split('"view.trajectory": "世代",').join('"view.trajectory": "世代",' + String.fromCharCode(10) + '\t\t\t"pm.reshaped": "已塑形",' + String.fromCharCode(10) + '\t\t\t"pm.reshaping": "被塑形",' + String.fromCharCode(10) + '\t\t\t"pm.hidden": "（已隐藏）",');
  text = text.split('"view.trajectory": "Generations",').join('"view.trajectory": "Generations",' + String.fromCharCode(10) + '\t\t\t"pm.reshaped": "Reshaped",' + String.fromCharCode(10) + '\t\t\t"pm.reshaping": "Being reshaped",' + String.fromCharCode(10) + '\t\t\t"pm.hidden": "(Hidden)",');
  // 类型列恢复原生标签（去掉粉色 class 与标签替换）。
  text = text.split('${globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? " pm-reshaped-tag" : ""} ').join('');
  text = text.split('children: globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.reshapeTagLabel !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? globalThis.__PM_UI__.reshapeTagLabel(record.cell, t) : t(KIND_LABEL_KEY[record.cell.kind])').join('children: t(KIND_LABEL_KEY[record.cell.kind])');
  // 空替代文本：本地化「（已隐藏）」。
  text = text.split('children: "已隐藏"').join('children: t("pm.hidden")');
  // 正文包装器把 t 传给差异徽标。
  text = text.split('globalThis.__PM_UI__.diffNativeTag(props.cell)').join('globalThis.__PM_UI__.diffNativeTag(props.cell, props.t)');
  // 10. 修复：恢复原生类型标签时少了类名之间的空格，导致彩色药丸样式失效。
  text = text.split('${TrajectoryTable_module_css_default.kindTag}${record.cell.kind === "system"').join('${TrajectoryTable_module_css_default.kindTag} ${record.cell.kind === "system"');
  return text;
}