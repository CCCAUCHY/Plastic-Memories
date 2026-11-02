/**
 * PM 语义审计：不 import engine，直接从会话事件和 surface 回放验证
 * PM 语法翻译到 surfaceOp / 私有事件的结果。
 *
 * @module verify
 */

const SURFACE_TYPES = new Set(['user/message', 'developer/message', 'assistant/message', 'system/message', 'tool/result']);

function sameSeqs(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * @param {Array<object>} events - 已解码 sourceEventSeqs 的会话事件（seq 升序）。
 * @returns {string[]} 错误列表；空数组表示通过。
 */
export function verifyPmSemantics(events) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const declarations = new Map();
  const failed = new Set();
  const applied = new Map();
  const surface = [];
  let replaceCount = 0;
  let pendingFirst = undefined;
  let logicalCount = 0;
  const locks = new Set();
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));

  const callIdOfResult = (message) => message?.toolCallId ?? message?.source?.callId;

  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool-call' || block.name !== 'plasticize') continue;
        const callId = block.id ?? block.callId;
        if (typeof callId !== 'string') continue;
        let args;
        try { args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch { args = undefined; }
        declarations.set(callId, { callId, option: args?.option, via: 'native', seq: event.seq, args });
      }
    } else if (event.type === 'tool/ptc-dispatch-start' && event.data?.name === 'plasticize') {
      const callId = event.data?.subCallId;
      if (typeof callId === 'string') declarations.set(callId, { callId, option: event.data?.arguments?.option, via: 'ptc', seq: event.seq, args: event.data?.arguments });
    } else if (event.type === 'tool/result' && event.data?.message?.isError === true) {
      const callId = callIdOfResult(event.data.message);
      if (typeof callId === 'string') failed.add(callId);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.isError === true) {
      if (typeof event.data?.subCallId === 'string') failed.add(event.data.subCallId);
    } else if (event.type === 'plugin:plastic-memories/logical') {
      const data = event.data ?? {};
      if (pendingFirst !== undefined && data.physical !== pendingFirst) {
        fail('logical event at seq ' + event.seq + ' physical ' + data.physical + ' != first replace generation ' + pendingFirst);
      }
      pendingFirst = undefined;
    } else if (event.type === 'plugin:plastic-memories/locks') {
      const data = event.data ?? {};
      const seqs = Array.isArray(data.seqs) ? data.seqs : [];
      if (data.op === 'unlock') {
        for (const seq of seqs) if (!locks.has(seq)) fail('unlock seq ' + seq + ' was not locked');
        for (const seq of seqs) locks.delete(seq);
      } else {
        for (const seq of seqs) {
          if (!surface.includes(seq)) fail('lock seq ' + seq + ' is not on the current surface');
          if (locks.has(seq)) fail('lock seq ' + seq + ' is already locked');
          locks.add(seq);
          const lockedEvent = eventBySeq.get(seq);
          const message = lockedEvent?.data?.message ?? lockedEvent?.data;
          if (String(data.comment ?? '').includes('prelock') && message?.source?.kind !== 'user') fail('prelock target ' + seq + ' is not a user message');
        }
      }
      continue;
    }

    const op = event.surfaceOp;
    if (op === 'append' || op?.op === 'append') {
      if (SURFACE_TYPES.has(event.type)) surface.push(event.seq);
      continue;
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue;
    const start = surface.indexOf(op.startSeq);
    const end = surface.indexOf(op.endSeq);
    if (start < 0 || end < start) {
      fail('replace ' + event.seq + ' endpoints are not on the surface');
      surface.push(event.seq);
      replaceCount += 1;
      continue;
    }
    const shadowed = surface.slice(start, end + 1);
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    if (source?.kind === 'pm-surface') {
      if (!sameSeqs(event.sourceEventSeqs, shadowed)) fail('replace ' + event.seq + ' sourceEventSeqs does not equal shadowed surface slice');
      if (!sameSeqs(source.refs, shadowed)) fail('replace ' + event.seq + ' source.refs does not equal shadowed surface slice');
      const message = event.data?.message;
      if (message?.role !== 'developer') fail('replace ' + event.seq + ' is not a developer message');
      if (source.op === 'hide') {
        if (!Array.isArray(message?.content) || message.content.length !== 0) fail('replace ' + event.seq + ' hide has non-empty content');
      } else if (source.op === 'stabilize') {
        if (!Array.isArray(message?.content) || message.content.length !== 1 || message.content[0]?.type !== 'text') fail('replace ' + event.seq + ' stabilize content shape is wrong');
      }
      if (!Number.isSafeInteger(source.generation) || source.generation < 1) fail('replace ' + event.seq + ' has invalid generation');
      for (const seq of shadowed) if (locks.has(seq)) fail('replace ' + event.seq + ' shadows locked seq ' + seq);
      if (pendingFirst === undefined && Number.isSafeInteger(source.generation)) pendingFirst = source.generation;
      const ids = [source.callId, ...(Array.isArray(source.consumed) ? source.consumed : [])].filter((id) => typeof id === 'string');
      if (ids.length === 0 && !String(source.note ?? '').startsWith('auto-hide') && !String(source.callId ?? '').startsWith('pm-user-')) {
        fail('replace ' + event.seq + ' has no declaration identity');
      }
      for (const id of ids) {
        if (id.startsWith('pm-user-')) continue;
        const declaration = declarations.get(id);
        if (declaration === undefined) fail('replace ' + event.seq + ' references unknown declaration ' + id);
        if (failed.has(id)) fail('replace ' + event.seq + ' applies failed declaration ' + id);
        applied.set(id, event.seq);
      }
    }
    surface.splice(start, end - start + 1, event.seq);
    replaceCount += 1;
  }

  for (const declaration of declarations.values()) {
    if (failed.has(declaration.callId)) {
      if (applied.has(declaration.callId)) fail('failed declaration ' + declaration.callId + ' was applied');
      continue;
    }
    if (declaration.option === 'execute' && !applied.has(declaration.callId)) fail('successful execute ' + declaration.callId + ' has no explicit replacement');
  }

  // 逻辑私有事件：连续编号，物理页 = 该批第一条 PM replace 的 generation。
  let expectedLogical = 0;
  pendingFirst = undefined;
  for (const event of events) {
    if (event.type !== 'plugin:plastic-memories/logical') continue;
    const data = event.data ?? {};
    if (data.logical !== expectedLogical) fail('logical event at seq ' + event.seq + ' expected ' + expectedLogical + ' got ' + data.logical);
    expectedLogical = (Number.isSafeInteger(data.logical) ? data.logical : expectedLogical) + 1;
  }
  return errors;
}
