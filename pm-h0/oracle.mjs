/**
 * PM · 独立规格（oracle）：完全不 import engine / units / plasticize。
 *
 * 只从「消息列表」出发，用最朴素的算法描述一次 execute 应该得到什么：
 *   - 单元 = 一条 assistant 消息 + 紧随其后的 tool 消息（其余消息各自成单元）；
 *   - 一次 execute 的所有操作都针对**同一个**执行前表面解析；
 *   - 一个操作 = 把单元区间 [a,b] 替换成一条 developer 消息（文本为空则整段消失）。
 *
 * 用它和真实管线对比，就是「语法 → surfaceOp → 消息」的差分测试。
 */

/** 单元切分：返回每个单元的消息下标区间 [start, end]（含）。 */
export function unitRangesOf(messages) {
  const ranges = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = typeof message?.role === 'string' ? message.role : '';
    if (role !== 'assistant') {
      ranges.push([index, index]);
      continue;
    }
    let end = index;
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      end = cursor;
      cursor += 1;
    }
    ranges.push([index, end]);
    index = end;
  }
  return ranges;
}

/** 解析一个选择器（只支持数字与 unit N / unit N to M，用于生成器）。 */
export function parseSelectorSpec(selector) {
  if (typeof selector === 'number') return [selector, selector];
  const text = String(selector).trim().toLowerCase().replace(/:$/, '').trim();
  const one = /^(?:unit\s*)?(\d+)$/.exec(text);
  if (one !== null) return [Number(one[1]), Number(one[1])];
  const span = /^unit\s*(\d+)\s*to\s*(\d+)$/.exec(text);
  if (span !== null) return [Number(span[1]), Number(span[2])];
  throw new Error('oracle: unsupported selector ' + JSON.stringify(selector));
}

/**
 * 按规格算出 execute 之后的消息列表。
 * @param {Array<object>} preMessages - 执行前的消息。
 * @param {Array<{positions: (string|number), new_text?: string}>} ops - 操作。
 * @returns {Array<object>} 期望的消息列表。
 */
export function expectedMessages(preMessages, ops) {
  const units = unitRangesOf(preMessages);
  const edits = ops.map((op) => {
    const [a, b] = parseSelectorSpec(op.positions);
    if (a < 0 || b >= units.length || a > b) throw new Error('oracle: unit out of range ' + String(op.positions));
    return { a, b, text: typeof op.new_text === 'string' ? op.new_text : '' };
  });
  edits.sort((left, right) => left.a - right.a);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].a <= edits[index - 1].b) throw new Error('oracle: overlapping ops');
  }
  const out = [];
  let cursor = 0;
  for (const edit of edits) {
    const start = units[edit.a][0];
    const end = units[edit.b][1];
    for (; cursor < start; cursor += 1) out.push(preMessages[cursor]);
    if (edit.text.length > 0) {
      out.push({ role: 'developer', content: [{ type: 'text', text: edit.text }] });
    }
    cursor = end + 1;
  }
  for (; cursor < preMessages.length; cursor += 1) out.push(preMessages[cursor]);
  return out;
}

/** 把消息折成可比较的形状：role + 纯文本。 */
export function shapeOf(messages) {
  return messages.map((message) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
    return String(message?.role) + '|' + text;
  });
}
