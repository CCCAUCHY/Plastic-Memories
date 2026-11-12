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
export function classifyMessage(message) {
  const source = message?.source;
  if (source?.kind === 'agent-instructions') return { type: 'agent', autoInjected: true, autoRefresh: true };
  if (source?.kind === 'skill-catalog') return { type: 'skill', autoInjected: true, autoRefresh: true };
  const calls = Array.isArray(message?.content) ? message.content.filter((block) => block?.type === 'tool-call') : [];
  if (calls.some((call) => call.name === 'skill')) return { type: 'skill', autoInjected: false, autoRefresh: false };
  if (AUTO_OTHER.has(source?.kind)) return { type: 'other', autoInjected: true, autoRefresh: source?.kind === 'runtime-context' };
  const role = typeof message?.role === 'string' ? message.role : 'unknown';
  return { type: role, autoInjected: false, autoRefresh: false };
}

export function unitKindOf(event, message) {
  const kind = classifyMessage(message);
  if (kind.type !== 'unknown') return kind;
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
    // 自动隐藏/纯 hide 写出的空 developer 是 surface 空洞，不是模型消息；
    // 它不参与单元编号，否则 retrospect(self) 的 count 会被空洞越撑越大。
    if (event.type === 'developer/message') {
      const hiddenMessage = session.deriveEventMessage(event);
      const hiddenSource = hiddenMessage?.source ?? event.data?.message?.source;
      const hiddenContent = Array.isArray(hiddenMessage?.content) ? hiddenMessage.content : [];
      if (hiddenContent.length === 0 && (hiddenSource?.kind === 'pm-surface' || String(hiddenSource?.note ?? '').startsWith('auto-hide'))) continue;
    }
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

/** 区间连接词：to / through / til / 短横线。 */
const UNIT_RANGE_SEP = '(?:to|through|til|-|–)';

/**
 * 单元选择器的**唯一权威语法**（非捕获，供外部拼接正则）。
 *
 *   - `unit 17` / `17`           单个单元
 *   - `unit 17 to 28`             闭区间（含两端）
 *
 * 允许尾随冒号（`unit 17:`），用于与后面的替代文本分隔；`this` 由上层解析。
 */
export const UNIT_SELECTOR_SOURCE = 'unit\\s*\\d+(?:\\s*' + UNIT_RANGE_SEP + '\\s*(?:unit\\s*)?\\d+)?|\\d+';

const SELECTOR_ANY = new RegExp('^(?:' + UNIT_SELECTOR_SOURCE + ')$', 'iu');
const SELECTOR_ONE = new RegExp('^(?:unit\\s*)?(\\d+)$', 'iu');
const SELECTOR_SPAN = new RegExp('^unit\\s*(\\d+)\\s*' + UNIT_RANGE_SEP + '\\s*(?:unit\\s*)?(\\d+)$', 'iu');

/** 是否是 `this` 选择器（具体单元号由 unitops 解析）。 */
export function isThisSelector(raw) {
  return typeof raw === 'string' && /^this$/iu.test(raw.trim().replace(/:$/, '').trim());
}

/**
 * 解析单元选择器。
 * @param {unknown} raw - 选择器。
 * @returns {number[]} 单元序号（升序，含两端）。
 */
export function parseUnitRange(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return [raw];
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/:$/, '').trim();
    if (SELECTOR_ANY.test(text)) {
      const span = SELECTOR_SPAN.exec(text);
      if (span !== null) {
        const a = Number(span[1]);
        const b = Number(span[2]);
        if (a > b) throw new Error('unit range start must not exceed its end: ' + text);
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
      }
      const one = SELECTOR_ONE.exec(text);
      if (one !== null) return [Number(one[1])];
    }
  }
  throw new Error('unit selector must look like "unit 17" or "unit 17 to 28" (got ' + JSON.stringify(raw) + ')');
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
    locked: unit.locked,
    text: unit.text,
    calls: unit.calls,
    results: unit.results.map((result) => ({ text: result.text, isError: result.isError })),
    seqs: unit.seqs,
  };
}
