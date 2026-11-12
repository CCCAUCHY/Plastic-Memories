/**
 * PM · 单元序号寻址。
 *
 * plasticize 的 ops[].positions：当前世代单元序号（0 起），支持
 * "unit 3"、"unit 3 to 7"、"this"。一个 op 里的多个 selector 按单元顺序
 * 展开：前段隐藏，new_text 落在最后一个单元。
 *
 * @module dsh-plugin-plastic-memories-h0/unitops
 */

import { currentUnits, isThisSelector, parseUnitRange } from './units.js';

/** 找出 this 指向的单元：承载本次声明的那条 assistant 单元。 */
function unitForHere(units, here) {
  if (here === undefined || here === null) return undefined;
  const seqs = [here.thisSeq, here.thisEndSeq].filter(Number.isSafeInteger);
  return units.find((unit) => seqs.some((seq) => unit.seqs.includes(seq)));
}

/** 把一组单元序号合并成连续区间。 */
function unitRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/**
 * 解析 positions 形式的 ops。
 * @param {object} session - 目标会话。
 * @param {Array<object>} rawOps - 原始 ops。
 * @param {{thisSeq?: number, thisEndSeq?: number}} here - this 定位点。
 * @returns {Array<{op: object, shadowed: number[]}>} 与 resolveOps 同形。
 */
export function resolveUnitOps(session, rawOps, here) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) throw new Error('ops must be a non-empty array');
  const units = currentUnits(session);
  const thisUnit = unitForHere(units, here);
  const out = [];
  for (let index = 0; index < rawOps.length; index += 1) {
    const raw = rawOps[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('op #' + index + ' must be an object');
    const positions = raw.positions;
    if (!Array.isArray(positions) || positions.length === 0) throw new Error('op #' + index + ' positions must be a non-empty array');
    const newText = raw.new_text === undefined ? '' : raw.new_text;
    if (typeof newText !== 'string') throw new Error('op #' + index + ' new_text must be a string');
    const picked = [];
    for (const selector of positions) {
      if (isThisSelector(selector)) {
        if (thisUnit === undefined) throw new Error('op #' + index + ': this is not resolvable');
        picked.push(thisUnit.n);
        continue;
      }
      try { picked.push(...parseUnitRange(selector)); } catch (error) { throw new Error('op #' + index + ': ' + error.message); }
    }
    for (const n of picked) if (n < 0 || n >= units.length) throw new Error('op #' + index + ': unit ' + n + ' is out of range (0..' + (units.length - 1) + ')');
    const ranges = unitRanges(picked);
    if (ranges.length === 0) throw new Error('op #' + index + ' selects no units');
    for (let r = 0; r < ranges.length; r += 1) {
      const [start, end] = ranges[r];
      const selected = units.slice(start, end + 1);
      const shadowed = selected.flatMap((unit) => unit.seqs);
      out.push({
        op: { ...raw, new_text: r === ranges.length - 1 ? newText : '', positions: undefined },
        shadowed,
      });
    }
  }
  return out;
}
