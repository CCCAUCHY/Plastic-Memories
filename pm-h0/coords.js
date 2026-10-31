/**
 * PM · 坐标层。
 *
 * 工作面（Surface）的**唯一**访问入口。engine / 工具层都不该再自己遍历
 * §session.surface.nodes§ 或自己判事件类型 —— 那些散落的遍历曾是 bug 的温床
 * （两处 §SURFACE_TYPES§ 定义、三种 §callId§ 读法、七处重复遍历）。
 *
 * 三件事：
 * 1. **归一化**：宿主的消息形态（§id§ vs §callId§、§arguments§ 是 JSON 字符串）只在这里处理一次；
 * 2. **定位**：把「调用 id / 文本 / 相对位置」解析成工作面下标；
 * 3. **快照**：带世代号的工作面清单，供查询与预览共用。
 *
 * @module dsh-plugin-plastic-memories-h0/coords
 */

import { describeGroupings, openSetProfile } from './grouping.js';

/** 能产生模型可见消息的事件类型（= 工作面上的节点）。**全插件只有这一份定义。** */
export const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. 归一化：宿主消息形态只在这里读一次
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取 tool-call 块的调用 id。
 *
 * 实时会话里它在 §id§ 上（§dsh-llm/lib/types/types.d.ts:85-92§ 的 §ToolCallId§），
 * 离线/规范化形态可能在 §callId§ 上 —— 两种都认。
 * @param {unknown} block - 内容块。
 * @returns {string|undefined} 调用 id。
 */
export function callIdOf(block) {
  if (block === null || typeof block !== 'object') return undefined;
  const id = block.callId ?? block.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * 取 tool/result 所应答的调用 id。
 * @param {unknown} message - tool/result 事件里的消息。
 * @returns {string|undefined} 调用 id。
 */
export function resultCallIdOf(message) {
  if (message === null || typeof message !== 'object') return undefined;
  const id = message.toolCallId ?? message.source?.callId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * 把 tool-call 块的 §arguments§ 归一化成对象。
 *
 * 实时会话里它是**模型产出的原始 JSON 字符串**（§types.d.ts:90-91§），不是对象。
 * @param {unknown} raw - 原始值。
 * @returns {object} 参数对象；解析失败给空对象（交给逐条校验告警）。
 */
export function parseCallArgs(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把 PTC 嵌套调用的 id 拆成 {ownerCallId, selfCallId}。
 * 形如 §<rootCallId>:ptc:N§；native 调用两者相同。
 * @param {string} callId - exec.callId。
 * @returns {{ownerCallId: string, selfCallId: string}} 拆分结果。
 */
export function splitCallId(callId) {
  const cut = typeof callId === 'string' ? callId.indexOf(':ptc:') : -1;
  return cut === -1
    ? { ownerCallId: callId, selfCallId: callId }
    : { ownerCallId: callId.slice(0, cut), selfCallId: callId };
}

/** 事件类型 → 派生角色。 */
export function roleOfEvent(event) {
  switch (event.type) {
    case 'user/message': return 'user';
    case 'developer/message': return 'developer';
    case 'assistant/message': return 'assistant';
    case 'tool/result': return 'tool';
    case 'system/message': return 'system';
    default: return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 消息文本
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取一条事件的派生消息；失败或非工作面类型时返回 §undefined§。
 * @param {object} session - 目标会话。
 * @param {object} event - 会话事件。
 * @returns {object|undefined} 派生消息。
 */
export function derivedMessage(session, event) {
  if (event === undefined || !SURFACE_TYPES.has(event.type)) return undefined;
  try {
    return session.deriveEventMessage(event) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取一条消息的纯文本（含工具调用的摘要形式）。
 * 这是 §text_start§ / §text_end§ 的匹配对象。
 * @param {object|undefined} message - 派生消息。
 * @returns {string} 可匹配文本。
 */
export function messageText(message) {
  if (message === undefined || message === null || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
    else if (block.type === 'tool-call') parts.push('[tool-call ' + String(block.name) + ' ' + String(block.arguments ?? '') + ']');
  }
  return parts.join(String.fromCharCode(10));
}

/**
 * 自适应截断：短消息整条显示，长消息保留首尾（预览专用）。
 * @param {string} text - 原文。
 * @param {number} head - 头部保留字符数。
 * @param {number} tail - 尾部保留字符数。
 * @returns {string} 单行摘要。
 */
export function clip(text, head = 80, tail = 40) {
  const oneLine = String(text).replace(/s+/g, ' ').trim();
  if (oneLine.length <= head + tail + 5) return oneLine;
  return oneLine.slice(0, head) + '……' + oneLine.slice(-tail);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 工作面快照与定位
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取当前工作面的节点 seq 列表（副本）。
 * @param {object} session - 目标会话。
 * @returns {number[]} 节点 seq。
 */
export function surfaceNodes(session) {
  return [...session.surface.nodes];
}

/**
 * 把一个 seq 解析成工作面下标。
 * @param {object} session - 目标会话。
 * @param {number} seq - 事件 seq。
 * @returns {number} 下标；不在工作面上时 §-1§。
 */
export function indexOfSeq(session, seq) {
  return surfaceNodes(session).indexOf(seq);
}

/**
 * 把当前工作面拍成带世代号的清单。
 *
 * 世代内序号是**稳定前缀**：新消息追加在尾部、替换是原位的，已有位置不动（已实测）。
 * @param {object} session - 目标会话。
 * @returns {{generation: number, nodes: number[], entries: Array<object>}} 快照。
 */
export function snapshotSurface(session) {
  const nodes = surfaceNodes(session);
  const entries = nodes.map((seq, index) => {
    const event = session.eventAt(seq);
    const message = derivedMessage(session, event);
    return { seq, index, event, message, text: messageText(message) };
  });
  return { generation: session.surface.replaceGeneration, nodes, entries };
}

/**
 * 找出承载某个调用 id 的那条 assistant 消息，返回它的下标与全部同组调用。
 *
 * 实时（native）调用的 id 就在消息里；PTC 嵌套调用要传它的 §rootCallId§。
 * @param {object} session - 目标会话。
 * @param {string} ownerCallId - 承载消息的调用 id。
 * @returns {{index: number, seq: number, turn: number|undefined, step: number|undefined, calls: Array<{callId: string, name: string}>}|undefined}} 承载信息。
 */
export function indexOfCall(session, ownerCallId) {
  const nodes = surfaceNodes(session);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const event = session.eventAt(nodes[i]);
    if (event === undefined || event.type !== 'assistant/message') continue;
    const content = event.data.message.content;
    if (!Array.isArray(content)) continue;
    const calls = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'tool-call');
    if (!calls.some((c) => callIdOf(c) === ownerCallId)) continue;
    return {
      index: i,
      seq: nodes[i],
      turn: event.data.turn,
      step: event.data.step,
      calls: calls.map((c) => ({ callId: callIdOf(c), name: String(c.name) })),
    };
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 同一步的其它调用
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 列出本步里**除了本次调用之外**的其它工具调用。
 *
 * 用途是工具回执里的**告知**（「本步还调用了 X，它的结果会被一并隐去」），
 * 不是拒绝 —— 要不要连同步里其它结果一起自噬，由模型自己决定。
 *
 * 两种呈现分别取证：
 * - PTC：同一 rootCallId 下的全部 tool/ptc-dispatch-start；
 * - native：承载 ownerCallId 的那条 assistant 消息里的全部 tool-call 块。
 * @param {object} session - 目标会话。
 * @param {string} ownerCallId - 承载本次调用的调用 id（PTC 下是 rootCallId）。
 * @param {string} selfCallId - 本次调用自己的 id，会被排除。
 * @returns {Array<{callId: string, name: string}>} 同伴调用清单；空表示本步是干净的。
 */
export function stepPeers(session, ownerCallId, selfCallId) {
  const ptc = [];
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/ptc-dispatch-start') continue;
    if (event.data?.rootCallId !== ownerCallId) continue;
    ptc.push({ callId: event.data?.subCallId, name: String(event.data?.name) });
  }
  if (ptc.length > 0) return ptc.filter((c) => c.callId !== selfCallId);
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined || event.type !== 'assistant/message') continue;
    const content = event.data.message.content;
    if (!Array.isArray(content)) continue;
    const calls = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'tool-call');
    if (!calls.some((c) => callIdOf(c) === ownerCallId)) continue;
    return calls.map((c) => ({ callId: callIdOf(c), name: String(c.name) })).filter((c) => c.callId !== selfCallId);
  }
  return [];
}
// ─────────────────────────────────────────────────────────────────────────────
// 4. tool-call / tool-result 配对
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐个工作面位置计算「未闭合关系」的开集大小，用于判断切口是否平衡。
 *
 * **实现已下沉到 grouping.js** —— 这里只保留导出名，
 * 让「什么算合法切口」在全插件只有一处定义（开集归零）。
 * @param {object} session - 目标会话。
 * @returns {{before: Map<number, number>, after: Map<number, number>, malformed: number}} 结果。
 */
export function pairingMaps(session) {
  return openSetProfile(session);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 区间配对平衡校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验一个区间**配对平衡**（不拆开 tool-call / tool-result）。
 *
 * 这条校验的由来是一次实测事故：投影区间的一端切在工具对中间 ——
 * assistant/message（带 tool-call）留在工作面上、它的 tool/result 被吞掉。
 * 后果是 pairingMaps 的开集**永不闭合**：之后每一次操作都被判「拆开配对」，
 * 插件彻底卡死（在 session-d7e22544 那份真实日志里实测到 8 个位置开集不为 0）。
 *
 * @param {object} session - 目标会话。
 * @param {number} startIndex - 起点下标。
 * @param {number} endIndex - 终点下标。
 * @returns {{ok: boolean, reason?: string}} 校验结果。
 */
export function checkBalanced(session, startIndex, endIndex) {
  const nodes = surfaceNodes(session);
  const startSeq = nodes[startIndex];
  const endSeq = nodes[endIndex];
  if (startSeq === undefined || endSeq === undefined) return { ok: false, reason: 'span endpoints are not on the current surface' };
  const { before, after } = pairingMaps(session);
  const beforeOk = (before.get(startSeq) ?? 1) === 0;
  const afterOk = (after.get(endSeq) ?? 1) === 0;
  if (beforeOk && afterOk) return { ok: true };
  const which = !beforeOk && !afterOk ? 'both ends' : beforeOk ? 'after the end' : 'before the start';
  return {
    ok: false,
    // 按注册表说出**是哪种组合**被拆开 —— 不写死 tool-call，
    // 将来加了新组合类型，错误信息自动跟上（见 grouping.js 的扩展指南）。
    reason: 'this span would split ' + describeGroupings() + ' at ' + which + ' (real providers reject that). Align the span to the unit boundary.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 本步整组（msg_* = 0 的语义）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 求「本步整组」在工作面上的下标区间。
 *
 * **msg_* = 0 的真正含义**：不是「当前这条消息」，而是**到这一步彻底结束为止** ——
 * 包含承载调用的那条 assistant 消息**以及它的全部工具结果**。
 *
 * 为什么必须有这个概念：工具在自己的 execute 里运行时，**它自己的 tool/result 还没落地**。
 * 「本步整组」的后边界此刻不存在，所以含 0 的范围**只能在提交边界上解析** ——
 * 这就是所有投影都必须延迟的根本原因。
 *
 * 若当场就把自己替换掉，随后落地的 tool/result 会失去它的调用消息，
 * 读侧以 does not match an open turn and step 拒绝整份日志（已实测）。
 *
 * @param {object} session - 目标会话。
 * @param {string} ownerCallId - 承载调用的调用 id（PTC 下传 rootCallId）。
 * @returns {{startIndex: number, endIndex: number, complete: boolean}|undefined}} 区间。
 */
export function stepGroup(session, ownerCallId) {
  const found = indexOfCall(session, ownerCallId);
  if (found === undefined) return undefined;
  const nodes = surfaceNodes(session);
  const want = new Set(found.calls.map((c) => c.callId));
  let last = found.index;
  for (let i = found.index + 1; i < nodes.length && want.size > 0; i++) {
    const event = session.eventAt(nodes[i]);
    if (event === undefined || event.type !== 'tool/result') break;
    const callId = resultCallIdOf(event.data.message);
    if (callId === undefined || !want.has(callId)) break;
    want.delete(callId);
    last = i;
  }
  return { startIndex: found.index, endIndex: last, complete: want.size === 0 };
}