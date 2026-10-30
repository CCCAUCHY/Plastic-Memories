/**
 * Plastic Memories — 投影标记（browser-safe，无任何 import）。
 *
 * PM 的每一次投影都在被追加的 `user/message` 上挂一个 `source` 标记。
 * `MessageSourceMap` 是 merge-extensible 的（`dsh-llm/lib/types/message.d.ts:101`），
 * 运行时对未知 `kind` 不做校验，所以这不需要注册任何东西。
 *
 * 三条硬约束决定了这个模块的形态（见可行性报告 §5.14.1）：
 *   C1/C2  不能新增 session 事件类型 → 标记只能挂在既有类型的 source 上
 *   C4     `assistant/message` 不能作为替换节点 → 替换一律用 user/developer
 *   C6     只有 user/developer 的 source 可扩展 → 标记只能挂在这两种角色上
 *
 * 这个模块被 `index.js`、将来的客户端渲染、以及离线阅读器共用，
 * 因此**不允许**出现 `node:` 导入或任何 @deepseek-ai 包。
 *
 * @module dsh-plugin-plastic-memories-h0/markers
 */

/** 标记的 `kind`。消费者 switch 时落到它即可识别 PM 节点。 */
export const PM_SOURCE_KIND = 'pm-surface';

/** 标记的语义版本。世代记账与陈旧性判定都依赖它，改动必须 bump。 */
export const PM_MARKER_VERSION = 1;

/**
 * 构造一个 PM 投影标记。
 * @param {{op: string, callId?: string, generation: number, refs?: number[], note?: string}} op
 *   投影操作描述：
 *   - `op`         `'hide'` | `'stabilize'` | `'rehydrate'`
 *   - `callId`     产生这条投影的 PM 工具调用 id（**幂等键**，见 engine.js）
 *   - `generation` PM 世代号（单调递增）
 *   - `refs`       被遮蔽 / 被物化的原始事件 seq
 *   - `consumed`   这条投影同时「了结」的其它声明 callId。
 *     set + execute 解析出同一个区间时只写一次投影，但两条声明都必须记为已了结，
 *     否则下个边界会把 execute 再执行一遍（实测：PTC 下会多一次投影）。
 * @returns {Readonly<object>} 冻结的 source 对象。
 */
export function pmSource(op) {
  return Object.freeze({
    kind: PM_SOURCE_KIND,
    v: PM_MARKER_VERSION,
    op: op.op,
    ...(op.callId === undefined ? {} : { callId: op.callId }),
    generation: op.generation,
    ...(op.logicalGeneration === undefined ? {} : { logicalGeneration: op.logicalGeneration }),
    ...(op.refs === undefined ? {} : { refs: Object.freeze([...op.refs]) }),
    ...(op.consumed === undefined ? {} : { consumed: Object.freeze([...op.consumed]) }),
    ...(op.note === undefined ? {} : { note: op.note }),
  });
}

/**
 * 读取一条 PM 标记「了结」的全部 callId（含主 callId）。
 * @param {unknown} source - 任意 message source。
 * @returns {string[]} callId 列表（非 PM 标记为空数组）。
 */
export function pmSettledCallIds(source) {
  if (!isPmSource(source)) return [];
  const ids = [];
  if (typeof source.callId === 'string') ids.push(source.callId);
  if (Array.isArray(source.consumed)) {
    for (const id of source.consumed) if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/**
 * 判断一个 message source 是否是 PM 投影标记。
 * 对未知版本**仍然返回 true**（消费者应当识别出「这是 PM 的节点」），
 * 版本差异由调用方通过 {@link pmMarkerVersion} 自行处理。
 * @param {unknown} source - 任意 message source。
 * @returns {boolean} 是否为 PM 标记。
 */
export function isPmSource(source) {
  return (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    source.kind === PM_SOURCE_KIND
  );
}

/**
 * 读取标记的语义版本；不是 PM 标记时返回 `undefined`。
 * @param {unknown} source - 任意 message source。
 * @returns {number|undefined} 标记版本。
 */
export function pmMarkerVersion(source) {
  if (!isPmSource(source)) return undefined;
  const v = source.v;
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
}

/**
 * 从一条 message 上取 PM 标记；非 PM 节点返回 `undefined`。
 * @param {{source?: unknown}|undefined|null} message - 派生消息。
 * @returns {object|undefined} PM 标记。
 */
export function pmMarkerOf(message) {
  const source = message === null || message === undefined ? undefined : message.source;
  return isPmSource(source) ? source : undefined;
}