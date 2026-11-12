/**
 * PM · 待决 plasticize(set) 的查找。
 *
 * 「待决」= 声明成功、尚未被任何 execute 了结、且 ops 非空（空 set 非法）。
 * 单独成模块：unitops 与 index 都要用，避免 unitops → plasticize 的循环依赖。
 *
 * @module dsh-plugin-plastic-memories-h0/pending
 */

import { pmSettledCallIds } from './markers.js';
import { isLastSetSelector } from './opshape.js';

/** set 的 ops 里出现重放元素 = 非法 set，永远不可能是待决。 */
function referencesLastSet(ops) {
  return Array.isArray(ops) && ops.some((op) => Array.isArray(op?.positions) && op.positions.some((one) => isLastSetSelector(one)));
}

/**
 * 最近一条尚未执行的 set 声明。
 * @param {object} session - 目标会话。
 * @returns {{callId: string, ops: Array<object>}|undefined} 待决声明。
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
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block?.type !== 'tool-call' || block.name !== 'plasticize') continue;
        let args;
        try { args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch { continue; }
        if (args?.option !== 'set') continue;
        const callId = block.id ?? block.callId;
        if (typeof callId !== 'string' || applied.has(callId) || failed.has(callId)) continue;
        // set 必须有至少一个 op（工具层直接拒绝空 set）；旧日志里的空 set 不可能是待决。
        if (!Array.isArray(args.ops) || args.ops.length === 0) continue;
        if (referencesLastSet(args.ops)) continue;
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
      if (!Array.isArray(args.ops) || args.ops.length === 0) continue;
      if (referencesLastSet(args.ops)) continue;
      found = { callId, ops: args.ops };
    }
  }
  return found;
}
