window.__ModuleLoader__.load({
  id: 'dsh-plugin-plastic-memories-h0',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    function pmUiText(t, key, fallback) { return t === undefined || t === null ? fallback : t(key); }
    function liveUiT() { return viewContext === undefined || viewContext === null ? undefined : viewContext.t; }

    // ── 世代选择 bridge ─────────────────────────────────────────────────────
    // 事实源链：会话日志 → host 投影（官方 fold，diffcheck 逐代校验）→ 可见 seq 字典。
    // 这里不再过滤「官方轨迹快照」，而是把字典交给官方装配器：事件定义在 match 阶段
    // 跳过不属于当前世代的事件，切世代时重注册定义、触发官方装配器重建快照 ——
    // 于是轨迹 = 官方代码对「该世代真实日志」的装配结果，不存在第二套转换算法。
    const states = new Map();
    const globalListeners = new Set();
    let activeState;
    let reregisterDefinitions;
    let officialView;
    let viewContext;
    const snapshotCache = new Map();
    const liveSnapshots = new Map();
    let assemblyOverride;
    let lastSourceDelegate;
    const expandedVariantCache = new Map();
    let expandedReshapeSeq;
    let expandedGen = -1;
    let expandedCovered = new Set();
    let reshapeVersionCounter = 0;
    let expandedHeaderIndex = -1;
    function cacheKey(sessionId, gen) {
      return (sessionId === undefined || sessionId === null ? '__active' : String(sessionId)) + ':' + String(gen);
    }

    function stateOf(sessionId) {
      const key = sessionId === undefined || sessionId === null ? '__active' : String(sessionId);
      let state = states.get(key);
      if (state === undefined) {
        state = { gen: null, data: undefined, fingerprint: '', filterCache: undefined };
        states.set(key, state);
      }
      return state;
    }
    function notifyAll() {
      for (const listener of [...globalListeners]) listener();
    }
    function invalidateFilterCaches() {
      for (const state of states.values()) state.filterCache = undefined;
    }
    function reshapeEntryOf(seq, gen) {
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return null;
      const replacements = Array.isArray(state.data.replacements) ? state.data.replacements : [];
      return replacements.find((entry) => entry.gen === gen && entry.repl === seq) ?? null;
    }
    function toggleReshape(seq, cellIndex) {
      const state = activeState;
      if (state === undefined) return;
      const gen = effectiveGeneration(state);
      const entry = reshapeEntryOf(seq, gen);
      if (entry === null) return;
      const sessionId = viewContext === undefined ? undefined : viewContext.sessionId;
      const baseKey = cacheKey(sessionId, gen);
      if (expandedReshapeSeq === seq) {
        expandedReshapeSeq = undefined;
        expandedGen = -1;
        expandedCovered = new Set();
        expandedHeaderIndex = -1;
        reshapeVersionCounter += 1;
        invalidateFilterCaches();
        if (!snapshotCache.has(baseKey)) reregister();
        notifyAll();
        return;
      }
      expandedReshapeSeq = seq;
      expandedGen = gen;
      expandedHeaderIndex = Number.isSafeInteger(cellIndex) ? cellIndex : -1;
      expandedCovered = new Set(Array.isArray(entry.shadowed) ? entry.shadowed : []);
      reshapeVersionCounter += 1;
      invalidateFilterCaches();
      if (!expandedVariantCache.has(baseKey + ':expanded:' + String(seq))) reregister();
      notifyAll();
    }
    function reshapeVersion() {
      return reshapeVersionCounter;
    }
    function isCoveredEarlierReplacement(seq) {
      if (expandedReshapeSeq === undefined || !expandedCovered.has(seq)) return false;
      const state = activeState;
      if (state === undefined) return false;
      const replacements = Array.isArray(state.data?.replacements) ? state.data.replacements : [];
      return replacements.some((entry) => entry.repl === seq && entry.gen < expandedGen);
    }
    /**
    * 按「当前世代的官方 surface 顺序」重排轨迹行：替代消息出现在被替换区间的位置，
    * 于是相邻两代的第一个差异点之前前缀完全一致（纯翻页即可对齐）。
    */
    function applyReshapeRecords(records) {
      if (!Array.isArray(records)) return records;
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return records;
      const generations = Array.isArray(state.data.generations) ? state.data.generations : [];
      const gen = effectiveGeneration(state);
      const seqs = Array.isArray(generations[gen]?.seqs) ? generations[gen].seqs : [];
      if (seqs.length === 0) return records;
      const position = new Map();
      for (let index = 0; index < seqs.length; index += 1) position.set(seqs[index], index);
      let last = 0;
      const decorated = records.map((record, index) => {
        const seq = record !== undefined && record !== null && record.cell !== undefined && record.cell !== null ? record.cell.sourceSeq : undefined;
        let pos = position.has(seq) ? position.get(seq) : -1;
        if (pos < 0) pos = last; else last = pos;
        return { record, pos, index };
      });
      decorated.sort((left, right) => (left.pos - right.pos) || (left.index - right.index));
      if (typeof console !== 'undefined' && console.info !== undefined) {
        console.info('[pm-order-debug]', JSON.stringify({
          gen,
          seqCount: seqs.length,
          replacements: Array.isArray(state.data.replacements) ? state.data.replacements.map((entry) => ({ gen: entry.gen, repl: entry.repl, shadowed: entry.shadowed })) : [],
          rows: records.slice(0, 60).map((record) => ({
            kind: record?.cell?.kind,
            seq: record?.cell?.sourceSeq,
            idx: record?.cell?.index,
            text: String(record?.cell?.text ?? '').slice(0, 16),
          })),
        }));
      }
      return decorated.map((entry) => entry.record);
    }
    function applyReshapeVirtualRows(rows) {
      return rows;
    }
    function diffMarksOf(cell) {
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return [];
      if (cell === undefined || cell === null || typeof cell.sourceSeq !== 'number') return [];
      const data = state.data;
      const gen = effectiveGeneration(state);
      const replacements = Array.isArray(data.replacements) ? data.replacements : [];
      const marks = [];
      const next = replacements.find((entry) => entry.gen === gen + 1);
      if (next !== undefined && Array.isArray(next.shadowed) && next.shadowed.includes(cell.sourceSeq)) {
        marks.push({ kind: 'reshaping', targetGen: next.gen, targetSeq: next.repl });
      }
      const own = replacements.find((entry) => entry.repl === cell.sourceSeq && entry.gen === gen);
      if (own !== undefined) {
        const first = Array.isArray(own.shadowed) && own.shadowed.length > 0 ? own.shadowed[0] : own.repl;
        marks.push({ kind: 'reshaped', targetGen: own.gen - 1, targetSeq: first });
      }
      return marks;
    }
    function diffMarkOf(cell) {
      const marks = diffMarksOf(cell);
      return marks.length === 0 ? null : marks[0];
    }
    /** 记录被点击行在滚动容器里的偏移，翻页后把目标行拉到同一位置。 */
    /** 相邻两代第一个差异点之前前缀相同：直接翻页，scrollTop 由 setGeneration 保持。 */
    function jumpDiff(mark, rowElement) {
      if (mark === null || mark === undefined) return;
      const state = activeState;
      if (state === undefined) return;
      const total = generationCount(state.data);
      setGeneration(mark.targetGen >= total - 1 ? null : Math.max(0, mark.targetGen));
    }
    function navigateDiff(mark, rowElement) {
      jumpDiff(mark, rowElement);
    }
    function generationCount(data) {
      return data !== null && typeof data === 'object' && Array.isArray(data.generations) ? data.generations.length : 0;
    }
    /** 当前选中的世代（0 起；null = 跟随最新）。 */
    function effectiveGeneration(state) {
      const total = generationCount(state.data);
      if (total === 0) return 0;
      if (state.gen === null || state.gen < 0 || state.gen > total - 1) return total - 1;
      return state.gen;
    }
    /**
    * 当前世代对应的「不属于它的事件」字典。
    * @param {object} state - { gen, data }。
    * @returns {null|{cutoff:number, hiddenSeqs:Set<number>, hiddenCalls:Set<string>, hiddenSteps:Set<string>}} 过滤字典。
    */
    function filterOf(state) {
      const data = state.data;
      if (generationCount(data) === 0) return null;
      const gen = assemblyOverride === undefined ? effectiveGeneration(state) : assemblyOverride;
      if (state.filterCache !== undefined && state.filterCache.data === data && state.filterCache.gen === gen) {
        return state.filterCache.filter;
      }
      const generations = data.generations;
      const current = Number(data.current ?? generations.length - 1);
      const generation = gen >= current ? null : generations.find((entry) => entry.gen === gen) ?? generations[0];
      const cutoff = generation !== null && Number.isFinite(generation.asOfSeq) ? generation.asOfSeq : Number.POSITIVE_INFINITY;
      const meta = data.meta !== null && typeof data.meta === 'object' ? data.meta : {};
      const hiddenSeqs = new Set();
      const hiddenCalls = new Set();
      for (const rep of Array.isArray(data.replacements) ? data.replacements : []) {
        if (rep.gen > gen) continue;
        for (const seq of Array.isArray(rep.shadowed) ? rep.shadowed : []) {
          hiddenSeqs.add(seq);
          const info = meta[String(seq)];
          if (info === null || info === undefined) continue;
          if (typeof info.toolCallId === 'string') hiddenCalls.add(info.toolCallId);
          for (const call of Array.isArray(info.calls) ? info.calls : []) {
            if (call !== null && typeof call === 'object' && typeof call.id === 'string') hiddenCalls.add(call.id);
          }
        }
      }
      // 整步被遮：该 (turn,step) 下所有可见节点都被遮 → 连 step/turn 结构事件一起藏掉，
      // 免得官方装配器渲染出空的/中断的 assistant 步。
      const totals = new Map();
      const hiddenPerStep = new Map();
      for (const [seqText, info] of Object.entries(meta)) {
        if (info === null || typeof info !== 'object') continue;
        if (!Number.isSafeInteger(info.turn) || !Number.isSafeInteger(info.step)) continue;
        const seq = Number(seqText);
        if (seq > cutoff) continue;
        const key = String(info.turn) + ':' + String(info.step);
        totals.set(key, (totals.get(key) ?? 0) + 1);
        if (hiddenSeqs.has(seq)) hiddenPerStep.set(key, (hiddenPerStep.get(key) ?? 0) + 1);
      }
      const hiddenSteps = new Set();
      for (const [key, hiddenCount] of hiddenPerStep) if (hiddenCount === totals.get(key)) hiddenSteps.add(key);
      if (expandedReshapeSeq !== undefined && expandedGen === gen) {
        for (const seq of expandedCovered) {
          hiddenSeqs.delete(seq);
          const info = meta[String(seq)];
          if (info !== null && info !== undefined) {
            if (typeof info.toolCallId === 'string') hiddenCalls.delete(info.toolCallId);
            for (const call of Array.isArray(info.calls) ? info.calls : []) {
              if (call !== null && call !== undefined && typeof call.id === 'string') hiddenCalls.delete(call.id);
            }
          }
          if (info !== null && info !== undefined && Number.isSafeInteger(info.turn) && Number.isSafeInteger(info.step)) {
            hiddenSteps.delete(String(info.turn) + ':' + String(info.step));
          }
        }
      }
      const filter = { cutoff, hiddenSeqs, hiddenCalls, hiddenSteps };
      state.filterCache = { data, gen, filter };
      return filter;
    }

    /**
    * 官方装配器在 match 阶段调用：这条事件属于当前世代吗？
    * @param {object} event - 会话事件。
    * @returns {boolean} 不属于（应跳过）返回 true。
    */
    function isHiddenEvent(event) {
      const state = activeState;
      if (state === undefined || event === null || typeof event !== 'object') return false;
      const filter = filterOf(state);
      if (filter === null) return false;
      if (typeof event.seq === 'number') {
        if (event.seq > filter.cutoff || filter.hiddenSeqs.has(event.seq)) return true;
        const data = event.data;
        if (data !== null && typeof data === 'object' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
          if (filter.hiddenSteps.has(String(data.turn) + ':' + String(data.step))) return true;
        }
      }
      const data = event.data;
      if (data !== null && typeof data === 'object') {
        for (const key of ['callId', 'rootCallId', 'parentCallId', 'subCallId']) {
          const id = data[key];
          if (typeof id === 'string' && filter.hiddenCalls.has(id)) return true;
        }
      }
      return false;
    }

    // ── 世代差异（已塑形）─────────────────────────────────────────────────
    // 相邻两代的差异由「上一代真实上下文」定义：本代的 replace 事件覆盖了上一代
    // 哪些 seq（host 投影的 replacements[].shadowed），被覆盖节点正文在 meta 里。
    // 这里只做展示，不重写官方装配。
    const ROLE_KEYS = { user: 'pm.roleUser', assistant: 'pm.roleAssistant', tool: 'pm.roleTool', system: 'pm.roleSystem', developer: 'pm.roleDeveloper' };
    function reshapeInfoOf(cell, t) {
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return null;
      if (cell === undefined || cell === null || typeof cell.sourceSeq !== 'number') return null;
      const embedded = t !== undefined && t !== null && t.__pmEmbedded === true;
      const gen = embedded ? Math.max(0, effectiveGeneration(state) - 1) : effectiveGeneration(state);
      if (gen <= 0) return null;
      const replacements = Array.isArray(state.data.replacements) ? state.data.replacements : [];
      const entry = replacements.find((candidate) => candidate.gen === gen && candidate.repl === cell.sourceSeq);
      if (entry === undefined) return null;
      return { gen, entry };
    }
    /** 这条轨迹记录是不是「本代塑形」的替代消息（只有它带折叠按钮）。 */
    /** 空替代文本的文案：自动隐藏与主动隐藏底层同权，仅便于观察。 */
    /** 是否是 PM 的隐藏类替代（主动 hide 或 auto-hide）；跨世代都要显示隐藏文案。 */
    function isHiddenReplacement(cell) {
      const source = cell?.messageSource ?? cell?.source;
      if (source === null || source === undefined) return false;
      if (String(source.note ?? '').startsWith('auto-hide:')) return true;
      return source.kind === 'pm-surface' && source.op === 'hide';
    }
    function hiddenLabel(cell, t) {
      const source = cell?.messageSource ?? cell?.source;
      const note = typeof source?.note === 'string' ? source.note : '';
      const op = typeof source?.op === 'string' ? source.op : '';
      if (note.startsWith('auto-hide:')) return pmUiText(t, 'pm.hiddenAuto', '(Auto-hidden)');
      if (op === 'hide') return pmUiText(t, 'pm.hiddenManual', '(Manually hidden)');
      return pmUiText(t, 'pm.hidden', '(Hidden)');
    }
    function isReshapedCell(cell, t) {
      return diffMarksOf(cell).some((mark) => mark.kind === 'reshaped');
    }
    function coveredNodesOf(cell) {
      const info = reshapeInfoOf(cell);
      if (info === null) return [];
      const meta = activeState.data.meta !== null && typeof activeState.data.meta === 'object' ? activeState.data.meta : {};
      return [...info.entry.shadowed]
        .sort((left, right) => left - right)
        .map((seq) => ({ seq, info: meta[String(seq)] ?? { seq, role: 'unknown' } }));
    }
    function coveredKindLabel(info, t) {
      if (info.projected === true) return pmUiText(t, 'pm.reshaped', 'Reshaped');
      const key = typeof info.role === 'string' ? ROLE_KEYS[info.role] : undefined;
      if (key !== undefined) return pmUiText(t, key, String(info.role));
      if (info.type === 'tool/result') return pmUiText(t, 'pm.roleTool', 'Tool');
      return pmUiText(t, 'pm.roleDeveloper', 'Context');
    }
    function coveredText(info) {
      if (typeof info.text === 'string' && info.text.length > 0) return info.text;
      if (Array.isArray(info.calls) && info.calls.length > 0) return info.calls.map((call) => String(call.name ?? 'tool')).join(' · ');
      if (typeof info.reasoning === 'string' && info.reasoning.length > 0) return info.reasoning;
      return '';
    }
    /**
    * 折叠按钮（只放在「已塑形」轨迹类型的位置）：点击展开/收起上一代被覆盖的消息。
    * 行内其他位置不绑定展开，仍然走官方详情面板。
    */
    function ReshapedTag({ cell }) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, []);
      const expanded = expandedReshapeSeq !== undefined && cell !== undefined && cell !== null && cell.sourceSeq === expandedReshapeSeq;
      const t = liveUiT();
      return h('button', {
        type: 'button',
        className: 'pm-reshaped-button',
        title: pmUiText(t, expanded ? 'pm.collapseReshape' : 'pm.expandReshape', expanded ? 'Collapse pre-reshaping trajectory' : 'Expand pre-reshaping trajectory'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleReshape(cell.sourceSeq, cell.index);
        },
      }, expanded ? pmUiText(t, 'pm.reshaped', 'Reshaped') + ' ▾' : pmUiText(t, 'pm.reshaped', 'Reshaped'));
    }
    /** 展开区里上一层被覆盖节点的兜底摘要（上一代快照还没缓存时用）。 */
    function CoveredSummary({ cell }) {
      const rows = coveredNodesOf(cell);
      const t = liveUiT();
      const head = t === undefined || t === null
        ? 'This generation reshapes ' + String(rows.length) + ' messages from the previous generation (snapshot loading)'
        : t('pm.coveredHead', { count: rows.length });
      return h('div', { className: 'pm-reshape-fallback' }, [
        h('div', { key: 'head', className: 'pm-reshape-head' }, head),
        ...rows.map(({ seq, info }) => {
          const text = coveredText(info);
          return h('div', { key: 'row-' + String(seq), className: 'pm-reshape-row' }, [
            h('span', { key: 'kind', className: info.projected === true ? 'pm-reshape-kind pm-reshape-kind-projected' : 'pm-reshape-kind' }, coveredKindLabel(info, t)),
            h('span', { key: 'text', className: text.length === 0 ? 'pm-reshape-text pm-reshape-hidden' : 'pm-reshape-text', title: text }, text.length === 0 ? pmUiText(t, 'pm.hidden', '(Hidden)') : text),
          ]);
        }),
      ]);
    }

    /** 上一代快照的来源 hook：内嵌官方视图从这里取数据（缓存里的官方装配产物）。 */
    function useCachedPrevSnapshot(selector) {
      const gen = Math.max(0, effectiveGeneration(activeState) - 1);
      const read = () => cachedSnapshotFor(gen);
      const snapshot = read();
      return selector === undefined ? snapshot : selector(snapshot);
    }
    function cachedSnapshotFor(gen) {
      const key = cacheKey(activeState === undefined ? undefined : viewContext?.sessionId, gen);
      return snapshotCache.get(key);
    }

    /**
    * 把内嵌的上一世代官方视图滚到「被覆盖区间」起点。
    * 官方表格是虚拟化 + 异步 data-scroll-ready，所以用 rAF 重试：先按行号估算 scrollTop，
    * 等目标行渲染出来后再 scrollIntoView 精确居中。
    */
    function scrollToCovered(container, snapshot, seqs) {
      if (container === null || container === undefined) return;
      if (snapshot === undefined || snapshot === null) return;
      if (!Array.isArray(seqs) || seqs.length === 0) return;
      const nodes = Array.isArray(snapshot.eventNodes) ? snapshot.eventNodes : [];
      const firstSeq = Math.min.apply(null, seqs);
      const index = nodes.findIndex((node) => node !== undefined && node !== null && node.seq === firstSeq);
      if (index < 0) return;
      let attempts = 0;
      const attempt = () => {
        attempts += 1;
        const table = container.querySelector("table");
        if (table === null || table === undefined) {
          if (attempts < 60) requestAnimationFrame(attempt);
          return;
        }
        let parent = table.parentElement;
        while (parent !== null && parent !== undefined && parent !== container) {
          const style = typeof getComputedStyle === "function" ? getComputedStyle(parent) : null;
          if (style !== null && (style.overflowY === "auto" || style.overflowY === "scroll")) break;
          parent = parent.parentElement;
        }
        if (parent === null || parent === undefined) return;
        const estimate = Math.max(0, index * 30 - 45);
        if (Math.abs(parent.scrollTop - estimate) > 2) parent.scrollTop = estimate;
        const encoded = "%00seq%00" + String(firstSeq);
        const row = container.querySelector("[data-trajectory-row-key*=\"" + encoded + "\"]");
        if (row !== null && row !== undefined && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "center" });
          return;
        }
        if (attempts < 60) requestAnimationFrame(attempt);
      };
      requestAnimationFrame(attempt);
      setTimeout(attempt, 120);
      setTimeout(attempt, 320);
    }

    /** 已塑形展开区：内嵌官方 TrajectoryView（上一世代快照）。 */
    function ReshapedPanel({ cell }) {
      const info = reshapeInfoOf(cell);
      const prevGen = info === null ? 0 : Math.max(0, info.gen - 1);
      const ref = React.useRef(null);
      const [snapshot, setSnapshot] = React.useState(undefined);
      React.useEffect(() => {
        if (viewContext === undefined) return undefined;
        const key = cacheKey(viewContext.sessionId, prevGen);
        const read = () => snapshotCache.get(key);
        setSnapshot(read());
        if (read() === undefined) {
          prepareSnapshot(prevGen);
          setSnapshot(read());
        }
        const listener = () => setSnapshot(read());
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, [prevGen]);
      React.useEffect(() => {
        if (info === null) return;
        if (snapshot !== undefined) scrollToCovered(ref.current, snapshot, info.entry.shadowed);
      }, [snapshot, info]);
      if (officialView === undefined || viewContext === undefined) return h(CoveredSummary, { cell });
      if (snapshot === undefined) return h('div', { className: 'pm-reshape-pending' }, pmUiText(viewContext === undefined ? undefined : viewContext.t, 'pm.pendingSnapshot', 'Assembling the previous-generation snapshot…'));
      const embeddedT = (key, vars) => viewContext.t(key, vars);
      embeddedT.__pmEmbedded = true;
      const hook = (selector) => {
        const current = cachedSnapshotFor(prevGen) ?? snapshot;
        return selector === undefined ? current : selector(current);
      };
      const view = h(officialView, {
        useSession: viewContext.hooks.useSession,
        usePmTrajectory: hook,
        useDuration: viewContext.hooks.useDuration,
        loadOlder: async () => false,
        loadImage: viewContext.hooks.loadImage,
        setActualDuration: viewContext.hooks.setActualDuration ?? (() => {}),
        viewRequest: undefined,
        completeViewRequest: () => {},
        renderSlot: viewContext.hooks.renderSlot,
        t: embeddedT,
        jsonStringWrapping: viewContext.hooks.jsonStringWrapping,
        sessionId: viewContext.sessionId,
        useProjection: viewContext.hooks.useProjection,
      });
      return h('div', {
        className: 'pm-reshape-panel',
        ref,
        onClick: (event) => event.stopPropagation(),
        onDoubleClick: (event) => event.stopPropagation(),
      }, [h('div', { key: 'embed', className: 'pm-reshape-embed' }, view)]);
    }
    /** 轨迹类型列里给「已塑形」用的元素；其余记录仍返回官方标签文字。 */
    /** 类型列只放粉色「已塑形」翻页按钮；固有类型移到正文处显示。 */
    function reshapeTagLabel(cell, t) {
      if (t !== undefined && t !== null && t.__pmEmbedded === true) return null;
      const mark = diffMarkOf(cell);
      if (mark === null) return null;
      return h('button', {
        type: 'button',
        className: 'pm-diff-tag',
        title: pmUiText(t, mark.side === 'replacement' ? 'pm.typeReshaped' : 'pm.typeReshaping', mark.side === 'replacement' ? 'Reshaped area: jump to the previous generation' : 'This area will be reshaped by the next generation: jump to it'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          navigateDiff(mark);
        },
      }, pmUiText(t, 'pm.reshaped', 'Reshaped'));
    }

    /** 正文前的差异徽标：本代替代消息 = 已塑形（粉）；将被下一代覆盖 = 被塑形（反色）。 */
    /** 正文前的差异徽标：被塑形（反色，跳下一代）排在已塑形（粉，跳上一代）之前。 */
    /** 安全区徽标：只在最新世代显示，位置排在差异徽标之后。 */
    function safetyTag(cell, t) {
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return null;
      const safety = Array.isArray(state.data.safety) ? state.data.safety : [];
      if (safety.length === 0) return null;
      if (cell === undefined || cell === null || typeof cell.sourceSeq !== 'number') return null;
      const current = Number.isFinite(Number(state.data.current)) ? Number(state.data.current) : 0;
      const gen = effectiveGeneration(state);
      if (gen !== current) return null;
      if (!safety.includes(cell.sourceSeq)) return null;
      return h('span', {
        className: 'pm-diff-badge pm-safety-badge',
        title: pmUiText(t, 'pm.safetyTitle', 'This message is in the safety zone and cannot be reshaped by plasticize'),
      }, pmUiText(t, 'pm.safeZone', 'Safety zone'));
    }
    /** 正文前的徽标：差异（被塑形/已塑形）在前，安全区在后。 */
    function diffNativeTag(cell, t) {
      if (cell === undefined || cell === null) return null;
      const marks = diffMarksOf(cell);
      const tags = marks.map((mark, index) => h('button', {
        key: mark.kind + String(index),
        type: 'button',
        className: mark.kind === 'reshaping' ? 'pm-diff-badge pm-diff-badge-reshaping' : 'pm-diff-badge pm-diff-badge-reshaped',
        title: mark.kind === 'reshaping' ? pmUiText(t, 'pm.jumpReshaping', 'Jump to the pre-reshaping range') : pmUiText(t, 'pm.jumpReshaped', 'Jump to the corresponding reshaped message'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          jumpDiff(mark, event.currentTarget);
        },
      }, mark.kind === 'reshaping' ? pmUiText(t, 'pm.reshaping', 'Being reshaped') : pmUiText(t, 'pm.reshaped', 'Reshaped')));
      const safety = safetyTag(cell, t);
      if (tags.length === 0 && safety === null) return null;
      return h(React.Fragment, null, ...tags, ...(safety === null ? [] : [safety]));
    }
    const PM_UI_CSS = [
      'div:has(> table[data-scroll-ready="true"]){padding-bottom:calc(var(--dsh-trajectory-bottom-clearance,0px) + 58vh)!important}',
      '.pm-load-all{box-sizing:border-box;flex:none;margin-right:6px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:2px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}',
      '.pm-load-all:disabled{opacity:.6;cursor:default}',
      '.pm-diff-badge{box-sizing:border-box;flex:none;margin-right:6px;height:19px;padding:0 5px;border:0;border-radius:var(--dsw-radius-xs);font-size:10px;font-weight:650;letter-spacing:.035em;line-height:16px;display:inline-flex;align-items:center;cursor:pointer}',
      '.pm-diff-badge-reshaped{color:#C64F91;background:#FCE7F3}',
      '.pm-diff-badge-reshaping{color:#FCE7F3;background:#C64F91}',
      '.pm-diff-badge.pm-safety-badge{color:#B42318;background:#FEE4E2;cursor:default}',
      '.pm-reshaped-tag{background:transparent!important;border-color:transparent!important;padding:0!important;height:auto!important;min-width:0!important}',
      '.pm-reshaped-static{color:#C64F91;background:#FCE7F3;border-radius:var(--dsw-radius-xs);display:inline-flex;align-items:center;height:19px;padding:0 5px;font-size:10px;font-weight:650;line-height:16px}',
    ].join(String.fromCharCode(10));
    function installPmStyles() {
      if (typeof document === 'undefined' || document.head === null) return;
      if (document.querySelector('style[data-pm-ui]') !== null) return;
      const style = document.createElement('style');
      style.dataset.pmUi = '';
      style.textContent = PM_UI_CSS;
      document.head.appendChild(style);
    }

    /**
    * 包装一个官方事件定义：match 命中隐藏事件时返回 null。
    * @param {object} definition - 官方事件定义。
    * @returns {object} 包装后的定义。
    */
    function wrapDefinition(definition) {
      if (definition === null || typeof definition !== 'object') return definition;
      const wrapMatch = (match) => {
        if (typeof match === 'function') return (event, ...rest) => (isHiddenEvent(event) ? null : match(event, ...rest));
        if (match !== null && typeof match === 'object') {
          const table = {};
          for (const key of Object.keys(match)) {
            const handler = match[key];
            table[key] = typeof handler === 'function'
              ? (event, ...rest) => (isHiddenEvent(event) ? null : handler(event, ...rest))
              : handler;
          }
          return table;
        }
        return match;
      };
      return { ...definition, match: wrapMatch(definition.match) };
    }

    function installReregister(fn) {
      reregisterDefinitions = fn;
    }
    function reregister() {
      if (reregisterDefinitions === undefined) return;
      try {
        reregisterDefinitions();
      } catch {
        // 重注册失败不应打断 UI；下一拍数据更新会再试
      }
    }
    function publish(sessionId, data) {
      const state = stateOf(sessionId);
      const fingerprint = String(generationCount(data)) + ':' + String(Array.isArray(data?.replacements) ? data.replacements.length : 0) + ':' + String(data?.current ?? -1);
      const previousTotal = generationCount(state.data);
      state.data = data;
      activeState = state;
      refreshSeqOrder();
      const nextTotal = generationCount(data);
      if (nextTotal > previousTotal) {
        // 新一代出现：上一代（此前是 live，不缓存）此刻起成为不可变历史 → 转入缓存。
        for (const [key, snapshot] of [...liveSnapshots]) {
          const parts = key.split(':');
          const gen = Number(parts[parts.length - 1]);
          if (Number.isSafeInteger(gen) && gen < nextTotal - 1) {
            snapshotCache.set(key, snapshot);
            liveSnapshots.delete(key);
          }
        }
      }
      if (state.fingerprint !== fingerprint) {
        state.fingerprint = fingerprint;
        reregister();
      }
      notifyAll();
    }

    /** 官方装配快照的来源包装：历史世代走缓存，最新（live）世代永不缓存。 */
    /** 快照是否真的属于该世代（防止把「装配未完成时的旧快照」写进缓存）。 */
    function isValidSnapshot(snapshot, gen, expanding) {
      const state = activeState;
      const data = state === undefined ? undefined : state.data;
      if (snapshot === undefined || snapshot === null || data === undefined || data === null) return true;
      const generations = Array.isArray(data.generations) ? data.generations : [];
      if (generations.length === 0 || gen >= generations.length - 1) return true;
      const cutoff = Number.isFinite(generations[gen]?.asOfSeq) ? generations[gen].asOfSeq : Number.POSITIVE_INFINITY;
      const hidden = new Set();
      for (const rep of Array.isArray(data.replacements) ? data.replacements : []) {
        if (rep.gen > gen) continue;
        for (const seq of Array.isArray(rep.shadowed) ? rep.shadowed : []) hidden.add(seq);
      }
      if (expanding && expandedGen === gen) for (const seq of expandedCovered) hidden.delete(seq);
      const nodes = Array.isArray(snapshot.eventNodes) ? snapshot.eventNodes : [];
      const nodeSeqs = new Set(nodes.map((node) => (node === null || node === undefined ? undefined : node.seq)));
      // 必须包含「该代自己的替代消息」：只有全量装配到这一代才会有它。
      // 缺少它说明拿到的是上一代/更早的快照（它同样合法、也不是未来节点）→ 不可缓存。
      if (gen >= 1) {
        const own = (Array.isArray(data.replacements) ? data.replacements : []).find((entry) => entry.gen === gen);
        if (own !== undefined && !nodeSeqs.has(own.repl)) return false;
      }
      // 展开变体必须包含覆盖区间（否则只是未展开的 base 快照）。
      if (expanding) {
        for (const seq of expandedCovered) if (!nodeSeqs.has(seq)) return false;
      }
      for (const node of nodes) {
        if (node === null || node === undefined || typeof node.seq !== 'number') continue;
        if (node.seq > cutoff) return false;
        if (hidden.has(node.seq)) return false;
      }
      return true;
    }
    /** 按当前世代的官方 surface 顺序重排快照节点（替代消息回到被替换区间的位置）。 */
    /** 当前世代官方 surface 顺序：seq → 位置。供 vendored 装配器排序使用。 */
    function refreshSeqOrder() {
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return;
      const generations = Array.isArray(state.data.generations) ? state.data.generations : [];
      const seqs = Array.isArray(generations[effectiveGeneration(state)]?.seqs) ? generations[effectiveGeneration(state)].seqs : [];
      const order = new Map();
      for (let index = 0; index < seqs.length; index += 1) order.set(seqs[index], index);
      globalThis.__PM_SEQ_ORDER__ = order;
    }
    function orderSnapshot(snapshot) {
      if (snapshot === null || snapshot === undefined) return snapshot;
      const state = activeState;
      if (state === undefined || state.data === undefined || state.data === null) return snapshot;
      const generations = Array.isArray(state.data.generations) ? state.data.generations : [];
      const gen = effectiveGeneration(state);
      const seqs = Array.isArray(generations[gen]?.seqs) ? generations[gen].seqs : [];
      if (seqs.length === 0 || !Array.isArray(snapshot.eventNodes)) return snapshot;
      const position = new Map();
      for (let index = 0; index < seqs.length; index += 1) position.set(seqs[index], index);
      let last = 0;
      const decorated = snapshot.eventNodes.map((node, index) => {
        let pos = node !== null && node !== undefined && position.has(node.seq) ? position.get(node.seq) : -1;
        if (pos < 0) pos = last; else last = pos;
        return { node, pos, index };
      });
      decorated.sort((left, right) => (left.pos - right.pos) || (left.index - right.index));
      return { ...snapshot, eventNodes: decorated.map((entry) => entry.node) };
    }
    function wrapTargetSource(sessionId, delegate) {
      const rawDelegate = delegate;
      // getSnapshot 必须返回稳定引用（useSyncExternalStore 要求），否则会无限重渲染。
      let lastRaw;
      let lastOrdered;
      let lastGen = -1;
      delegate = {
        getSnapshot: () => {
          refreshSeqOrder();
          const raw = rawDelegate.getSnapshot();
          const gen = activeState === undefined ? -1 : effectiveGeneration(activeState);
          if (raw === lastRaw && gen === lastGen) { lastDeliveredSnapshot = lastOrdered; return lastOrdered; }
          lastRaw = raw;
          lastGen = gen;
          lastOrdered = orderSnapshot(raw);
          lastDeliveredSnapshot = lastOrdered;
          return lastOrdered;
        },
        subscribe: (listener) => rawDelegate.subscribe(listener),
      };
      lastSourceDelegate = delegate;
      const retry = () => {
        if (typeof setTimeout === 'function') setTimeout(() => notifyAll(), 0);
      };
      return {
        getSnapshot() {
          const state = activeState;
          const total = state === undefined ? 0 : generationCount(state.data);
          const current = total === 0 ? 0 : total - 1;
          const selected = state === undefined ? 0 : effectiveGeneration(state);
          const live = total === 0 || selected >= current;
          const expanding = expandedReshapeSeq !== undefined && selected === expandedGen;
          const baseKey = cacheKey(sessionId, selected);
          const variantKey = baseKey + (expanding ? ':expanded:' + String(expandedReshapeSeq) : ':base');
          if (!live) {
            const cache = expanding ? expandedVariantCache : snapshotCache;
            if (cache.has(variantKey) || (!expanding && cache.has(baseKey))) {
              const cached = cache.get(variantKey) ?? cache.get(baseKey);
              if (isValidSnapshot(cached, selected, expanding)) return cached;
              cache.delete(variantKey);
              cache.delete(baseKey);
            }
          }
          const snapshot = delegate.getSnapshot();
          if (!live) {
            if (isValidSnapshot(snapshot, selected, expanding)) {
              if (expanding) expandedVariantCache.set(variantKey, snapshot);
              else snapshotCache.set(baseKey, snapshot);
            } else {
              retry();
            }
          } else if (total > 0) {
            liveSnapshots.set(cacheKey(sessionId, current), snapshot);
          }
          return snapshot;
        },
        subscribe(listener) {
          const dispose = delegate.subscribe(listener);
          globalListeners.add(listener);
          return () => {
            globalListeners.delete(listener);
            dispose();
          };
        },
      };
    }
    function prepareSnapshot(gen) {
      if (activeState === undefined) return false;
      const sessionId = viewContext === undefined ? undefined : viewContext.sessionId;
      const key = cacheKey(sessionId, gen);
      if (snapshotCache.has(key)) return true;
      if (lastSourceDelegate === undefined) return false;
      assemblyOverride = gen;
      try {
        reregister();
        snapshotCache.set(key, lastSourceDelegate.getSnapshot());
      } catch {
        return false;
      } finally {
        assemblyOverride = undefined;
        reregister();
      }
      return true;
    }
    function installOfficialView(view) {
      officialView = view;
    }
    function publishViewContext(context) {
      viewContext = context;
    }
    /** 切到某个世代；null 或最新一代 = 跟随最新。 */
    function captureScroll() {
      if (typeof document === 'undefined') return null;
      const tables = [...document.querySelectorAll('[data-scroll-ready="true"]')];
      for (const table of tables) {
        let pane = table.parentElement;
        while (pane !== null && pane !== undefined) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(pane) : null;
          if (style !== null && (style.overflowY === 'auto' || style.overflowY === 'scroll')) return { element: pane, top: pane.scrollTop };
          pane = pane.parentElement;
        }
      }
      return null;
    }
    function restoreScroll(saved) {
      if (saved === null || saved === undefined || typeof requestAnimationFrame !== 'function') return;
      const apply = () => { if (saved.element.isConnected) saved.element.scrollTop = saved.top; };
      requestAnimationFrame(apply);
      setTimeout(apply, 80);
    }
    function setGeneration(gen, anchor) {
      if (activeState === undefined) return;
      if (expandedReshapeSeq !== undefined) {
        expandedReshapeSeq = undefined;
        expandedGen = -1;
        expandedCovered = new Set();
        reshapeVersionCounter += 1;
        invalidateFilterCaches();
      }
      const savedScroll = anchor === undefined || anchor === null ? captureScroll() : null;
      const total = generationCount(activeState.data);
      activeState.gen = gen === null || total === 0 || gen >= total - 1 ? null : Math.max(0, gen);
      refreshSeqOrder();
      reregister();
      notifyAll();
      if (anchor !== undefined && anchor !== null) {
        scheduleAnchorRestore(anchor);
      } else if (typeof setTimeout === 'function') {
        setTimeout(() => restoreScroll(savedScroll), 0);
      }
    }
    /**
    * 直接按坐标定位：目标 seq 在目标世代 surface 里的序号 × 行高，一次性设置 scrollTop。
    * 不依赖「找到目标行 DOM」或「与点击位置比较」，避免行 key 不含 seq 时反复重置到固定点。
    */
    function scheduleAnchorRestore(anchor) {
      const findPane = () => {
        if (anchor.pane !== undefined && anchor.pane !== null && anchor.pane.isConnected) return anchor.pane;
        const tables = typeof document === 'undefined' ? [] : [...document.querySelectorAll('[data-scroll-ready="true"]')].filter((candidate) => { const rect = candidate.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
        const table = tables.length > 0 ? tables[0] : null;
        if (table === null || table === undefined) return null;
        let pane = table.parentElement;
        while (pane !== null && pane !== undefined) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(pane) : null;
          if (style !== null && (style.overflowY === 'auto' || style.overflowY === 'scroll')) return pane;
          pane = pane.parentElement;
        }
        return null;
      };
      let attempts = 0;
      const apply = () => {
        attempts += 1;
        const pane = findPane();
        if (pane === null || pane === undefined) {
          if (attempts < 120 && typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
          return;
        }
        const state = activeState;
        const generations = state !== undefined && state.data !== null && state.data !== undefined && Array.isArray(state.data.generations) ? state.data.generations : [];
        const gen = state === undefined ? 0 : effectiveGeneration(state);
        const seqs = Array.isArray(generations[gen]?.seqs) ? generations[gen].seqs : [];
        const index = seqs.indexOf(anchor.seq);
        if (index < 0) return;
        const space = 'calc(var(--dsh-trajectory-bottom-clearance, 0px) + 60vh)';
        if (pane.style.paddingBottom !== space) pane.style.paddingBottom = space;
        // 行高 30px；tabular header 约 30px，让目标行落在表头下方而不是被遮住。
        pane.scrollTop = Math.max(0, index * 30 - 30);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
      setTimeout(apply, 120);
      setTimeout(apply, 350);
    }
    let loadAllBusy = false;
    let lastDeliveredSnapshot;
    const PAGER_CSS = [
      '.pm-pgs{flex:none;display:flex;align-items:center;gap:3px;margin-left:auto;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}',
      '.pm-pgs + *{margin-left:8px!important}',
      '.pm-pgs .pm-pgs-label{padding:0 3px;color:var(--dsw-alias-label-tertiary)}',
      '.pm-pgs button{box-sizing:border-box;min-width:22px;height:22px;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:2px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;line-height:20px;cursor:pointer}',
      '.pm-pgs button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.pm-pgs button.pm-pgs-current{background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.pm-pgs .pm-pgs-gap{color:var(--dsw-alias-label-tertiary);padding:0 2px}',
      '.pm-pgs .pm-pgs-logical{display:inline-flex;align-items:center;gap:3px;margin-left:8px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l3)}',
    ].join(String.fromCharCode(10));
    function generationButtons(current, last) {
      const out = [];
      const push = (value) => { if (!out.includes(value)) out.push(value); };
      push(0);
      const from = Math.max(1, current - 2);
      const to = Math.min(last - 1, current + 2);
      if (from > 1) out.push('…');
      for (let gen = from; gen <= to; gen++) push(gen);
      if (to < last - 1) out.push('…');
      push(last);
      return out;
    }
    function visiblePane() {
      if (typeof document === 'undefined') return null;
      for (const table of document.querySelectorAll('[data-scroll-ready="true"]')) {
        const rect = table.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        let pane = table.parentElement;
        while (pane !== null && pane !== undefined) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(pane) : null;
          if (style !== null && (style.overflowY === 'auto' || style.overflowY === 'scroll')) return pane;
          pane = pane.parentElement;
        }
      }
      return null;
    }
    function loadedRowCount() {
      return lastDeliveredSnapshot !== undefined && Array.isArray(lastDeliveredSnapshot.eventNodes) ? lastDeliveredSnapshot.eventNodes.length : 0;
    }
    async function loadAllHistory() {
      if (loadAllBusy) return;
      if (viewContext === undefined || viewContext.hooks === undefined || typeof viewContext.hooks.loadOlder !== 'function') return;
      loadAllBusy = true;
      notifyAll();
      let stable = 0;
      for (let round = 0; round < 300; round += 1) {
        const pane = visiblePane();
        const before = loadedRowCount();
        try { await viewContext.hooks.loadOlder(); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 80));
        const after = loadedRowCount();
        if (pane !== null && pane !== undefined && after > before) {
          pane.scrollTop += (after - before) * 30;
        }
        if (after <= before) { stable += 1; if (stable >= 2) break; } else stable = 0;
      }
      loadAllBusy = false;
      notifyAll();
    }
    function LoadAllButton({ t }) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, []);
      return h('button', {
        type: 'button',
        className: 'pm-load-all',
        disabled: loadAllBusy,
        title: pmUiText(t, 'pm.loadAllTitle', 'Load all trajectory rows in the current generation'),
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); loadAllHistory(); },
      }, pmUiText(t, loadAllBusy ? 'pm.loading' : 'pm.loadAll', loadAllBusy ? 'Loading…' : 'Load all'));
    }
    function GenerationPagination({ t }) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, []);
      const state = activeState;
      const total = state === undefined ? 0 : generationCount(state.data);
      if (state === undefined || total < 2) return null;
      const current = effectiveGeneration(state);
      const last = total - 1;
      const items = [h('span', { key: 'label', className: 'pm-pgs-label' }, pmUiText(t, 'pm.pagerLabel', 'Generations'))];
      for (const [index, item] of generationButtons(current, last).entries()) {
        if (item === '…') {
          items.push(h('span', { key: 'gap' + String(index), className: 'pm-pgs-gap' }, '…'));
          continue;
        }
        const gen = item;
        const isCurrent = gen === current;
        items.push(h('button', {
          key: 'g' + String(gen),
          type: 'button',
          className: isCurrent ? 'pm-pgs-current' : '',
          'aria-current': isCurrent ? 'true' : undefined,
          title: pmUiText(t, 'pm.pagerTitle', 'Generation') + ' ' + String(gen),
          onClick: () => setGeneration(gen === last ? null : gen),
        }, String(gen)));
      }
      const pages = Array.isArray(state.data.logicalPages) ? state.data.logicalPages : [];
      if (pages.length > 0) {
        const logicalItems = [h('span', { key: 'llabel', className: 'pm-pgs-label' }, pmUiText(t, 'pm.logicalPagerLabel', 'Logical'))];
        for (const page of pages) {
          const isCurrent = page.physical === current;
          const title = t === undefined || t === null
            ? 'Logical generation ' + String(page.logical) + ' (physical page ' + String(page.physical) + ')'
            : t('pm.logicalPageTitle', { logical: page.logical, physical: page.physical });
          logicalItems.push(h('button', {
            key: 'l' + String(page.logical),
            type: 'button',
            className: isCurrent ? 'pm-pgs-current' : '',
            'aria-current': isCurrent ? 'true' : undefined,
            title,
            onClick: () => setGeneration(page.physical === last ? null : page.physical),
          }, 'L' + String(page.logical)));
        }
        items.push(h('div', { key: 'logical', className: 'pm-pgs-logical' }, logicalItems));
      }
      return h('div', { className: 'pm-pgs', 'data-pm-pages': '' }, [h('style', { key: 'css' }, PAGER_CSS), ...items]);
    }

    const bridge = {
      isHiddenEvent,
      wrapDefinition,
      installReregister,
      publish,
      setGeneration,
      wrapTargetSource,
      prepareSnapshot,
      applyReshapeRecords,
      reshapeVersion,
      applyReshapeVirtualRows,
      toggleReshape,
      isCoveredEarlierReplacement,
      installOfficialView,
      publishViewContext,
      isReshapedCell,
      hiddenLabel,
      isHiddenReplacement,
      diffNativeTag,
      reshapeTagLabel,
      coveredNodesOf,
      pagination: (t) => (t !== undefined && t !== null && t.__pmEmbedded === true ? null : h(GenerationPagination, { t })),
      loadAllButton: () => null,
    };
    installPmStyles();
    // 必须先放进 global：vendor 模块在 require 时执行，之后 apply/render 都要读它。
    globalThis.__PM_UI__ = bridge;

    const vendor = require('pm-trajectory-vendor');
    return {
      inject: vendor.inject,
      apply(ctx) {
        vendor.apply(ctx);
      },
    };
  },
});