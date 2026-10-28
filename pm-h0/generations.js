/**
 * Plastic Memories — 世代上下文（Host 投影单元）。
 *
 * 目标：让侧边栏 UI 能看**每个世代的真实上下文**（当前工作面在每个投影之后的样子），
 * 默认看最新一代，可以往回切。
 *
 * 为什么是 `sessionProjections` 单元：客户端不该自己折叠 session 事件
 * （见 cordis-plugin-development 的 practices：「Client 需要 session 派生的值时，
 * 在 Host 投影上声明 wire.view」）。本单元把 fold 结果作为**整值 JSON** 发布。
 *
 * 状态只含有界数据：
 *   - `seqs`      当前工作面的节点 seq（模型可见顺序）
 *   - `meta`      seq → 节点摘要（角色 / 文本 / 工具调用 / 是否 PM 投影）
 *   - `gens`      历代快照 { gen, asOfSeq, seqs }
 * 每代只多存一份 seq 数组，正文只存一份 —— 不做「每代复制全部正文」。
 *
 * 语义直接从 `dsh-session` 的 surface fold 抄来（源码级对齐）：
 *   - `surfaceOp === 'append'`   → 节点追加到队尾
 *   - `surfaceOp.op === 'replace'` → 用本事件替换 [startSeq, endSeq]，replaceGeneration += 1
 *   - 无 surfaceOp 的事件不改工作面（命令、cookie 之外的非消息事件、流式增量都不进 log）
 *   - 空内容的 developer 消息（PM 的纯空洞）对应 `deriveEventMessage === null`，
 *     节点仍在工作面上（后续投影可再遮它），但不产生模型消息。
 *
 * 本模块必须保持零 import：它运行在宿主进程里，profile 的 node_modules 解析不到
 * `@deepseek-ai/*` 运行时包（本包没有声明它们为依赖）。
 *
 * @module dsh-plugin-plastic-memories-h0/generations
 */

/** 投影键（客户端用 `useProjection('pmGenerations')` 读同名的 wire 值）。 */
export const GENERATIONS_KEY = 'pmGenerations';

/** 状态版本：字段或 fold 语义变了就 bump（持久化缓存据此丢弃旧行）。 */
export const GENERATIONS_STATE_VERSION = 3;

/**
 * 鸭子类型的 schema 替身。
 *
 * 注册表只调用 `stateSchema.parse(val)` 与 `viewSchema.parse(view)`（源码可查），
 * 所以这里不需要真正的 zod —— 本包刻意不依赖 `@deepseek-ai/*` 运行时包。
 * @param {unknown} value - 待校验值。
 * @returns {unknown} 原值。
 */
const passthroughSchema = Object.freeze({ parse: (value) => value });

/** 会产生模型消息的事件类型（dsh-session 的 SURFACE_EVENT_TYPES）。 */
const MESSAGE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/**
 * 取事件对应的模型消息（与 dsh-session 的 deriveEventMessage 同形）。
 * @param {object} event - 会话事件。
 * @returns {object|null} 消息；该事件不产生消息时为 null。
 */
function eventMessage(event) {
  const data = event?.data;
  if (data === undefined || data === null) return null;
  switch (event.type) {
    case 'user/message':
      return data;
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return data.message ?? null;
    default:
      return null;
  }
}

/** 把一段文本压成单行摘要（工具调用的参数在 UI 里不展开整行）。 */
function oneLine(text, head = 240, tail = 80) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= head + tail) return value;
  return value.slice(0, head) + '……' + value.slice(-tail);
}

/**
 * 把一条节点事件拍成 UI 用的摘要。
 * @param {object} event - 会话事件（surfaceOp 为 append/replace 的那些）。
 * @returns {object} 节点摘要（纯 JSON）。
 */
export function describeEvent(event) {
  const message = eventMessage(event);
  const source = message?.source;
  const projected = source?.kind === 'pm-surface';
  const content = Array.isArray(message?.content) ? message.content : [];
  const texts = [];
  const reasoning = [];
  const calls = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'tool-call') {
      calls.push({
        name: String(block.name ?? 'tool'),
        arguments: oneLine(block.arguments ?? ''),
        // 客户端事件级过滤需要 callId（隐藏的 assistant 消息 → 连带隐藏 tool/call 与 PTC 分发）。
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
      });
      continue;
    }
    if (typeof block.text !== 'string' || block.text.length === 0) continue;
    if (block.type === 'reasoning') reasoning.push(block.text);
    else texts.push(block.text);
  }
  const hidden = message === null || content.length === 0;
  return {
    seq: event.seq,
    type: event.type,
    role: String(message?.role ?? event.type.split('/')[0]),
    text: texts.join('\n'),
    ...(reasoning.length === 0 ? {} : { reasoning: reasoning.join('\n') }),
    ...(calls.length === 0 ? {} : { calls }),
    ...(projected ? { projected: true } : {}),
    ...(hidden ? { hidden: true, hiddenCount: Array.isArray(source?.refs) ? source.refs.length : 0 } : {}),
    ...(typeof message?.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(message?.isError === true ? { isError: true } : {}),
    // 轨迹行展示/详情用：turn/step 与来源类型（cookie / runtime-context / user / model / tool）。
    ...(Number.isSafeInteger(event.data?.turn) ? { turn: event.data.turn } : {}),
    ...(Number.isSafeInteger(event.data?.step) ? { step: event.data.step } : {}),
    ...(typeof source?.kind === 'string' ? { sourceKind: source.kind } : {}),
  };
}

/**
 * 初始状态（空日志）。
 * @returns {object} 投影状态（纯 JSON）。
 */
export function initState() {
  // raw  = **未投影时**的原始工作面节点（全部 append 事件，按 seq）；
  // reps = 每次替换的历史：{ gen, shadowed:[被遮 seq], repl: 替代节点 seq }。
  // 客户端据此把每一代拼成「可见行 + 遮罩块」：遮罩里显示替代文本，可逐层展开。
  return { gen: 0, asOfSeq: -1, seqs: [], meta: {}, gens: [], raw: [], reps: [], safety: [] };
}

/**
 * 纯 fold：一个会话事件 → 新状态（与事件无关时返回**同一个引用**）。
 * @param {object} state - 上一状态。
 * @param {object} event - 会话事件。
 * @returns {object} 下一状态。
 */
export function applyEvent(state, event) {
  if (event?.type === 'plugin:plastic-memories/locks') {
    const data = event.data ?? {};
    const set = new Set(Array.isArray(state.safety) ? state.safety : []);
    let seqs = [];
    if (Array.isArray(data.seqs)) seqs = data.seqs;
    else if (Array.isArray(data.add)) seqs = data.add;
    else if (data.mode === 'all') seqs = state.seqs;
    const op = data.op === 'unlock' ? 'unlock' : 'lock';
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq)) continue;
      if (op === 'unlock') set.delete(seq); else set.add(seq);
    }
    return { ...state, safety: [...set].sort((left, right) => left - right) };
  }

  const surfaceOp = event?.surfaceOp;
  if (surfaceOp === 'append') {
    if (!MESSAGE_EVENT_TYPES.has(event.type)) return state;
    return {
      ...state,
      asOfSeq: event.seq,
      seqs: [...state.seqs, event.seq],
      raw: [...state.raw, event.seq],
      meta: { ...state.meta, [String(event.seq)]: describeEvent(event) },
    };
  }
  if (surfaceOp === null || typeof surfaceOp !== 'object' || surfaceOp.op !== 'replace') return state;
  const startIndex = state.seqs.indexOf(surfaceOp.startSeq);
  const endIndex = state.seqs.indexOf(surfaceOp.endSeq);
  // 防御：区间端点必须在工作面上。真实日志里一定在；找不到就退化成「追加」，
  // 宁可少一代记录，也不让投影把整份状态写坏。
  const cutStart = startIndex === -1 ? state.seqs.length : startIndex;
  const cutEnd = endIndex === -1 || endIndex < cutStart ? cutStart - 1 : endIndex;
  const seqs = [...state.seqs];
  const shadowed = seqs.slice(cutStart, cutEnd + 1);
  seqs.splice(cutStart, cutEnd - cutStart + 1, event.seq);
  return {
    gen: state.gen + 1,
    asOfSeq: event.seq,
    seqs,
    raw: state.raw,
    meta: { ...state.meta, [String(event.seq)]: describeEvent(event) },
    gens: [...state.gens, { gen: state.gen, asOfSeq: state.asOfSeq, seqs: state.seqs }],
    reps: [...state.reps, { gen: state.gen + 1, shadowed, repl: event.seq }],
  };
}

/**
 * 状态 → 客户端 wire 值。
 *
 * 只发布「结构 + 每代 seq 列表 + 一份正文表」：
 *   - 客户端切世代只需换 seq 列表，正文永远只有一份；
 *   - `current` 等于「已经应用的投影个数」，也就是最新一代的编号。
 * @param {object} state - 投影状态。
 * @returns {{current: number, asOfSeq: number, generations: Array<object>, meta: object}} wire 值。
 */
export function viewOf(state) {
  const generations = [...state.gens, { gen: state.gen, asOfSeq: state.asOfSeq, seqs: state.seqs }];
  return {
    current: state.gen,
    asOfSeq: state.asOfSeq,
    generations,
    meta: state.meta,
    raw: state.raw,
    replacements: state.reps,
    safety: Array.isArray(state.safety) ? state.safety : [],
  };
}

/**
 * 投影定义（交给 `ctx.sessionProjections.register`）。
 * @returns {object} ProjectionDefinition。
 */
export function generationProjection() {
  return {
    key: GENERATIONS_KEY,
    stateVersion: GENERATIONS_STATE_VERSION,
    stateSchema: passthroughSchema,
    viewSchema: passthroughSchema,
    init: () => initState(),
    apply: (state, event) => applyEvent(state, event),
    wire: {
      viewSchema: passthroughSchema,
      view: (state) => viewOf(state),
    },
  };
}
