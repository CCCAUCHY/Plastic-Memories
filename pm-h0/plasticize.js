/**
 * PM · plasticize —— 段落归一化、解析、预览、待决查找。
 *
 * **本模块不写日志**。写入只发生在 engine.js 的 flush（提交边界）——
 * 因为 msg_* = 0 的语义是「到这一步彻底结束为止」，而工具执行时自己的结果还没落地。
 *
 * @module dsh-plugin-plastic-memories-h0/plasticize
 */

import { projectNext, renderPreview, renderRowsPreview } from './preview.js';
import { groupRows, windowRows } from './messages.js';
import { derivedMessage, surfaceNodes } from './coords.js';
import { pmSettledCallIds } from './markers.js';
import { normalizeOp } from './opshape.js';

const NL = String.fromCharCode(10);

export { normalizeOp, OP_DEFAULTS } from './opshape.js';

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
export function previewOf(session, resolved, callId, options = {}) {
  const next = projectNext(session, hypotheticalEvents(session, resolved, callId));
  const rows = groupRows(next.messages);
  const window = windowRows(rows, options.selectors);
  return {
    text: options.selectors === undefined ? renderPreview(next.messages) : renderRowsPreview(window.rows),
    generation: next.generation,
    messageCount: window.rows.length,
    total: window.total,
    units: window.selected,
  };
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
  const failed = new Set();
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/result' && event.data?.message?.isError === true) {
      const message = event.data.message;
      const callId = message.toolCallId ?? message.source?.callId;
      if (typeof callId === 'string') failed.add(callId);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.isError === true) {
      if (typeof event.data?.subCallId === 'string') failed.add(event.data.subCallId);
    }
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
        if (typeof callId !== 'string' || applied.has(callId) || failed.has(callId)) continue;
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
      if (typeof callId !== 'string' || applied.has(callId) || failed.has(callId)) continue;
      found = { callId, ops: args.ops };
    }
  }
  return found;
}