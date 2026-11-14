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
import { normalizeOp, isLastSetMacro } from './opshape.js';
import { findLastPendingSet } from './pending.js';

/** 找出 this 指向的单元：承载本次声明的那条 assistant 单元。 */
function unitForHere(units, here) {
  if (here === undefined || here === null) return undefined;
  const seqs = [here.thisSeq, here.thisEndSeq].filter(Number.isSafeInteger);
  return units.find((unit) => seqs.some((seq) => unit.seqs.includes(seq)));
}

/**
 * 把 ops 里的宏元素替换成待决 set 的 ops（原地展开，顺序保持）。
 * @param {object} session
 * @param {Array<object>} ops
 * @param {{replayed?: boolean}} options
 * @returns {Array<object>} 展开后的 ops。
 */
function expandLastSetMacro(session, ops, options) {
  const marks = [];
  for (let index = 0; index < ops.length; index += 1) if (isLastSetMacro(ops[index])) marks.push(index);
  if (marks.length === 0) return ops;
  if (marks.length > 1) throw new Error('"the last plasticize(set)" may appear only once in ops');
  if (options.replayed === true) throw new Error('the pending set itself references "the last plasticize(set)"; fix that set instead');
  const pending = findLastPendingSet(session);
  if (pending === undefined) throw new Error('there is no pending plasticize(set) to replay; pass the ops explicitly');
  const index = marks[0];
  return [...ops.slice(0, index), ...pending.ops, ...ops.slice(index + 1)];
}

/**
 * 解析 positions 形式的 ops。
 * @param {object} session - 目标会话。
 * @param {Array<object>} rawOps - 原始 ops。
 * @param {{thisSeq?: number, thisEndSeq?: number}} here - this 定位点。
 * @returns {Array<{op: object, shadowed: number[]}>} 与 resolveOps 同形。
 */
export function resolveUnitOps(session, rawOps, here, options = {}) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) throw new Error('ops must be a non-empty array');
  // `{ "the last plasticize(set)" }` 是 ops 里的一个宏元素：把它替换成待决 set 的 ops 数组。
  // 它只能出现一次，且不能出现在 set 自己身上（由工具层拒绝）。
  const expanded = expandLastSetMacro(session, rawOps, options);
  const units = currentUnits(session);
  const thisUnit = unitForHere(units, here);
  const out = [];
  for (let index = 0; index < expanded.length; index += 1) {
    // 与命令路径共用同一个 op 校验器（opshape.js），不在这里重复一套规则。
    const raw = normalizeOp(expanded[index], index);
    const selector = raw.positions;
    const newText = raw.new_text;
    const picked = [];
    if (isThisSelector(selector)) {
      if (thisUnit === undefined) throw new Error('op #' + index + ': this is not resolvable');
      picked.push(thisUnit.n);
    } else {
      try { picked.push(...parseUnitRange(selector)); } catch (error) { throw new Error('op #' + index + ': ' + error.message); }
    }
    for (const n of picked) if (n < 0 || n >= units.length) throw new Error('op #' + index + ': unit ' + n + ' is out of range (0..' + (units.length - 1) + ')');
    // 一个 op 只对应一个连续单元区间 → 一条 surfaceOp。
    // positions 已经是单值选择器，不会再出现「多段里只有最后一段拿到 new_text」的旧规则。
    const start = picked[0];
    const end = picked[picked.length - 1];
    if (end - start + 1 !== picked.length) throw new Error('op #' + index + ' selected a non-contiguous range');
    const selected = units.slice(start, end + 1);
    // DSH 只允许 system/message 改写系统提示；用 developer 替代会被宿主拒绝，
    // 所以这里提前给出可读的错误，而不是让整批投影在提交边界静默跳过。
    const systemUnit = selected.find((unit) => unit.role === 'system');
    if (systemUnit !== undefined) {
      // 独立错误码：系统提示只读是宿主约束，与安全区（用户锁定）无关。
      const error = new Error('op #' + index + ' 命中了系统提示（unit ' + String(systemUnit.n) + '），它只能查看、不能被重塑；请选择其它单元');
      error.code = 'system-prompt';
      throw error;
    }
    const shadowed = selected.flatMap((unit) => unit.seqs);
    out.push({ op: { ...raw, new_text: newText, positions: undefined }, shadowed });
  }
  return out;
}
