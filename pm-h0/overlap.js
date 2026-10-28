/**
 * PM — 区间重叠检测（工具与用户命令共用的唯一实现）。
 *
 * 输入是一组“已解析的区间”，每个区间用它在工作面上的消息 seq 数组表示。
 * 两条操作只要覆盖同一个 seq 就算重叠；PM 的三类命令（lock/unlock/稳定化）
 * 在区间不重叠时是可交换的，因此重叠检测就是整个调度器的核心校验。
 *
 * @module dsh-plugin-plastic-memories-h0/overlap
 */

/**
 * 找到第一个重叠对。
 * @param {Array<{seqs:number[]}>} ranges - 已解析区间。
 * @returns {{first:number, second:number, seq:number}|undefined} 重叠信息。
 */
export function findOverlap(ranges) {
  /** @type {Map<number, number>} seq → 区间下标 */
  const seen = new Map();
  for (let index = 0; index < ranges.length; index += 1) {
    const seqs = Array.isArray(ranges[index]?.seqs) ? ranges[index].seqs : [];
    for (const seq of seqs) {
      if (seen.has(seq)) return { first: seen.get(seq), second: index, seq };
      seen.set(seq, index);
    }
  }
  return undefined;
}

/**
 * 两条 seq 区间是否重叠（用于快速双人检查）。
 * @param {number[]} left
 * @param {number[]} right
 * @returns {boolean}
 */
export function rangesOverlap(left, right) {
  const set = new Set(left);
  return right.some((seq) => set.has(seq));
}
