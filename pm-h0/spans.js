/**
 * PM · 区间语法。
 *
 * ## 为什么只有 cookie 端点
 *
 * 关键字匹配会被模型**自己的推理**污染（实测：模型连续 7 次失败，全是「同时匹配到多条」）；
 * 偏移量模型**数不准**。所以端点只剩两种：**cookie 编号**与 **this**。
 *
 * ## 语法
 *
 *     "3"          仅端点 —— 就是第 3 号 cookie 那条消息
 *     "[3,4]"      闭区间，两端都含
 *     "(3,4)"      开区间，两端都不含
 *     "[3,4)"      半开半闭
 *     "(3,4]"      半开半闭
 *     "this"       本次 plasticize 所在的 assistant 消息 + 它的工具结果
 *     "[3,this]"   可以混用
 *
 * 「仅端点」写成 3 而不是 [3,3] —— 与 this 的风格保持一致。
 *
 * **「不含」就是不含那条 cookie 消息本身** —— cookie 也是消息，两者是一回事。
 *
 * **「不含 this」= 不含整个 this 组**：this 是一个原子单元（调用消息 + 全部工具结果），
 * 不能只排除它的一半 —— 那会留下孤儿 tool/result。
 *
 * ## 端点顺序
 *
 * 两端**不分起始与结束**，插件自动排序（小的在左）。
 * 区间就是数轴上的点集，没有方向。
 *
 * @module dsh-plugin-plastic-memories-h0/spans
 */

import { cookieIndex, maxVisibleCookieId } from './cookie.js';

/** this 端点的哨兵值。 */
export const SELF = Symbol('this');

/**
 * 解析一个区间字符串。
 * @param {string} raw - 区间文本。
 * @returns {{a: (number|symbol), b: (number|symbol), openA: boolean, openB: boolean}} 解析结果。
 */
export function parseSpan(raw) {
  const text = String(raw).trim();
  if (text.length === 0) throw new Error('span must not be empty');

  const endpoint = (tok) => {
    const t = tok.trim();
    if (t === 'this') return SELF;
    if (!/^[0-9]+$/.test(t)) {
      throw new Error('invalid endpoint ' + JSON.stringify(t) + ': expected a cookie number or "this"');
    }
    const n = Number(t);
    if (n < 1) throw new Error('cookie numbers start at 1; got ' + n);
    return n;
  };

  // 仅端点：3 或 this
  if (!text.startsWith('[') && !text.startsWith('(')) {
    const one = endpoint(text);
    return { a: one, b: one, openA: false, openB: false };
  }

  const openA = text.startsWith('(');
  const closeCh = text.slice(-1);
  if (closeCh !== ']' && closeCh !== ')') {
    throw new Error('span ' + JSON.stringify(text) + ' has an unclosed bracket');
  }
  const openB = closeCh === ')';
  const inner = text.slice(1, -1);
  const cut = inner.indexOf(',');
  if (cut === -1) {
    throw new Error('span ' + JSON.stringify(text) + ' is missing a comma; for a single endpoint write the number directly, not [3]');
  }
  if (inner.indexOf(',', cut + 1) !== -1) {
    throw new Error('span ' + JSON.stringify(text) + ' must have exactly two endpoints');
  }
  return { a: endpoint(inner.slice(0, cut)), b: endpoint(inner.slice(cut + 1)), openA, openB };
}

/**
 * 把 this 端点解析成工作面下标区间。
 * @param {object} view - 只读视图。
 * @param {object} here - 本步端点 {thisSeq, thisEndSeq}。
 * @returns {{index: number, endIndex: number}} 下标区间。
 */
function resolveSelf(view, here) {
  if (here === undefined || here === null) {
    throw new Error('the "this" endpoint is only valid inside a plasticize call (no step coordinates)');
  }
  const nodes = view.surface.nodes;
  const i = nodes.indexOf(here.thisSeq);
  const j = nodes.indexOf(here.thisEndSeq);
  if (i === -1 || j === -1) {
    throw new Error('cannot locate the "this" endpoint (the assistant message making this call and its tool results) on the current surface');
  }
  return { index: i, endIndex: j };
}

/**
 * 把一个端点解析成工作面下标。
 * @param {object} view - 只读视图。
 * @param {(number|symbol)} tok - cookie 编号或 SELF。
 * @param {object} here - 本步端点。
 * @returns {{index: number, isSelf: boolean}} 结果。
 */
function resolveOne(view, tok, here) {
  if (tok === SELF) return { index: resolveSelf(view, here).index, isSelf: true };
  const found = cookieIndex(view, tok);
  if (found === undefined) {
    throw new Error('cookie ' + tok + ' not found. The largest visible cookie number is ' + maxVisibleCookieId(view) +
      ' (cookie numbers grow in log order; it may have been hidden by the projection, or not inserted yet).');
  }
  return { index: found.index, isSelf: false };
}

/**
 * 把一个区间字符串解析成工作面下标区间（闭）。
 *
 * 两端**自动排序**。开闭决定是否含**那个 cookie 消息本身**；
 * 对 this 端点来说，开括号表示**排除整个 this 组**（组是原子单元）。
 * @param {object} view - 只读视图。
 * @param {string} raw - 区间文本。
 * @param {object} here - 本步端点 {thisSeq, thisEndSeq}。
 * @returns {{startIndex: number, endIndex: number}} 下标区间。
 */
export function resolveSpan(view, raw, here) {
  const spec = parseSpan(raw);
  const left = resolveOne(view, spec.a, here);
  const right = resolveOne(view, spec.b, here);

  const swap = left.index > right.index;
  let lo = swap ? right.index : left.index;
  let hi = swap ? left.index : right.index;
  const loSelf = swap ? right.isSelf : left.isSelf;
  const hiSelf = swap ? left.isSelf : right.isSelf;
  const openLo = swap ? spec.openB : spec.openA;
  const openHi = swap ? spec.openA : spec.openB;

  if (loSelf || hiSelf) {
    const self = resolveSelf(view, here);
    lo = Math.min(lo, self.index);
    hi = Math.max(hi, self.endIndex);
    // 开括号排除的是「那个端点的整体」——this 的整体就是整组。
    if (openLo && loSelf) lo = self.endIndex + 1;
    else if (openLo) lo += 1;
    if (openHi && hiSelf) hi = self.index - 1;
    else if (openHi) hi -= 1;
  } else {
    if (openLo) lo += 1;
    if (openHi) hi -= 1;
  }

  if (lo > hi) {
    throw new Error('span ' + JSON.stringify(String(raw)) + ' is empty (open brackets exclude every endpoint)');
  }
  return { startIndex: lo, endIndex: hi };
}