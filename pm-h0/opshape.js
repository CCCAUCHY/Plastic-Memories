/**
 * PM · op 的两种写法归一化。
 *
 * 工具走 JSON（ops[]），命令走文本（`unit 17: 文本`）。两条入口在这个模块里
 * 汇合成同一个 op 形状，再交给 unitops 解析成具体 seq。
 *
 * @module dsh-plugin-plastic-memories-h0/opshape
 */

import { UNIT_SELECTOR_SOURCE, isThisSelector } from './units.js';

/** 段落里允许出现的字段。 */
const OP_FIELDS = new Set(['positions', 'new_text', 'lock_this', 'types']);
const TYPE_NAMES = new Set(['user', 'developer', 'assistant', 'error', 'letter']);

/** 所有 op 可选字段的唯一默认值来源。 */
export const OP_DEFAULTS = Object.freeze({ new_text: '', lock_this: false, types: [] });

/**
 * 校验并归一化一个段落。
 *
 * 段落 = **一组单元 + 一条替代文本**。端点只有一种：单元选择器（unit 17 / unit 17 to 28 / this）。
 *
 * @param {unknown} raw - 模型给的段落。
 * @param {number} index - 段落序号（错误信息用）。
 * @returns {{positions: Array<string|number>, new_text: string, lock_this: boolean, types: string[]}} 段落。
 * @throws {Error} 字段非法时。
 */
export function normalizeOp(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('op #' + index + ' must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!OP_FIELDS.has(key)) {
      throw new Error('op #' + index + ' has unknown field ' + JSON.stringify(key) + '; allowed: ' + [...OP_FIELDS].join(', '));
    }
  }
  if (!Array.isArray(raw.positions) || raw.positions.length === 0) {
    throw new Error('op #' + index + ' positions must be a non-empty array');
  }
  for (const one of raw.positions) {
    if (typeof one !== 'string' && !(typeof one === 'number' && Number.isSafeInteger(one))) {
      throw new Error('op #' + index + ' positions entries must be unit numbers or selector strings ("unit 17", "unit 17 to 28", "this")');
    }
  }
  const newText = raw.new_text === undefined ? OP_DEFAULTS.new_text : raw.new_text;
  if (typeof newText !== 'string') throw new Error('op #' + index + ' new_text must be a string');
  const lockThis = raw.lock_this === undefined ? OP_DEFAULTS.lock_this : raw.lock_this;
  if (typeof lockThis !== 'boolean') throw new Error('op #' + index + ' lock_this must be a boolean');
  const rawTypes = raw.types === undefined ? OP_DEFAULTS.types : raw.types;
  if (!Array.isArray(rawTypes)) throw new Error('op #' + index + ' types must be an array');
  const types = [...new Set(rawTypes)];
  for (const type of types) {
    if (typeof type !== 'string' || !TYPE_NAMES.has(type)) {
      throw new Error('op #' + index + ' types contains unknown type ' + JSON.stringify(type) + '; allowed: ' + [...TYPE_NAMES].join(', '));
    }
  }
  return { positions: [...raw.positions], new_text: newText, lock_this: lockThis, types };
}

const COLON_OP = new RegExp('^(' + UNIT_SELECTOR_SOURCE + ')\\s*:\\s*([\\s\\S]*)$', 'iu');
const BARE_OP = new RegExp('^(' + UNIT_SELECTOR_SOURCE + ')\\s*:?$', 'iu');

/**
 * 把命令里的一段文本解析成与工具相同的 op 形状。
 *
 * **语义等于 `normalizeOp({ positions: [冒号前那段], new_text: 冒号后那段 })`**：
 * 命令只是把「单元素 positions 的 op」写成一行文本，冒号是选择器与替代文本的分界。
 *
 *   - `unit 17: 文本`       → positions: ["unit 17"]，new_text: "文本"
 *   - `unit 17 to 28: 文本`  → positions: ["unit 17 to 28"]（一个元素，一个区间）
 *   - `this: 文本`           → positions: ["this"]
 *   - `unit 17`             → positions: ["unit 17"]，new_text: ""（纯隐藏）
 * @param {string} text - 命令剩余部分。
 * @param {{allowThis?: boolean}} [options] - allowThis=false 时 `this` 直接报错
 *   （它指模型本次调用所在单元，用户手打命令时没有这个锚点）。
 * @returns {{positions: string[], new_text: string, lock_this: boolean, types: string[]}} op。
 */
export function parseOpText(text, options = {}) {
  const op = parseOpSource(text);
  if (options.allowThis === false && op.positions.some((one) => isThisSelector(one))) {
    throw new Error('命令里不能用 this：它指模型本次工具调用所在的单元，只有模型在 run_code 里调用时才有；请写具体单元号，例如 unit 17');
  }
  return op;
}

/**
 * 校验工具参数里的 positions（只做形状校验；语义解析在 units.parseUnitRange）。
 * @param {unknown} value - 原始数组。
 * @param {string} [label] - 报错用的字段名。
 * @returns {Array<string|number>|undefined} 归一化后的数组。
 */
export function normalizeSelectors(value, label = 'positions') {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(label + ' must be a non-empty array of unit selectors, e.g. ["unit 17"] or ["unit 17 to 28"]');
  }
  for (const one of value) {
    if (typeof one === 'string') {
      if (one.trim().length === 0) throw new Error(label + ' entries must not be empty strings');
      continue;
    }
    if (typeof one === 'number' && Number.isSafeInteger(one) && one >= 0) continue;
    throw new Error(label + ' entries must be unit selectors ("unit 17", "unit 17 to 28") or non-negative integers, got ' + JSON.stringify(one));
  }
  return [...value];
}

/** 纯语法解析，不判断 this 的可用性。 */
function parseOpSource(text) {
  const source = String(text ?? '').trim();
  const withText = COLON_OP.exec(source);
  if (withText !== null) return normalizeOp({ positions: [withText[1]], new_text: withText[2] }, 0);
  const bare = BARE_OP.exec(source);
  if (bare !== null) return normalizeOp({ positions: [bare[1]], new_text: '' }, 0);
  const trailing = new RegExp('^' + UNIT_SELECTOR_SOURCE + '\\s', 'iu').test(source);
  if (trailing) throw new Error('选择器后面要用冒号接替代文本：unit 17: 要写入的文本');
  throw new Error('选择器要写成 unit 17、unit 17 to 28 或 this');
}
