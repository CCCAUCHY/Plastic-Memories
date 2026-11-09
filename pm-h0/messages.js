/**
 * PM · 用 DSH 自己的消息投影读取任意日志前缀。
 *
 * 和捕获器同一管线：session 日志前缀 → DSH surface/投影 → deriveMessages()。
 * 不经过 replaySurface / unitOfSeq / UI cell 排序。
 *
 * @module dsh-plugin-plastic-memories-h0/messages
 */

import { logicalGenerations, lockedSeqs } from './engine.js';
import { classifyMessage } from './units.js';

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
 * 当前上下文的 Message[] 视图。
 * @param {object} session
 * @param {boolean} [preview]
 */
export function retrospectMessages(session, preview = false) {
  const messages = compactMessages(session, currentInputMessages(session));
  const logical = logicalGenerations(session).total;
  if (preview) {
    return { logical, count: messages.length, preview: true, messages: messages.map((message) => ({
      ...message,
      text: message.text.length <= 240 ? message.text : message.text.slice(0, 180) + '……' + message.text.slice(-40),
    })) };
  }
  return { logical, count: messages.length, messages };
}

/**
 * 当前这次请求真正提交给模型的输入：排除最新 assistant 输出。
 * 工具执行时当前 assistant（含本次 tool call）已经在 surface 上，但它不是输入。
 * @param {object} session
 * @returns {Array<object>} DSH Message[]
 */
export function currentInputMessages(session) {
  let cutoff;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'assistant/message' && Number.isSafeInteger(event.seq)) cutoff = event.seq;
  }
  return cutoff === undefined ? session.deriveMessages() : messagesAt(session, cutoff);
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
 * @param {object} session
 * @param {Array<object>} messages
 * @returns {Array<object>} [{n,unit,type,text,calls?,locked?}]
 */
export function compactMessages(session, messages) {
  const byId = new Map();
  for (const event of session.snapshotEvents()) {
    const id = event?.data?.message?.id;
    if (typeof id === 'string') byId.set(id, event);
  }
  const locks = lockedSeqs(session);
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
    const event = byId.get(message?.id);
    const entry = {
      n: out.length,
      unit,
      type: classifyMessage(message).type,
      text: textOf(message),
    };
    if (calls.length > 0) entry.calls = calls.map((call) => call.name);
    if (event !== undefined && Number.isSafeInteger(event.seq) && locks.has(event.seq)) entry.locked = true;
    out.push(entry);
  }
  return out;
}

