/**
 * PM · 用 DSH 自己的消息投影读取任意日志前缀。
 *
 * 和捕获器同一管线：session 日志前缀 → DSH surface/投影 → deriveMessages()。
 * 不经过 replaySurface / unitOfSeq / UI cell 排序。
 *
 * @module dsh-plugin-plastic-memories-h0/messages
 */

import { logicalGenerations, lockedSeqs } from './engine.js';
import { classifyMessage, selectUnits } from './units.js';
import { derivedMessage } from './coords.js';

/**
 * 任意切点的单元行：retrospect 的 self 与历史都只调这一个函数，只有 cut 不同。
 * @param {object} session
 * @param {number|undefined} cut - 折叠 seq < cut 的日志前缀；undefined 表示全量。
 * @param {{locks?: boolean, selectors?: (string|number)}} [options]
 * @returns {{window: object, entries: Array<object>}}
 */
export function rowsAt(session, cut, options = {}) {
  const entries = messagesWithSeqs(session, cut);
  const rows = compactMessages(session, entries, options.locks === false ? { locks: false } : {});
  return { window: windowRows(rows, options.selectors), entries };
}

/**
 * 承载某次工具调用的 assistant 消息 seq（不含）。
 *
 * 与「最后一条 assistant」不同：这里锚定**这一次调用**，
 * 提交边界写下的替代节点 seq 会更大，用「最后一条 assistant」会连带裁掉它们。
 *
 * @param {object} session - 目标会话。
 * @param {string} [callId] - 本次调用的 id。
 * @returns {number|undefined} 该 assistant 消息的 seq。
 */
export function cutoffForCall(session, callId) {
  if (typeof callId !== 'string') return undefined;
  // PTC 下 callId 是 subCallId（call_x:ptc:1），承载消息里的 tool-call 记的是 rootCallId。
  const cut = callId.indexOf(':ptc:');
  const owner = cut === -1 ? callId : callId.slice(0, cut);
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    if (content.some((block) => block?.type === 'tool-call' && (block.id === callId || block.id === owner))) return event.seq;
  }
  return undefined;
}

export function messagesWithSeqs(session, before) {
  let view = session;
  if (Number.isSafeInteger(before)) {
    const events = session.snapshotEvents().filter((event) => Number.isSafeInteger(event.seq) && event.seq < before);
    if (events.length === 0) return [];
    view = session.constructor.create(session.id, events, session.header, 0, session.surfaceManager?.projections);
  }
  const out = [];
  for (const seq of view.surface.nodes) {
    const message = derivedMessage(view, view.eventAt(seq));
    if (message !== undefined && message !== null) out.push({ seq, message });
  }
  return out;
}

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  // reasoning 的文本也是 assistant 消息内容的一部分；不能只看 type==='text'，
  // 否则只有思考 + tool-call 的 assistant 单元会显示为空。
  return content
    .filter((block) => typeof block?.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
    .join(String.fromCharCode(10));
}

function callsOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === 'tool-call' && typeof block.name === 'string')
    .map((block) => ({ id: typeof block.id === 'string' ? block.id : undefined, name: block.name }));
}

/**
 * 把捕获/DSH Message[] 合并成模型可过滤视图。
 * 顺序只来自 messages 数组；id 只用于查事件和锁，不输出。
 * 安全区只属于当前世代：历史世代不返回 locked（那时的锁还没建立）。
 * @param {object} session
 * @param {Array<object>} messages
 * @param {{locks?: boolean}} [options] - locks=false 时不标注安全区。
 * @returns {Array<object>} [{n,unit,type,text,calls?,locked?}]
 */
export function compactMessages(session, entries, options = {}) {
  const rows = groupRows(entries.map((entry) => entry.message));
  for (let index = 0; index < rows.length; index += 1) rows[index].seq = entries[index].seq;
  if (options.locks !== false) {
    const locks = lockedSeqs(session);
    for (const row of rows) if (locks.has(row.seq)) row.locked = true;
  }
  return rows;
}

/**
 * 只按消息内容分组单元（不依赖会话，预览用的影子工作面也能用）。
 * @param {Array<object>} messages - DSH Message[]。
 * @returns {Array<object>} [{n,unit,type,text,calls?,id?}]
 */
export function groupRows(messages) {
  const out = [];
  let unit = -1;
  let currentCallIds = new Set();
  for (const message of messages) {
    const calls = callsOf(message);
    const role = String(message?.role ?? '');
    const isTool = role === 'tool';
    const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined;
    const continuation = isTool && unit >= 0 && (currentCallIds.size === 0 || (callId !== undefined && currentCallIds.has(callId)));
    if (!continuation) {
      unit += 1;
      currentCallIds = new Set(calls.map((call) => call.id).filter((id) => typeof id === 'string'));
    } else if (callId !== undefined) {
      currentCallIds.delete(callId);
    }
    const entry = {
      n: out.length,
      unit,
      role: String(message?.role ?? 'unknown'),
      type: classifyMessage(message).type,
      text: textOf(message),
    };
    if (calls.length > 0) entry.calls = calls.map((call) => call.name);
    if (typeof message?.id === 'string') entry.id = message.id;
    out.push(entry);
  }
  return out;
}

/**
 * 按单元选择器裁窗口：行保持原编号，只丢掉未选中的。
 * @param {Array<object>} rows - groupRows / compactMessages 的结果。
 * @param {string|number|undefined} selector - 单值选择器；undefined 表示不裁。
 * @returns {{rows: Array<object>, total: number, selected: number[]|undefined}}
 */
export function windowRows(rows, selector) {
  if (selector === undefined || selector === null) return { rows, total: rows.length, selected: undefined };
  const unitCount = rows.length === 0 ? 0 : rows[rows.length - 1].unit + 1;
  const span = Array.from({ length: unitCount }, (_, index) => ({ n: index }));
  const selected = selectUnits(span, [selector]);
  const picked = new Set(selected);
  return { rows: rows.filter((row) => picked.has(row.unit)), total: rows.length, selected };
}

