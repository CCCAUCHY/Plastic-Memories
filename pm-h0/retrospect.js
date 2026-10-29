/**
 * PM · retrospect —— 只读查询**一个历史逻辑世代**的上下文。
 *
 * 当前世代 self 的上下文就是模型此刻看到的内容，查询它没有意义；因此
 * generation 必须严格小于 self。返回值是结构化 JSON（PTC 友好），
 * 由调用方在程序里自行筛选；一个世代一次调用。
 *
 * 历史上下文通过回放日志到该逻辑世代最后一次写入点重建。
 * 被该世代隐藏掉的原文属于上一代，不在本工具的输出里。
 *
 * @module dsh-plugin-plastic-memories-h0/retrospect
 */

import { SURFACE_TYPES, derivedMessage, messageText } from './coords.js';
import { logicalGenerations } from './engine.js';

/** 事件类型到角色名的兜底映射（正常消息直接读 message.role）。 */
const ROLE_BY_TYPE = Object.freeze({
  'user/message': 'user',
  'developer/message': 'developer',
  'assistant/message': 'assistant',
  'system/message': 'system',
  'tool/result': 'tool',
});


/** 工具结果事件的文本（用于读取 execute 结果里的逻辑世代 marker）。 */
function eventText(event) {
  const message = event?.data?.message ?? event?.data;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join(String.fromCharCode(10));
}

/**
 * 归一化 generation 参数：绝对逻辑世代号，或 "self - N" 偏移。
 * 当前世代 self 不可查询（它的上下文就是模型当前看到的内容）。
 */
function normalizeGeneration(value, self) {
  let target;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    target = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      target = Number(text);
    } else {
      const match = /^self\s*-\s*(\d+)$/iu.exec(text);
      if (match === null) throw new Error('generation 必须是绝对逻辑世代号（如 3）或 "self - N"（如 "self - 1"）');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('"self - N" 的 N 必须是正整数');
      target = self - offset;
    }
  } else {
    throw new Error('generation 必须是整数或 "self - N" 字符串');
  }
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('generation 超出范围：目标世代号必须 >= 0');
  if (target >= self) throw new Error('只能查询 self 之前的逻辑世代：当前世代 self 的上下文已经在模型输入里');
  return target;
}

/**
 * 查询**一个历史逻辑世代**的上下文（结构化 JSON）。
 *
 * 只接受历史世代（< self）；当前世代不上报（它就是当前上下文）。
 * PTC 程序可以按需多次调用，只取需要的那一代。
 * @param {object} session - 目标会话。
 * @param {{generation: (number|string)}} args - generation 为绝对世代号或 "self - N"。
 * @returns {string} JSON 文本。
 */
export function retrospect(session, args) {
  const value = args?.generation;
  if (value === undefined) throw new Error('retrospect 需要 generation（历史逻辑世代号或 "self - N"）');
  return retrospectGeneration(session, value);
}

/**
 * 按逻辑世代号返回该世代隐藏掉的全部原文（结构化 JSON）。
 *
 * PTC 模式下调用方可以在程序里直接 JSON.parse 并过滤，不需要工具端做文本搜索。
 * @param {object} session - 目标会话。
 * @param {number} generation - 逻辑世代号（0 起，与 self - k 标签里的「逻辑」一致）。
 * @returns {string} JSON 文本。
 */
export function retrospectGeneration(session, generation) {
  const events = session.snapshotEvents();
  const info = logicalGenerations(session);
  info.byCallId = new Map(info.executes.map((entry) => [entry.callId, entry.logical]));
  let logicalFromSource = -1;
  for (const event of events) {
    if (event.surfaceOp?.op !== 'replace') continue;
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    if (typeof source?.logicalGeneration === 'number') logicalFromSource = Math.max(logicalFromSource, source.logicalGeneration);
  }
  let logicalFromResults = -1;
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const match = /pm-logical-generation=(\d+)/.exec(eventText(event));
    if (match !== null) logicalFromResults = Math.max(logicalFromResults, Number(match[1]));
  }
  const derivedMax = Math.max(logicalFromResults, logicalFromSource);
  if (derivedMax >= 0) info.total = derivedMax;
  const self = info.total;
  const target = normalizeGeneration(generation, self);

  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const logicalOf = (event) => {
    if (event?.type === 'plugin:plastic-memories/logical' && Number.isSafeInteger(event.data?.logical)) return event.data.logical;
    if (event?.surfaceOp?.op !== 'replace') return undefined;
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    if (typeof source?.logicalGeneration === 'number') return source.logicalGeneration;
    for (const candidate of [source?.callId, ...(Array.isArray(source?.consumed) ? source.consumed : [])]) {
      if (typeof candidate === 'string' && info.byCallId.has(candidate)) return info.byCallId.get(candidate);
    }
    let fallback;
    for (const entry of info.executes) {
      if (entry.seq <= event.seq) fallback = entry.logical; else break;
    }
    return fallback;
  };

  // 只查历史世代；normalizeGeneration 已拒绝当前/未来世代。
  let cutoff = -1;
  for (const event of events) {
    if (logicalOf(event) === target) cutoff = Math.max(cutoff, event.seq);
  }
  if (cutoff < 0) throw new Error('找不到逻辑世代 ' + String(target) + ' 的上下文（日志中没有该世代的写入记录）');
  const contextNodes = replaySurface(events, cutoff);
  const messages = [];
  for (const seq of contextNodes) {
    const event = bySeq.get(seq);
    if (event === undefined) continue;
    const message = derivedMessage(session, event);
    messages.push({
      role: message !== undefined && typeof message.role === 'string' ? String(message.role) : (ROLE_BY_TYPE[event.type] ?? String(event.type)),
      text: messageText(message),
    });
  }
  return JSON.stringify({ logical: target, count: messages.length, messages, letter: lettersUpTo(events, cutoff) });
}

/** 从 plasticize 的 tool/call 参数里收集截至 cutoff 的 letter（无任何额外写入）。 */
function lettersUpTo(events, cutoff) {
  const out = [];
  for (const event of events) {
    if (event.seq > cutoff) break;
    if (event.type !== 'tool/call' || event.data?.name !== 'plasticize') continue;
    const raw = event.data?.arguments;
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { continue; }
    }
    const letter = parsed?.letter;
    const list = Array.isArray(letter) ? letter : [letter];
    for (const entry of list) {
      if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry);
    }
  }
  return out;
}

/** 按日志回放 surface 到 cutoff（含），返回当时的节点 seq 列表。 */
function replaySurface(events, cutoff) {
  const list = [];
  for (const event of events) {
    if (event.seq > cutoff) break;
    if (!SURFACE_TYPES.has(event.type)) continue;
    const op = event.surfaceOp;
    if (op === 'append' || op?.op === 'append') {
      list.push(event.seq);
      continue;
    }
    if (op?.op !== 'replace') continue;
    let start = list.indexOf(op.startSeq);
    let end = list.indexOf(op.endSeq);
    if (start < 0 || end < start) {
      const refs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
      start = list.indexOf(refs[0]);
      end = start < 0 ? -1 : start + refs.length - 1;
    }
    if (start >= 0 && end >= start) list.splice(start, end - start + 1, event.seq);
  }
  return list;
}