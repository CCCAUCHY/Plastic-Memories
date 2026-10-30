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
  const pmLocaleZh = {
    'pm.reshaped': '已塑形',
    'pm.reshaping': '被塑形',
    'pm.hidden': '（已隐藏）',
    'pm.hiddenAuto': '（自动隐藏）',
    'pm.hiddenManual': '（主动隐藏）',
    'pm.safeZone': '安全区',
    'pm.safetyTitle': '该消息位于安全区：不能被 plasticize 改写',
    'pm.loadAll': '加载全部',
    'pm.loading': '加载中…',
    'pm.loadAllTitle': '加载当前世代全部轨迹',
    'pm.jumpReshaped': '跳到对应的已塑形消息',
    'pm.jumpReshaping': '跳到塑形前的区域',
    'pm.typeReshaped': '已经塑形的区域：跳到上一世代',
    'pm.typeReshaping': '这里即将被下一世代塑形：跳到下一世代',
    'pm.expandReshape': '展开塑形前的轨迹',
    'pm.collapseReshape': '收起塑形前的轨迹',
    'pm.coveredHead': '本代塑形覆盖了上一代 {count} 条消息（快照装配中）',
    'pm.pendingSnapshot': '上一世代快照装配中…',
    'pm.roleUser': '用户',
    'pm.roleAssistant': '助手',
    'pm.roleDeveloper': '上下文',
    'pm.roleTool': '工具',
    'pm.roleSystem': '系统',
    'pm.pagerLabel': '世代',
    'pm.pagerTitle': '第 {n} 代',
  };
  const pmLocaleEn = {
    'pm.reshaped': 'Reshaped',
    'pm.reshaping': 'Being reshaped',
    'pm.hidden': '(Hidden)',
    'pm.hiddenAuto': '(Auto-hidden)',
    'pm.hiddenManual': '(Manually hidden)',
    'pm.safeZone': 'Safety zone',
    'pm.safetyTitle': 'This message is in the safety zone and cannot be reshaped by plasticize',
    'pm.loadAll': 'Load all',
    'pm.loading': 'Loading…',
    'pm.loadAllTitle': 'Load all trajectory rows in the current generation',
    'pm.jumpReshaped': 'Jump to the corresponding reshaped message',
    'pm.jumpReshaping': 'Jump to the pre-reshaping range',
    'pm.typeReshaped': 'Reshaped area: jump to the previous generation',
    'pm.typeReshaping': 'This area will be reshaped by the next generation: jump to it',
    'pm.expandReshape': 'Expand pre-reshaping trajectory',
    'pm.collapseReshape': 'Collapse pre-reshaping trajectory',
    'pm.coveredHead': 'This generation reshapes {count} messages from the previous generation (snapshot loading)',
    'pm.pendingSnapshot': 'Assembling the previous-generation snapshot…',
    'pm.roleUser': 'User',
    'pm.roleAssistant': 'Assistant',
    'pm.roleDeveloper': 'Context',
    'pm.roleTool': 'Tool',
    'pm.roleSystem': 'System',
    'pm.pagerLabel': 'Generations',
    'pm.pagerTitle': 'Generation {n}',
  };
  const insertPmLocale = (text, anchor, dict) => {
    const inserted = Object.entries(dict).map(([key, value]) => String.fromCharCode(10) + '\t\t\t' + JSON.stringify(key) + ': ' + JSON.stringify(value) + ',').join('');
    return text.split(anchor).join(anchor + inserted);
  };


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
  text = insertPmLocale(text, '"view.trajectory": "世代",', pmLocaleZh);
  text = insertPmLocale(text, '"view.trajectory": "Generations",', pmLocaleEn);
  // 类型列恢复原生标签（去掉粉色 class 与标签替换）。
  text = text.split('${globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? " pm-reshaped-tag" : ""} ').join('');
  text = text.split('children: globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.reshapeTagLabel !== void 0 && globalThis.__PM_UI__.isReshapedCell !== void 0 && globalThis.__PM_UI__.isReshapedCell(record.cell, t) ? globalThis.__PM_UI__.reshapeTagLabel(record.cell, t) : t(KIND_LABEL_KEY[record.cell.kind])').join('children: t(KIND_LABEL_KEY[record.cell.kind])');
  // 空替代文本：本地化「（已隐藏）」。
  text = text.split('children: "已隐藏"').join('children: globalThis.__PM_UI__ !== void 0 && globalThis.__PM_UI__.hiddenLabel !== void 0 ? globalThis.__PM_UI__.hiddenLabel(cell, t) : t("pm.hidden")');
  // 正文包装器把 t 传给差异徽标。
  text = text.split('globalThis.__PM_UI__.diffNativeTag(props.cell)').join('globalThis.__PM_UI__.diffNativeTag(props.cell, props.t)');
  // 10. 修复：恢复原生类型标签时少了类名之间的空格，导致彩色药丸样式失效。
  text = text.split('${TrajectoryTable_module_css_default.kindTag}${record.cell.kind === "system"').join('${TrajectoryTable_module_css_default.kindTag} ${record.cell.kind === "system"');
  // 11. 真实空行：世代表底部追加 20 条空 <tr>，让滚动空间足够（不是 padding）。
  const spacerAnchor = 'virtualBottom > 0 && (0, react_jsx_runtime.jsx)("tr", {';
  if (text.split(spacerAnchor).length - 1 !== 1) throw new Error('extra patch: virtual bottom spacer not found');
  const blanks = '...(Array.from({ length: 20 }, (_, pmIndex) => (0, react_jsx_runtime.jsx)("tr", { key: "pm-blank-" + String(pmIndex), children: (0, react_jsx_runtime.jsx)("td", { colSpan: 2, style: { height: 30 } }) }))), ';
  text = text.split(spacerAnchor).join(blanks + spacerAnchor);
  // 14. 布局排序（layoutEntryOrder）也改用官方 surface 顺序。
  const pmLayoutFind = "return entry.kind === \"system\" && entry.change.kind === \"initial\" ? Number.NEGATIVE_INFINITY : entry.seq;";
  const pmLayoutRepl = "if (entry.kind === \"system\" && entry.change.kind === \"initial\") return Number.NEGATIVE_INFINITY; const pmLayoutOrder = globalThis.__PM_SEQ_ORDER__; if (pmLayoutOrder !== void 0 && pmLayoutOrder !== null && pmLayoutOrder.has(entry.seq)) return pmLayoutOrder.get(entry.seq); return entry.seq;";
  if (text.split(pmLayoutFind).length - 1 !== 1) throw new Error('extra patch: layout order not found');
  text = text.split(pmLayoutFind).join(pmLayoutRepl);
  // 15. 工具栏加载全部按钮 + 文案。
  const pmPager = 'globalThis.__PM_UI__ === void 0 || t.__pmEmbedded === true ? null : globalThis.__PM_UI__.pagination(t)';
  const pmPagerRepl = 'globalThis.__PM_UI__ === void 0 || t.__pmEmbedded === true ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [globalThis.__PM_UI__.pagination(t), globalThis.__PM_UI__.loadAllButton !== void 0 ? globalThis.__PM_UI__.loadAllButton(t) : null] })';
  if (text.split(pmPager).length - 1 === 1) text = text.split(pmPager).join(pmPagerRepl);
  return text;
}