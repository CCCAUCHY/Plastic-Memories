/**
 * PM · logical boundaries（PM private events + successful compaction checkpoints）。
 *
 * 逻辑世代编号 0 起；每个边界产生下一代。PM private event 是冻结边界，
 * compaction checkpoint 是压缩产生的新世代边界。
 *
 * @module dsh-plugin-plastic-memories-h0/boundaries
 */

/** 成功压缩：start/end 同 id，end 无 error，且存在 compact-checkpoint。 */
export function successfulCompactions(events) {
  const starts = new Map();
  const ends = new Map();
  const checkpoints = new Map();
  for (const event of events) {
    if (event.type === 'compaction/start' && typeof event.data?.compactionId === 'string') {
      starts.set(event.data.compactionId, event);
    } else if (event.type === 'compaction/end' && typeof event.data?.compactionId === 'string') {
      ends.set(event.data.compactionId, event);
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') {
      const id = event.data.source.compactionId;
      if (typeof id === 'string') checkpoints.set(id, event);
    }
  }
  const out = [];
  for (const [id, checkpoint] of checkpoints) {
    const end = ends.get(id);
    if (end === undefined || end.data?.error !== undefined) continue;
    out.push({ id, seq: checkpoint.seq, start: starts.get(id)?.seq, end: end.seq, checkpoint });
  }
  return out.sort((left, right) => left.seq - right.seq);
}

/**
 * 逻辑边界（PM private event + 成功压缩 checkpoint），按 seq 排序。
 * @param {Array<object>} events - 会话事件。
 * @returns {{boundaries: Array<object>, self: number, logicalOfPrivate: Map<number, number>}}
 */
export function logicalBoundaries(events) {
  const compactions = successfulCompactions(events);
  const boundaries = [];
  for (const event of events) {
    if (event.type === 'plugin:plastic-memories/logical') {
      boundaries.push({
        seq: event.seq,
        kind: event.data?.kind === 'user-projection' ? 'projection' : 'execute',
        callId: event.data?.callId,
        event,
      });
    }
  }
  for (const compaction of compactions) boundaries.push({ seq: compaction.seq, kind: 'compaction', compaction });
  boundaries.sort((left, right) => left.seq - right.seq);
  const logicalOfPrivate = new Map();
  boundaries.forEach((boundary, logical) => {
    boundary.logical = logical;
    if (boundary.kind !== 'compaction') logicalOfPrivate.set(boundary.seq, logical);
  });
  return { boundaries, self: boundaries.length, logicalOfPrivate };
}
