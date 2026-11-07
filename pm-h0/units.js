/**
 * PM · units —— 当前世代的单元序列。
 *
 * 单元 = 系统/用户/developer 单条消息，或「assistant 消息 + 紧随其后的
 * 全部 tool/result」。世代内序号从 0 起：0 是系统提示词，1 是第一条消息。
 *
 * @module dsh-plugin-plastic-memories-h0/units
 */

import { callIdOf, derivedMessage, messageText, roleOfEvent, surfaceNodes } from './coords.js';

const AUTO_OTHER = new Set([
  'runtime-context', 'time-context', 'permission', 'workspace', 'sandbox',
  'approval', 'environment', 'dsh-runtime', 'session', 'goal', 'schedule',
]);

function sourceOf(event) {
  return event?.type === 'user/message' ? event.data?.source : event.data?.message?.source;
}

function isToolResult(event) {
  return event?.type === 'tool/result';
}

function resultInfo(event) {
  const message = event?.data?.message;
  return {
    seq: event.seq,
    text: messageText(message),
    isError: message?.isError === true,
    toolCallId: message?.toolCallId ?? message?.source?.callId,
  };
}

/** 分类：普通角色，或自动注入类型 agent/skill/other。 */
export function unitKindOf(event, message) {
  const source = message?.source ?? sourceOf(event);
  if (source?.kind === 'agent-instructions') return { type: 'agent', autoInjected: true, autoRefresh: true };
  if (source?.kind === 'skill-catalog') return { type: 'skill', autoInjected: true, autoRefresh: true };
  const calls = Array.isArray(message?.content) ? message.content.filter((block) => block?.type === 'tool-call') : [];
  if (calls.some((call) => call.name === 'skill')) return { type: 'skill', autoInjected: false, autoRefresh: false };
  if (AUTO_OTHER.has(source?.kind)) return { type: 'other', autoInjected: true, autoRefresh: source?.kind === 'runtime-context' };
  return { type: roleOfEvent(event) ?? String(event?.type ?? 'unknown'), autoInjected: false, autoRefresh: false };
}

function textOfUnit(raw) {
  return raw.map((item) => item.text).filter((text) => text.length > 0).join(String.fromCharCode(10));
}

/**
 * 当前世代单元。
 * @param {object} session - 目标会话。
 * @param {{locks?: Set<number>}} [options] - 安全区底层 seq 集合。
 * @returns {Array<object>} 单元数组。
 */
export function currentUnits(session, options = {}) {
  const nodes = surfaceNodes(session);
  const locks = options.locks instanceof Set ? options.locks : new Set();
  const units = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index];
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'assistant/message') {
      const unitEvents = [{ seq, event }];
      let cursor = index + 1;
      while (cursor < nodes.length) {
        const next = session.eventAt(nodes[cursor]);
        if (!isToolResult(next)) break;
        unitEvents.push({ seq: nodes[cursor], event: next });
        cursor += 1;
      }
      index = cursor - 1;
      units.push(makeUnit(session, unitEvents, locks));
      continue;
    }
    if (isToolResult(event)) {
      // 孤儿工具结果（理论上是非法节点）：单独成一个单元，不吞掉后续。
      units.push(makeUnit(session, [{ seq, event }], locks));
      continue;
    }
    units.push(makeUnit(session, [{ seq, event }], locks));
  }
  return units.map((unit, n) => ({ ...unit, n }));
}

function makeUnit(session, items, locks) {
  const first = items[0];
  const message = derivedMessage(session, first.event);
  const kind = unitKindOf(first.event, message);
  const raw = items.map(({ seq, event }) => {
    const itemMessage = derivedMessage(session, event);
    return { seq, event, message: itemMessage, text: messageText(itemMessage) };
  });
  const results = items.filter(({ event }) => isToolResult(event)).map(({ event }) => resultInfo(event));
  const calls = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'tool-call').map((block) => ({ id: callIdOf(block), name: String(block.name ?? 'tool') }))
    : [];
  const seqs = items.map(({ seq }) => seq);
  return {
    seq: first.seq,
    seqs,
    start: seqs[0],
    end: seqs[seqs.length - 1],
    role: String(message?.role ?? roleOfEvent(first.event) ?? 'unknown'),
    type: kind.type,
    autoInjected: kind.autoInjected,
    autoRefresh: kind.autoRefresh === true,
    locked: seqs.some((seq) => locks.has(seq)),
    safety: seqs.some((seq) => locks.has(seq)),
    text: textOfUnit(raw),
    calls,
    results,
    resultText: results.map((result) => result.text).join(String.fromCharCode(10)),
    raw,
  };
}

/** 找一个调用所在的单元。 */
export function unitOfCall(session, ownerCallId, options = {}) {
  if (typeof ownerCallId !== 'string') return undefined;
  const units = currentUnits(session, options);
  return units.find((unit) => unit.calls.some((call) => call.id === ownerCallId));
}

/** 按序号取单元；越界返回 undefined。 */
export function unitAt(units, n) {
  return Number.isSafeInteger(n) && n >= 0 && n < units.length ? units[n] : undefined;
}

/** 把 "3" / "[3,7]" / [3,7] 解析成单元序号列表（含两端）。 */
export function parseUnitRange(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return [raw];
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    const [a, b] = raw;
    return a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [];
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    const one = /^(\d+)$/.exec(text);
    if (one !== null) return [Number(one[1])];
    const span = /^[\[(]\s*(\d+)\s*,\s*(\d+)\s*[\])]$/.exec(text);
    if (span !== null) {
      const a = Number(span[1]);
      const b = Number(span[2]);
      if (a <= b) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
  }
  throw new Error('unit range must be a non-negative integer or [start,end]');
}

/** 选择器：数字、区间字符串、数组或 "this"（由调用方先转换为数字）。 */
export function selectUnits(units, selectors) {
  const chosen = new Set();
  for (const selector of selectors) {
    for (const n of parseUnitRange(selector)) {
      if (n >= units.length) throw new Error('unit ' + n + ' is out of range (current generation has ' + units.length + ' units)');
      chosen.add(n);
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

/** 单元缩略预览：一行一单元，带序号/类型/锁标记。 */
export function renderUnitPreview(units) {
  return units.map((unit) => {
    const head = '#' + String(unit.n) + ' [' + unit.type + ']' + (unit.locked ? ' [locked]' : '');
    const text = unit.text.replace(/\s+/g, ' ').trim();
    const clipped = text.length <= 180 ? text : text.slice(0, 120) + '……' + text.slice(-40);
    return head + (clipped.length > 0 ? ' ' + clipped : '');
  }).join(String.fromCharCode(10));
}

/** 普通完整单元输出（去掉内部 raw 引用）。 */
export function unitView(unit) {
  return {
    n: unit.n,
    type: unit.type,
    role: unit.role,
    autoInjected: unit.autoInjected,
    autoRefresh: unit.autoRefresh,
    safety: unit.safety,
    locked: unit.locked,
    text: unit.text,
    calls: unit.calls,
    results: unit.results.map((result) => ({ text: result.text, isError: result.isError })),
    seqs: unit.seqs,
  };
}
