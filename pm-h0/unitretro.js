/**
 * PM · retrospect 的当前世代单元视图。
 *
 * @module dsh-plugin-plastic-memories-h0/unitretro
 */

import { currentUnits, unitView } from './units.js';
import { lockedSeqs } from './engine.js';
import { logicalBoundaries } from './boundaries.js';

function clipText(text, preview) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!preview) return oneLine;
  return oneLine.length <= 240 ? oneLine : oneLine.slice(0, 180) + '……' + oneLine.slice(-40);
}

/**
 * 返回当前世代单元数组。
 * @param {object} session - 目标会话。
 * @param {{preview?: boolean}} [options] - preview 默认 true（只裁剪文本，结构不变）。
 * @returns {string} JSON。
 */
export function retrospectUnits(session, options = {}) {
  const preview = options.preview !== false;
  const locks = lockedSeqs(session);
  const units = currentUnits(session, { locks }).map((unit) => {
    const view = unitView(unit);
    return { ...view, text: clipText(view.text, preview), results: view.results.map((result) => ({ ...result, text: clipText(result.text, preview) })) };
  });
  const info = logicalBoundaries(session.snapshotEvents());
  return JSON.stringify({ logical: info.self, count: units.length, preview, units });
}
