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
 * @param {object} session - 当前会话。
 * @param {number} [before] - 只取 seq < before 的事件；省略表示当前全部。
 * @returns {Array<object>} DSH Message[]。
 */
export function messagesAt(session, before) {
  if (before === undefined || before === null || !Number.isSafeInteger(before)) {
    return session.deriveMessages();
  }
  const events = session.snapshotEvents().filter((event) => Number.isSafeInteger(event.seq) && event.seq < before);
  if (events.length === 0) return [];
  const SessionCtor = session.constructor;
  const probe = SessionCtor.create(
    session.id,
    events,
    session.header,
    0,
    session.surfaceManager?.projections,
  );
  return probe.deriveMessages();
}

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
 * 当前上下文的 Message[] 视图。
 * @param {object} session
 * @param {boolean} [preview] - true 时裁剪 text。
 * @param {string|number} [selectors] - 单值选择器；只返回这个选择器命中的单元行。
 */
export function retrospectMessages(session, preview = false, selectors = undefined, callId = undefined) {
  // self = 「本次调用的 assistant 消息之前」的日志前缀折叠，与历史世代同一条规则。
  const { window } = rowsAt(session, cutoffForCall(session, callId), { selectors });
  const logical = logicalGenerations(session).total;
  const messages = window.rows.map((row) => {
    const { id, ...rest } = row;
    return rest;
  });
  const body = preview
    ? messages.map((message) => ({
      ...message,
      text: message.text.length <= 240 ? message.text : message.text.slice(0, 180) + '……' + message.text.slice(-40),
    }))
    : messages;
  const head = {
    logical,
    count: body.length,
    ...(selectors === undefined ? {} : { total: window.total, units: window.selected }),
    ...(preview ? { preview: true } : {}),
  };
  return { ...head, messages: body };
}

/**
 * 当前这次请求真正提交给模型的输入：排除最新 assistant 输出。
 * 工具执行时当前 assistant（含本次 tool call）已经在 surface 上，但它不是输入。
 * @param {object} session
 * @returns {Array<object>} DSH Message[]
 */

/** 本次请求输入的截止 seq：最新 assistant 之前。 */
export function currentCutoff(session) {
  let cutoff;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'assistant/message' && Number.isSafeInteger(event.seq)) cutoff = event.seq;
  }
  return cutoff;
}

/**
 * 承载某次工具调用的 assistant 消息 seq（不含）。
 *
 * 与 currentCutoff 的区别：这里锚定**这一次调用**，而不是「最后一条 assistant 消息」。
 * 提交边界刚写过替代节点时，替代节点的 seq 会比最后一条 assistant 消息大；
 * 用 currentCutoff 会把它们一起裁掉，读到的是提交前的旧内容。
 *
 * @param {object} session - 目标会话。
 * @param {string} [callId] - 本次调用的 id。
 * @returns {number|undefined} 该 assistant 消息的 seq。
 */
export function cutoffForCall(session, callId) {
  if (typeof callId !== 'string') return undefined;
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    if (content.some((block) => block?.type === 'tool-call' && block.id === callId)) return event.seq;
  }
  return undefined;
}

export function currentInputMessages(session) {
  return messagesWithSeqs(session, currentCutoff(session)).map((entry) => entry.message);
}

/**
 * 消息 + 它来自的日志 seq（顺序就是 DSH surface 顺序）。
 * 有 seq 才能做安全区标记；deriveMessages() 只给内容不给 seq。
 * @param {object} session
 * @param {number} [before] - 只取 seq < before 的事件。
 * @returns {Array<{seq: number, message: object}>}
 */
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

