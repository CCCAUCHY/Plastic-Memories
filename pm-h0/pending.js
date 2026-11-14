/**
 * PM · 待决 plasticize(set) 的查找。
 *
 * 「待决」= 声明成功、且它的承载消息**还在当前工作面上**。
 * 兑现过的 set 会随它所在单元一起被自动隐藏，所以「可见性」就是「未兑现」，
 * 不需要额外的台账，也不需要扫全部日志。
 *
 * @module dsh-plugin-plastic-memories-h0/pending
 */

/** 解析一次工具调用的参数。 */
function argsOf(block) {
  try { return typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch { return undefined; }
}

/** 这条调用是否以错误收场。 */
function failedCallIds(session) {
  const failed = new Set();
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/result' && event.data?.message?.isError === true) {
      const callId = event.data.message.toolCallId ?? event.data.message.source?.callId;
      if (typeof callId === 'string') failed.add(callId);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.isError === true) {
      if (typeof event.data?.subCallId === 'string') failed.add(event.data.subCallId);
    }
  }
  return failed;
}

/**
 * 最近一条仍在工作面上的 set 声明。
 * @param {object} session - 目标会话。
 * @returns {{callId: string, ops: Array<object>}|undefined} 待决声明。
 */
export function findLastPendingSet(session) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return undefined;
  const visible = new Set(nodes);
  const oldest = Math.min(...nodes);
  const events = session.snapshotEvents();
  const failed = failedCallIds(session);

  // 从日志尾部往前扫，跨过最老可见节点就停：更早的 set 不可能还在工作面上。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.seq < oldest) break;
    if (event.type === 'assistant/message') {
      if (!visible.has(event.seq)) continue;
      const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool-call' || block.name !== 'plasticize') continue;
        const args = argsOf(block);
        if (args?.option !== 'set') continue;
        const callId = block.callId ?? block.id;
        if (typeof callId !== 'string' || failed.has(callId)) continue;
        if (!Array.isArray(args.ops) || args.ops.length === 0) continue;
        return { callId, ops: args.ops };
      }
      continue;
    }
    // PTC：声明藏在 tool/ptc-dispatch-start 里，按 rootCallId 找回承载消息。
    if (event.type === 'tool/ptc-dispatch-start') {
      const args = event.data?.arguments ?? {};
      if (event.data?.name !== 'plasticize' || args?.option !== 'set') continue;
      const callId = event.data?.subCallId;
      const rootCallId = event.data?.rootCallId ?? event.data?.parentCallId;
      if (typeof callId !== 'string' || failed.has(callId)) continue;
      if (!Array.isArray(args.ops) || args.ops.length === 0) continue;
      const owner = ownerEventOf(events, rootCallId);
      if (owner === undefined || !visible.has(owner.seq)) continue;
      return { callId, ops: args.ops };
    }
  }
  return undefined;
}

/** 找到承载某次 run_code 调用的 assistant 消息。 */
function ownerEventOf(events, rootCallId) {
  if (typeof rootCallId !== 'string') return undefined;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    if (content.some((block) => block?.type === 'tool-call' && (block.id === rootCallId || block.callId === rootCallId))) return event;
  }
  return undefined;
}
