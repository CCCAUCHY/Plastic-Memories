/**
 * PM · retrospect —— 只读查询逻辑世代（历史或当前 self）的上下文。
 *
 * 历史世代回放到其 execute 调用及 tool result 为止；当前 self 直接返回
 * 当前 surface。默认返回结构化 JSON（PTC 友好），preview:true 时复用
 * set 预览渲染，返回缩略文本而不是完整 messages。
 *
 * 被该世代隐藏掉的原文属于上一代，不在本工具的输出里。
 *
 * @module dsh-plugin-plastic-memories-h0/retrospect
 */

import { SURFACE_TYPES, derivedMessage, messageText } from './coords.js';
import { logicalGenerations } from './engine.js';
import { logicalBoundaries } from './boundaries.js';
import { messagesAt } from './messages.js';
import { renderPreview } from './preview.js';

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
  let current = false;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    target = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (/^self$/iu.test(text)) {
      target = self;
      current = true;
    } else if (/^\d+$/.test(text)) {
      target = Number(text);
    } else {
      const match = /^self\s*-\s*(\d+)$/iu.exec(text);
      if (match === null) throw new Error('generation must be an absolute logical generation number (e.g. 3), "self", or "self - N" (e.g. "self - 1")');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('N in "self - N" must be a non-negative integer');
      target = self - offset;
      if (offset === 0) current = true;
    }
  } else {
    throw new Error('generation must be an integer, "self", or a "self - N" string');
  }
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('generation is out of range: the target must be >= 0');
  if (target > self) throw new Error('generation is in the future: the current generation is ' + String(self));
  if (target === self) current = true;
  return { target, current };
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
  if (value === undefined) throw new Error('retrospect requires generation (a logical generation number, "self", or "self - N")');
  return retrospectGeneration(session, value, args?.preview === true);
}

/**
 * 按逻辑世代号返回该世代隐藏掉的全部原文（结构化 JSON）。
 *
 * PTC 模式下调用方可以在程序里直接 JSON.parse 并过滤，不需要工具端做文本搜索。
 * @param {object} session - 目标会话。
 * @param {number} generation - 逻辑世代号（0 起，与 self - k 标签里的「逻辑」一致）。
 * @returns {string} JSON 文本。
 */
/** Find the surface tool/result seq belonging to an execute call (PTC uses the root run_code result). */
function executeResultSeq(events, callId) {
  if (typeof callId !== 'string') return undefined;
  const cut = callId.indexOf(':ptc:');
  const owner = cut === -1 ? callId : callId.slice(0, cut);
  let found;
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const message = event.data?.message;
    const id = message?.toolCallId ?? message?.source?.callId;
    if (id === callId || id === owner) found = event.seq;
  }
  return found;
}

export function retrospectGeneration(session, generation, preview = false) {
  const events = session.snapshotEvents();
  const info = logicalGenerations(session);
  const self = info.total;
  const normalized = normalizeGeneration(generation, self);
  const target = normalized.target;
  const isCurrent = normalized.current;
  const logical = isCurrent ? self : target;

  let rawMessages;
  if (isCurrent) {
    rawMessages = session.deriveMessages();
  } else {
    // 世代边界：优先该世代的 execute 声明，其次 compaction checkpoint。
    const execute = info.executes.find((entry) => entry.logical === target);
    const boundary = logicalBoundaries(events).boundaries.find((entry) => entry.logical === target);
    const boundarySeq = execute?.seq ?? boundary?.seq;
    if (!Number.isSafeInteger(boundarySeq)) {
      throw new Error('no context found for logical generation ' + String(target) + ' (no write recorded for that generation)');
    }
    // 输入消息是产生该边界的那次请求：取边界前最后一条 assistant 消息，
    // 它的 seq 就是该请求输出的位置，前缀 < 它刚好是模型输入。
    let requestSeq;
    for (const event of events) {
      if (event.seq >= boundarySeq) break;
      if (event.type === 'assistant/message') requestSeq = event.seq;
    }
    rawMessages = messagesAt(session, requestSeq ?? boundarySeq);
  }

  const letter = lettersOfGeneration(events, isCurrent ? Number.POSITIVE_INFINITY : target, info, []);
  if (preview) {
    return JSON.stringify({
      logical,
      count: rawMessages.length,
      preview: true,
      previewText: renderPreview(rawMessages),
      letter,
    });
  }
  return JSON.stringify({ logical, count: rawMessages.length, preview: false, messages: rawMessages, letter });
}

/** 取某个逻辑世代生命周期内输入的全部 letter（按调用顺序，附消息序号）。 */
function lettersOfGeneration(events, target, info, cutoffs) {
  const executes = Array.isArray(info.executes) ? info.executes.slice().sort((left, right) => left.seq - right.seq) : [];
  const generationAt = (seq) => {
    // 新语义：逻辑世代 N 的上下文截止于 N 的 execute 声明；
    // 两个 execute 声明之间写入的 letter 属于后一个 generation（N 的推理生命周期）。
    if (executes.length > 0) {
      const next = executes.find((entry) => entry.seq > seq);
      return next === undefined ? Number.POSITIVE_INFINITY : next.logical;
    }
    let logical = 0;
    for (const cutoff of cutoffs) {
      if (cutoff.seq < seq) logical = cutoff.logical; else break;
    }
    return logical;
  };
  const out = [];
  for (const event of events) {
    let name;
    let raw;
    if (event.type === 'tool/call') {
      name = event.data?.name;
      raw = event.data?.arguments;
    } else if (event.type === 'tool/ptc-dispatch-start') {
      name = event.data?.name;
      raw = event.data?.arguments;
    } else continue;
    if (name !== 'letter') continue;
    if (generationAt(event.seq) !== target) continue;
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { continue; }
    }
    const text = parsed?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const surface = replaySurface(events, event.seq);
    out.push({ index: surface.length - 1, text, time: Number.isSafeInteger(event.time) ? event.time : null });
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