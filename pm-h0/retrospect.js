/**
 * PM · retrospect —— 只读查询，**只回答「已经看不见的东西」**。
 *
 * ## 为什么只查隐藏的
 *
 * `plasticize` 只能操作**当前世代**（工作面）上的消息。当前世代的东西模型本来就看得见，
 * 查它没有任何意义 —— 而且有害：
 *
 * 实测（session-bf16763e）：模型按提示「先 retrospect 再匹配」查了关键词，
 * retrospect 把命中原文**逐条抄录**进上下文，于是那段输出本身包含了模型查的每一个词。
 * 之后 plasticize 的关键字组匹配就再也收敛不了 —— 加到 7 个词仍卡在 3 条，
 * 因为其中两条正是 retrospect 自己的输出。**排除它们后，2 个词就唯一了。**
 *
 * 所以范围收窄成：只列**已被遮蔽**的原文（self - n）。它们是模型确实看不见、
 * 也确实可能想重新引入的东西。
 *
 * ## 两个刻意的设计
 *
 * 1. **完整返回，绝不截断** —— 截断只属于预览。查询要的是事实，不是摘要。
 * 2. **坐标只有世代 + 世代内序号** —— 底层 seq 不出现在输出里。它是实现细节，
 *    而且模型拿它做不了任何事（plasticize 不接受 seq 参数）。
 *
 * @module dsh-plugin-plastic-memories-h0/retrospect
 */

import { derivedMessage, messageText, surfaceNodes } from './coords.js';

const NL = String.fromCharCode(10);

/**
 * 求一个事件属于哪个过往世代。
 * @param {object} session - 目标会话。
 * @param {number} seq - 事件 seq。
 * @param {number} current - 当前世代号。
 * @returns {string} 形如 self - 1；找不到遮蔽者时返回 self - ?。
 */
function generationLabelOf(session, seq, current) {
  for (const event of session.snapshotEvents()) {
    const refs = event.sourceEventSeqs;
    if (!Array.isArray(refs) || !refs.includes(seq)) continue;
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    if (source?.kind !== 'pm-surface') continue;
    const gen = typeof source.generation === 'number' ? source.generation : 0;
    return 'self - ' + Math.max(1, current - gen + 1);
  }
  return 'self - ?';
}

/**
 * 在**已被遮蔽**的原文里检索。
 * @param {object} session - 目标会话。
 * @param {{query: string, context?: number, limit?: number}} args - 查询参数。
 * @returns {string} 格式化结果（**完整文本，不截断**）。
 */
export function retrospect(session, args) {
  const query = typeof args?.query === 'string' ? args.query : '';
  if (query.length === 0) throw new Error('query 不能为空');
  const context = Number.isSafeInteger(args?.context) ? Math.max(0, args.context) : 0;
  const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20;

  const nodes = surfaceNodes(session);
  const visible = new Set(nodes);
  const events = session.snapshotEvents();
  const current = session.surface.replaceGeneration;
  const needle = query.toLowerCase();

  // 注意 rows 必须带 i：want 集合与输出循环都按**全局下标**匹配，
  // 少了它 row.i 恒为 undefined，输出会一行都不剩（踩过）。
  const rows = events.map((event, i) => {
    const message = derivedMessage(session, event);
    return { i, event, message, text: messageText(message) };
  });

  // **只看隐藏的**：还在工作面上的消息模型自己看得见，列出来只会污染它的匹配空间。
  const hidden = rows.filter((row) => !visible.has(row.event.seq));

  const hitIndexes = [];
  for (const row of hidden) {
    if (row.text.length === 0) continue;
    if (row.text.toLowerCase().includes(needle)) hitIndexes.push(row.i);
  }

  const shown = hitIndexes.slice(0, limit);
  const want = new Set();
  for (const i of shown) {
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) want.add(k);
  }

  const lines = [];
  lines.push('retrospect: ' + hitIndexes.length + ' 条命中（关键词 ' + JSON.stringify(query) +
    '；只查**已隐藏**的原文 —— 当前世代 self 的东西你看得见，不在查询范围）');
  lines.push('当前世代 self，工作面 ' + nodes.length + ' 条消息，日志 ' + events.length + ' 条事件，世代号 ' + current + '。');
  if (hitIndexes.length === 0) {
    lines.push('');
    lines.push('（没有已隐藏的原文含这个词。如果你要压缩的是**当前看得见**的东西，');
    lines.push('  直接用文本关键字组或偏移量调 plasticize —— 不需要先查。）');
    return lines.join(NL);
  }
  if (hitIndexes.length > shown.length) {
    lines.push('（只显示前 ' + shown.length + ' 条；提高 limit 或换更具体的关键词）');
  }
  lines.push('');

  const hits = new Set(shown);
  let gapShown = false;
  for (const row of rows) {
    if (!want.has(row.i)) continue;
    const isHit = hits.has(row.i);
    if (!isHit && !gapShown) {
      lines.push('  ……');
      gapShown = true;
    }
    if (isHit) gapShown = false;
    const role = row.message === undefined ? row.event.type : String(row.message.role);
    const where = visible.has(row.event.seq)
      ? 'self（本行是上下文，不是命中）'
      : generationLabelOf(session, row.event.seq, current);
    lines.push((isHit ? '▶ ' : '  ') + '[' + where + '] ' + role + ' / ' + row.event.type);
    lines.push(row.text.length === 0 ? '  （无文本内容）' : row.text);
    lines.push('');
  }

  return lines.join(NL);
}
