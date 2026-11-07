/**
 * PM · 压缩后的安全区重放。
 *
 * 说明：DSH surfaceOp 只有 append / replace，没有 insert；重放只能追加到
 * 当前 surface 末尾。引言使用位置无关措辞。
 *
 * @module dsh-plugin-plastic-memories-h0/safetyreplay
 */

import { derivedMessage, messageText, roleOfEvent } from './coords.js';
import { lockedSeqs } from './engine.js';
import { successfulCompactions } from './boundaries.js';

const INTRO = 'A condensed summary appears earlier in this context. Below is verbatim content from a subset of the messages it covers:';
const OUTRO = 'End of verbatim content from the summarized messages.';
const SOURCE = 'pm-safety-replay';

function existingReplays(events) {
  const done = new Set();
  for (const event of events) {
    if (event.type === 'developer/message' && event.data?.message?.source?.kind === SOURCE && typeof event.data.message.source.compactionId === 'string') {
      done.add(event.data.message.source.compactionId);
    }
  }
  return done;
}

function appendReplayMessage(session, text, source, turn, step) {
  const message = {
    id: 'pm-safety-replay-' + String(session.seq),
    role: 'developer',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source,
  };
  if (Number.isSafeInteger(turn) && Number.isSafeInteger(step)) session.append('developer/message', { turn, step, message }, { surfaceOp: 'append' });
  else session.append('developer/message', { message }, { surfaceOp: 'append' });
}

/**
 * 追加被压缩阴影遮蔽的锁定原文。
 * @param {object} session
 * @param {{turn?:number, step?:number}} [at] - 当前 step。
 * @returns {number} 重放的压缩数。
 */
export function replayCompactedSafety(session, at = {}) {
  if (session === undefined || session === null) return 0;
  const events = session.snapshotEvents();
  const locks = lockedSeqs(session);
  if (locks.size === 0) return 0;
  const done = existingReplays(events);
  const compactions = successfulCompactions(events);
  let replayed = 0;
  for (const compaction of compactions) {
    if (done.has(compaction.id)) continue;
    const summary = events.find((event) => event.type === 'compaction/summary' && event.data?.compactionId === compaction.id);
    const shadowed = Array.isArray(summary?.data?.shadowedSeqs) ? summary.data.shadowedSeqs : [];
    const locked = shadowed.filter((seq) => locks.has(seq)).slice(0, 64);
    if (locked.length === 0) continue;
    const sourceBase = { kind: SOURCE, compactionId: compaction.id, seqs: locked };
    appendReplayMessage(session, INTRO, sourceBase, at.turn, at.step);
    for (const seq of locked) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      const message = derivedMessage(session, event);
      const text = messageText(message);
      const role = String(message?.role ?? roleOfEvent(event) ?? event.type);
      appendReplayMessage(session, '[' + role + '] ' + text, { ...sourceBase, originalSeq: seq }, at.turn, at.step);
    }
    appendReplayMessage(session, OUTRO, sourceBase, at.turn, at.step);
    replayed += 1;
  }
  return replayed;
}
