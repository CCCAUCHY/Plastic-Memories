/**
 * PM · plasticize —— 段落归一化、解析、预览、待决查找。
 *
 * **本模块不写日志**。写入只发生在 engine.js 的 flush（提交边界）——
 * 因为 msg_* = 0 的语义是「到这一步彻底结束为止」，而工具执行时自己的结果还没落地。
 *
 * @module dsh-plugin-plastic-memories-h0/plasticize
 */

import { projectNext, renderPreview } from './preview.js';
import { closureViolations, openSetProfile, slideToGroupEdge, stepUnitsOf } from './grouping.js';
import { resolveSpan } from './spans.js';
import { checkBalanced, derivedMessage, surfaceNodes } from './coords.js';
import { pmSettledCallIds } from './markers.js';
import { isCookie } from './cookie.js';

const NL = String.fromCharCode(10);

/** 段落里允许出现的字段。 */
const OP_FIELDS = new Set(['spans', 'new_text', 'lock_this', 'types']);
const TYPE_NAMES = new Set(['user', 'developer', 'assistant', 'error', 'letter']);

/**
 * 校验并归一化一个段落。
 *
 * 段落 = **一组区间 + 一条替代文本**。
 *
 * 端点只有两种：**cookie 编号**与 **this**（见 spans.js 的语法说明）。
 * 关键字与偏移量已废除 —— 前者会被模型自己的推理污染，后者模型数不准。
 *
 * @param {unknown} raw - 模型给的段落。
 * @param {number} index - 段落序号（错误信息用）。
 * @returns {{spans: string[], new_text: string}} 段落。
 * @throws {Error} 字段非法时。
 */
export function normalizeOp(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('op #' + index + ' must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!OP_FIELDS.has(key)) {
      throw new Error('op #' + index + ' has unknown field ' + JSON.stringify(key) + '; allowed: ' + [...OP_FIELDS].join(', '));
    }
  }
  if (!Object.hasOwn(raw, 'spans')) throw new Error('op #' + index + ' is missing spans');
  if (!Array.isArray(raw.spans) || raw.spans.length === 0) {
    throw new Error('op #' + index + ' spans must be a non-empty array');
  }
  for (const one of raw.spans) {
    if (typeof one !== 'string') {
      throw new Error('op #' + index + ' spans entries must be strings (span text), got ' + JSON.stringify(one));
    }
  }
  const newText = raw.new_text === undefined ? '' : raw.new_text;
  if (typeof newText !== 'string') throw new Error('op #' + index + ' new_text must be a string');
  const lockThis = raw.lock_this === undefined ? false : raw.lock_this;
  if (typeof lockThis !== 'boolean') throw new Error('op #' + index + ' lock_this must be a boolean');
  const rawTypes = raw.types === undefined ? [] : raw.types;
  if (!Array.isArray(rawTypes)) throw new Error('op #' + index + ' types must be an array');
  const types = [...new Set(rawTypes)];
  for (const type of types) {
    if (typeof type !== 'string' || !TYPE_NAMES.has(type)) {
      throw new Error('op #' + index + ' types contains unknown type ' + JSON.stringify(type) + '; allowed: ' + [...TYPE_NAMES].join(', '));
    }
  }
  return { spans: [...raw.spans], new_text: newText, lock_this: lockThis, types };
}

/** 取消息纯文本。 */
function textOf(message) {
  if (message === undefined || message === null || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
    else if (block.type === 'tool-call') parts.push('[tool-call ' + String(block.name) + ']');
  }
  return parts.join(NL);
}

/** 事件类型 → 可匹配角色（cookie 不参与匹配）。 */
function directTypeOf(event) {
  if (event === undefined || isCookie(event)) return undefined;
  if (event.type === 'user/message') return 'user';
  if (event.type === 'developer/message') return 'developer';
  if (event.type === 'assistant/message') return 'assistant';
  return undefined;
}

/**
 * 收集一个区间内按 types 匹配到的完整步骤单元，返回合并后的连续下标区间。
 *
 * user / developer：匹配单个消息；assistant / error / letter：匹配整个
 * 「助手消息 + 工具结果」步骤单元（closure 要求整步隐藏）。
 * cookie 永远不参与匹配。
 */
function typeRangesFor(session, view, startIndex, endIndex, types) {
  const nodes = view.surface.nodes;
  const units = stepUnitsOf(view);
  const members = new Map();
  const errorUnits = new Set();
  const direct = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index];
    const key = units.get(seq);
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(index);
    const event = view.eventAt(seq);
    if (event?.type === 'tool/result' && event.data?.message?.isError === true) errorUnits.add(key);
    const role = directTypeOf(event);
    if (role !== undefined) direct.set(index, role);
  }
  const wanted = new Set(types);
  // letter：扫描原生事件，标记含 letter 工具调用的单元。
  const letterSeq = [];
  const letterUnits = new Set();
  if (wanted.has('letter')) {
    for (const event of session.snapshotEvents()) {
      const name = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
        ? event.data?.name
        : undefined;
      if (name === 'letter') letterSeq.push(event.seq);
      if (event.type === 'assistant/message' && Array.isArray(event.data?.message?.content)) {
        for (const block of event.data.message.content) {
          if (block?.type === 'tool-call' && block.name === 'letter') letterSeq.push(event.seq);
        }
      }
    }
    for (const [key, list] of members) {
      const first = nodes[list[0]];
      const last = nodes[list[list.length - 1]];
      if (letterSeq.some((seq) => seq >= first && seq <= last)) letterUnits.add(key);
    }
  }
  const selected = new Set();
  for (let index = startIndex; index <= endIndex; index += 1) {
    const seq = nodes[index];
    const event = view.eventAt(seq);
    if (event === undefined || isCookie(event)) continue;
    const key = units.get(seq);
    const type = direct.get(index);
    if (type !== undefined && wanted.has(type)) selected.add(key);
    if (wanted.has('error') && errorUnits.has(key)) selected.add(key);
    if (wanted.has('letter') && letterUnits.has(key)) selected.add(key);
  }
  if (selected.size === 0) {
    throw new Error('types ' + JSON.stringify(types) + ' matched no messages in the span (cookies never match)');
  }
  const indexes = [];
  for (const key of selected) indexes.push(...(members.get(key) ?? []));
  indexes.sort((left, right) => left - right);
  const ranges = [];
  for (const index of indexes) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && index === last[1] + 1) last[1] = index;
    else ranges.push([index, index]);
  }
  return ranges;
}

/**
 * 解析全部段落。
 *
 * 段落按顺序解析；后一段落在前一段落**已遮蔽**后的工作面上解析。
 *
 * **一个段落里的多个区间**：全部按位置排序后处理 ——
 * **前面的区间一律隐藏**（纯空洞），**替代文本只落在最靠后的那个区间上**。
 * 这样一次调用就能对**不连续的多个区间**做同一个操作。
 *
 * **工具执行期解析 this 的特例**：PM 工具在自己的 execute 里运行时，它自己的
 * tool/result 还没落地 —— this 组此时是**不完整**的（here.selfComplete === false）。
 * 这时只跳过「收尾在 this 末端」的配对平衡校验：等结果落地后，它在提交边界上
 * 一定闭合（engine 会重新解析）。其它区间的平衡仍然严格校验。
 *
 * @param {object} session - 目标会话。
 * @param {Array<object>} rawOps - 段落数组。
 * @param {{thisSeq: number, thisEndSeq: number, selfComplete?: boolean}} here - this 端点。
 * @returns {Array<{op: {new_text: string}, shadowed: number[]}>} 展开成一区间一项的结果。
 */
export function resolveOps(session, rawOps, here) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) throw new Error('ops must be a non-empty array');
  const ops = rawOps.map((raw, i) => normalizeOp(raw, i));
  const nodes = surfaceNodes(session);
  const consumed = new Set();
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    // 每段重算工作面：前面的段落遮蔽掉若干节点后，后面的段落必须按新工作面理解。
    const visible = nodes.filter((seq) => !consumed.has(seq));
    const view = {
      surface: { nodes: visible, replaceGeneration: session.surface.replaceGeneration },
      eventAt: (seq) => session.eventAt(seq),
      deriveEventMessage: (event) => session.deriveEventMessage(event),
    };
    const profile = openSetProfile(view);
    const ranges = [];
    for (const raw of op.spans) {
      let startIndex;
      let endIndex;
      try {
        ({ startIndex, endIndex } = resolveSpan(view, raw, here));
      } catch (error) {
        throw new Error('op #' + i + ': ' + error.message);
      }
      if (op.types.length > 0) {
        try {
          ranges.push(...typeRangesFor(session, view, startIndex, endIndex, op.types));
        } catch (error) {
          throw new Error('段落 #' + i + '：' + error.message);
        }
      } else {
        // 滑到组合边界，保证不拆开工具对（组合边界永远是合法切口）。
        const lo = slideToGroupEdge(visible, profile, startIndex, 'start');
        const hi = slideToGroupEdge(visible, profile, endIndex, 'end');
        if (lo > hi) throw new Error('op #' + i + ': span ' + JSON.stringify(raw) + ' resolves to an empty range');
        ranges.push([lo, hi]);
      }
    }
    // 按位置排序 —— 替代文本落在最靠后的那个区间，其余全部隐藏。
    ranges.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < ranges.length; k++) {
      if (ranges[k][0] <= ranges[k - 1][1]) {
        throw new Error('op #' + i + ' has overlapping spans (#' + ranges[k - 1][0] + '..#' + ranges[k - 1][1] +
          ' 与 #' + ranges[k][0] + '..#' + ranges[k][1] + '）');
      }
    }
    for (let k = 0; k < ranges.length; k++) {
      const seqs = visible.slice(ranges[k][0], ranges[k][1] + 1);
      const check = checkBalanced(view, ranges[k][0], ranges[k][1]);
      if (!check.ok) {
        const endsAtIncompleteSelf = here?.selfComplete === false
          && here.thisEndSeq !== undefined
          && visible[ranges[k][1]] === here.thisEndSeq;
        if (!endsAtIncompleteSelf) throw new Error('op #' + i + ': ' + check.reason);
      }
      for (const q of seqs) consumed.add(q);
      out.push({ op: { new_text: k === ranges.length - 1 ? op.new_text : '', ...(k === ranges.length - 1 && op.lock_this === true ? { lock_this: true } : {}) }, shadowed: seqs });
    }
  }
  // 不变量：合法投影必须「整步闭合」—— 一步 = 一条助手消息 + 它的全部工具结果。
  // 端点已经滑到组合边界，这里再做一次显式断言：若哪天组合 trait 变化导致区间拆步，
  // 宁可当场报内部错误，也不要把「部分步骤被遮」的日志写进去。
  // 工具执行期的预览可能带着「本步尚未收完」的 this 组（selfComplete === false），
  // 那时区间只能到已落地的节点；真正的整步校验放在提交边界（flush）重解析时做。
  const closure = here?.selfComplete === false
    ? []
    : closureViolations({ surface: { nodes }, eventAt: (seq) => session.eventAt(seq) }, out.flatMap((entry) => entry.shadowed));
  if (closure.length > 0) {
    throw new Error('internal invariant: the projection range does not close whole step units (' + closure.map((v) => v.unit + ' hides ' + String(v.inside) + '/' + String(v.size)).join(', ') + ')');
  }
  return out;
}

/**
 * 造**假想事件**（不落盘），供预览的宿主折叠使用。
 * @param {object} session - 目标会话。
 * @param {Array<object>} resolved - resolveOps 的结果。
 * @param {string} callId - 幂等键。
 * @returns {Array<object>} 假想事件。
 */
export function hypotheticalEvents(session, resolved, callId) {
  const generation = session.surface.replaceGeneration + 1;
  return resolved.map((span, i) => {
    const isHole = span.op.new_text.length === 0;
    const source = {
      kind: 'pm-surface', v: 1,
      op: isHole ? 'hide' : 'stabilize',
      callId, generation,
      refs: [...span.shadowed],
    };
    const message = {
      id: 'pm-hyp-' + callId + '-' + i,
      role: isHole ? 'developer' : 'user',
      content: isHole ? [] : [{ type: 'text', text: span.op.new_text }],
      source,
    };
    return {
      type: isHole ? 'developer/message' : 'user/message',
      seq: session.seq + i,
      time: Date.now(),
      surfaceOp: { op: 'replace', startSeq: span.shadowed[0], endSeq: span.shadowed[span.shadowed.length - 1] },
      sourceEventSeqs: [...span.shadowed],
      data: isHole ? { turn: 0, step: 0, message } : message,
    };
  });
}

/**
 * 算一次 plasticize 的预览（**不写日志**）。
 * @param {object} session - 目标会话。
 * @param {Array<object>} resolved - resolveOps 的结果。
 * @param {string} callId - 幂等键。
 * @returns {{text: string, generation: number, messageCount: number}} 预览。
 */
export function previewOf(session, resolved, callId) {
  const next = projectNext(session, hypotheticalEvents(session, resolved, callId));
  return { text: renderPreview(next.messages), generation: next.generation, messageCount: next.messages.length };
}

/**
 * 在日志里找**最近一条尚未被执行**的 set 声明。
 *
 * 待决状态不另存 —— set 调用的 arguments 本来就在日志里，那份声明就是待决状态。
 * @param {object} session - 目标会话。
 * @returns {{callId: string, ops: Array<object>}|undefined}} 待决声明。
 */
export function findLastPendingSet(session) {
  const applied = new Set();
  for (const event of session.snapshotEvents()) {
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    for (const settled of pmSettledCallIds(source)) applied.add(settled);
  }
  let found;
  for (const event of session.snapshotEvents()) {
    // native：assistant/message 里的 tool-call 块
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block?.type !== 'tool-call' || block.name !== 'plasticize') continue;
        let args;
        try { args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch { continue; }
        if (args?.option !== 'set') continue;
        const callId = block.id ?? block.callId;
        if (typeof callId !== 'string' || applied.has(callId)) continue;
        found = { callId, ops: args.ops };
      }
      continue;
    }
    // PTC：模型经 run_code 调用，声明只藏在 tool/ptc-dispatch-start 里
    if (event.type === 'tool/ptc-dispatch-start') {
      if (event.data?.name !== 'plasticize') continue;
      const args = event.data?.arguments ?? {};
      if (args?.option !== 'set') continue;
      const callId = event.data?.subCallId;
      if (typeof callId !== 'string' || applied.has(callId)) continue;
      found = { callId, ops: args.ops };
    }
  }
  return found;
}