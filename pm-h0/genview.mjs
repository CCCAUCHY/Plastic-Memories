/**
 * PM · 世代视图规格（语法 → 世代内容）
 *
 * 输入：上一代模型实际收到的消息（DSH 折叠结果，作为基线）、本次 execute 的 ops。
 * 输出：下一代**应该**包含的行 [{ unit, type, text }]。
 *
 * 规则（只看 PM 语法，不碰任何插件内部结构）：
 *   1. 单元 = 一条 assistant 消息 + 紧随其后的 tool 消息；其余各自成单元；
 *   2. 一个操作把单元区间 [a,b] 整段换成一条 developer 消息（文本为空则消失）；
 *   3. 其余单元原样保留，单元号按新顺序重新计数。
 *
 * 用它去比对 set 预览（提交前）与 retrospect(self)（提交后），
 * 就能得到「预览 ≡ 结果」和「结果 = 语法描述」两条性质。
 */

/** 把 DSH 消息折成单元行：[{unit, type, text}]。 */
export function rowsOfMessages(messages) {
  const rows = [];
  let unit = -1;
  let inToolRun = false;
  for (const message of messages) {
    const role = String(message?.role ?? 'unknown');
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
    if (role === 'assistant') {
      unit += 1;
      inToolRun = true;
    } else if (role === 'tool' && inToolRun) {
      // 同属上一条 assistant 的单元
    } else {
      unit += 1;
      inToolRun = false;
    }
    rows.push({ unit, type: role, text });
  }
  return rows;
}

/** 解析选择器为单元区间。 */
export function rangeOf(selector) {
  if (typeof selector === 'number') return [selector, selector];
  const text = String(selector).trim().toLowerCase().replace(/:$/, '').trim();
  const one = /^(?:unit\s*)?(\d+)$/.exec(text);
  if (one !== null) return [Number(one[1]), Number(one[1])];
  const span = /^(?:unit\s*)?(\d+)\s*(?:to|through|til|-|–)\s*(?:unit\s*)?(\d+)$/.exec(text);
  if (span !== null) return [Number(span[1]), Number(span[2])];
  throw new Error('bad selector ' + JSON.stringify(selector));
}

/**
 * 按语法算出下一代的单元行。
 * @param {Array<{unit: number, type: string, text: string}>} baseRows - 上一代的行。
 * @param {Array<{positions: (string|number), new_text?: string}>} ops - 操作。
 * @returns {Array<{unit: number, type: string, text: string}>} 下一代的行（单元号重排）。
 */
export function expectedRows(baseRows, ops) {
  const unitCount = baseRows.reduce((max, row) => Math.max(max, row.unit), -1) + 1;
  const edits = ops.map((op) => {
    const [a, b] = rangeOf(op.positions);
    if (a < 0 || b >= unitCount || a > b) throw new Error('unit out of range: ' + String(op.positions));
    return { a, b, text: typeof op.new_text === 'string' ? op.new_text : '' };
  });
  edits.sort((left, right) => left.a - right.a);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].a <= edits[index - 1].b) throw new Error('overlapping ops');
  }
  const out = [];
  let unit = 0;
  let cursor = 0;
  const pushUnit = (rows) => {
    for (const row of rows) out.push({ unit, type: row.type, text: row.text });
    unit += rows.length > 0 ? 1 : 0;
  };
  const nextEdit = () => edits.shift();
  let edit = nextEdit();
  while (cursor < unitCount) {
    if (edit !== undefined && cursor === edit.a) {
      if (edit.text.length > 0) {
        out.push({ unit, type: 'developer', text: edit.text });
        unit += 1;
      }
      cursor = edit.b + 1;
      edit = nextEdit();
      continue;
    }
    const rows = baseRows.filter((row) => row.unit === cursor);
    pushUnit(rows);
    cursor += 1;
  }
  return out;
}

/**
 * 只比较 unit 与 text。
 * type 是 PM 自己的分类（other/skill/agent…），不属于「语法描述」的一部分；
 * 替代文本的角色另有专门断言。
 */
export function shapeOfRows(rows) {
  return rows.map((row) => String(row.unit) + '|' + String(row.text ?? ''));
}
