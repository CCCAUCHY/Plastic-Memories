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
      if (match === null) throw new Error('generation must be an absolute logical generation number (e.g. 3) or "self - N" (e.g. "self - 1")');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('N in "self - N" must be a positive integer');
      target = self - offset;
    }
  } else {
    throw new Error('generation must be an integer or a "self - N" string');
  }
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('generation is out of range: the target must be >= 0');
  if (target >= self) throw new Error('only past logical generations can be queried: the current generation self is already in the model input');
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
  if (value === undefined) throw new Error('retrospect requires generation (a past logical generation number or "self - N")');
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
  const self = info.total;
  const target = normalizeGeneration(generation, self);

  const bySeq = new Map(events.map((event) => [event.seq, event]));
  // 统一元数据来源：plugin:plastic-memories/logical；旧日志回退替代消息标记。
  const cutoffs = [];
  for (const event of events) {
    if (event.type === 'plugin:plastic-memories/logical' && Number.isSafeInteger(event.data?.logical)) {
      cutoffs.push({ logical: event.data.logical, seq: event.seq });
      continue;
    }
    if (event.surfaceOp?.op !== 'replace') continue;
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    if (source?.kind !== 'pm-surface') continue;
    let logical;
    if (Number.isSafeInteger(source.logicalGeneration)) logical = source.logicalGeneration;
    else {
      for (const candidate of [source.callId, ...(Array.isArray(source.consumed) ? source.consumed : [])]) {
        if (typeof candidate === 'string' && info.byCallId.has(candidate)) { logical = info.byCallId.get(candidate); break; }
      }
    }
    if (logical !== undefined) cutoffs.push({ logical, seq: event.seq });
  }
  cutoffs.sort((left, right) => left.seq - right.seq);

  // 只查历史世代；normalizeGeneration 已拒绝当前/未来世代。
  let cutoff = -1;
  for (const marker of cutoffs) {
    if (marker.logical === target) cutoff = Math.max(cutoff, marker.seq);
  }
  if (cutoff < 0) throw new Error('no context found for logical generation ' + String(target) + ' (no write recorded for that generation)');
  const contextNodes = replaySurface(events, cutoff);
  const messages = [];
  for (const seq of contextNodes) {
    const event = bySeq.get(seq);
    if (event === undefined) continue;
    const message = derivedMessage(session, event);
    messages.push({
      role: message !== undefined && typeof message.role === 'string' ? String(message.role) : (ROLE_BY_TYPE[event.type] ?? String(event.type)),
      text: messageText(message),
      time: Number.isSafeInteger(event.time) ? event.time : null,
    });
  }
  return JSON.stringify({ logical: target, count: messages.length, messages, letter: lettersOfGeneration(events, target, cutoffs) });
}

/** 取某个逻辑世代生命周期内输入的全部 letter（按调用顺序，附消息序号）。 */
function lettersOfGeneration(events, target, cutoffs) {
  const generationAt = (seq) => {
    let logical = 0; // 第一次成功 execute 之前：归入第 0 代
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
      // PTC 内层调用的 call 记在 dispatch-start 上，surface 上没有 tool/call。
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