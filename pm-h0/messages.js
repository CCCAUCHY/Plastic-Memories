/**
 * PM · 用 DSH 自己的消息投影读取任意日志前缀。
 *
 * 和捕获器同一管线：session 日志前缀 → DSH surface/投影 → deriveMessages()。
 * 不经过 replaySurface / unitOfSeq / UI cell 排序。
 *
 * @module dsh-plugin-plastic-memories-h0/messages
 */

import { logicalGenerations } from './engine.js';

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
  const messages = messagesAt(session);
  const logical = logicalGenerations(session).self;
  if (preview) {
    return { logical, count: messages.length, preview: true, messages: messages.map((message) => ({
      role: message.role,
      text: Array.isArray(message.content) ? message.content.map((block) => block?.type === 'text' ? block.text : '').join('') : '',
    })) };
  }
  return { logical, count: messages.length, preview: false, messages };
}
