/**
 * PM · 执行规格（execute → surfaceOp）
 *
 * 这一层**不依赖 DSH 的消息推导**：输入是工作面节点（seq + 事件类型）、
 * 操作列表、安全区锁；输出是「应该写出哪些 surfaceOp 事件」。
 * 它回答的是 PM 语义问题：
 *
 *   给定执行前的表面，一次 execute 会把哪几段、替换成什么？
 *
 * 规则（与 CONTRACT.md 一一对应）：
 *   1. 单元 = 一条 assistant 消息 + 紧随其后的 tool 结果；其余节点各自成单元；
 *   2. 每个操作的选择器命中的是一段**连续**单元区间；
 *   3. 该区间对应的 seq 是工作面上的连续片段，起点 = 区间首单元的首个 seq，
 *      终点 = 区间末单元的最后一个 seq；
 *   4. 一个操作恰好写出一条 replace 事件；空文本 = 纯隐藏；
 *   5. 命中系统提示（unit 0）→ 'system-prompt'；
 *   6. 命中安全区 → 'safety-zone'；
 *   7. 越界 → 'out-of-range'；多个操作不得重叠。
 */

/** 单元切分：返回 [{from, to, type}]，from/to 是节点下标（含）。 */
export function unitsOf(nodes) {
  const units = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const type = String(nodes[index]?.type ?? '');
    if (type !== 'assistant/message') {
      units.push({ from: index, to: index, type });
      continue;
    }
    let end = index;
    let cursor = index + 1;
    while (cursor < nodes.length && String(nodes[cursor]?.type ?? '') === 'tool/result') {
      end = cursor;
      cursor += 1;
    }
    units.push({ from: index, to: end, type });
    index = end;
  }
  return units;
}

/** 解析单个选择器 → [a, b]（单元区间）。 */
export function unitsOfSelector(selector) {
  if (typeof selector === 'number') {
    if (!Number.isSafeInteger(selector) || selector < 0) throw new Error('out-of-range');
    return [selector, selector];
  }
  const text = String(selector).trim().toLowerCase().replace(/:$/, '').trim();
  const one = /^(?:unit\s*)?(\d+)$/.exec(text);
  if (one !== null) return [Number(one[1]), Number(one[1])];
  const span = /^(?:unit\s*)?(\d+)\s*(?:to|through|til|-|–)\s*(?:unit\s*)?(\d+)$/.exec(text);
  if (span !== null) return [Number(span[1]), Number(span[2])];
  throw new Error('bad-selector');
}

/**
 * 规格求解：给定执行前表面与操作，算出应写的事件（或应报的错误）。
 *
 * @param {Array<{seq: number, type: string}>} nodes - 执行前工作面。
 * @param {Array<{positions: (string|number), new_text?: string, lock_this?: boolean}>} ops - 操作。
 * @param {{locks?: Set<number>, thisSeq?: number}} [env] - 安全区与 this 定位点。
 * @returns {{events: Array<{startSeq: number, endSeq: number, seqs: number[], text: string}>, error: null|{code: string, index: number}}}
 */
export function specExecute(nodes, ops, env = {}) {
  const locks = env.locks ?? new Set();
  const units = unitsOf(nodes);
  const events = [];
  const seen = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    let range;
    try {
      if (String(op?.positions).trim().toLowerCase() === 'this') {
        if (env.thisSeq === undefined) return { events: [], error: { code: 'no-this', index } };
        const unit = units.findIndex((one) => nodes.slice(one.from, one.to + 1).some((node) => node.seq === env.thisSeq));
        if (unit < 0) return { events: [], error: { code: 'no-this', index } };
        range = [unit, unit];
      } else {
        range = unitsOfSelector(op?.positions);
      }
    } catch (error) {
      return { events: [], error: { code: String(error.message), index } };
    }
    const [a, b] = range;
    if (a > b) return { events: [], error: { code: 'reversed-range', index } };
    if (a >= units.length || b >= units.length) return { events: [], error: { code: 'out-of-range', index } };
    // 规则 5：系统提示只读。这是独立规则，与安全区无关。
    for (let unit = a; unit <= b; unit += 1) {
      if (units[unit].type === 'system/message') return { events: [], error: { code: 'system-prompt', index } };
    }
    const seqs = nodes.slice(units[a].from, units[b].to + 1).map((node) => node.seq);
    // 规则 6：安全区。
    if (seqs.some((seq) => locks.has(seq))) return { events: [], error: { code: 'safety-zone', index } };
    // 规则 7：不得重叠。
    if (seen.some((other) => seqs.some((seq) => other.includes(seq)))) return { events: [], error: { code: 'overlap', index } };
    seen.push(seqs);
    events.push({ startSeq: seqs[0], endSeq: seqs[seqs.length - 1], seqs, text: typeof op?.new_text === 'string' ? op.new_text : '' });
  }
  return { events, error: null };
}

/**
 * 把真实写出的事件与规格对齐比较。
 * @param {Array<object>} spec - specExecute 的结果。
 * @param {Array<object>} actual - 真实事件（{surfaceOp:{op,startSeq,endSeq}, sourceEventSeqs, data.message.content[0].text}）。
 * @returns {string[]} 差异列表；空数组表示一致。
 */
export function diffEvents(spec, actual) {
  const diffs = [];
  if (spec.error !== null) {
    if (actual.length > 0) diffs.push('规格报错 ' + spec.error.code + '，但仍写出 ' + String(actual.length) + ' 条事件');
    return diffs;
  }
  const mine = actual.filter((event) => event?.data?.message?.source?.note === undefined);
  if (mine.length !== spec.events.length) diffs.push('事件数不符：规格 ' + String(spec.events.length) + '，实际 ' + String(mine.length));
  for (let index = 0; index < Math.min(mine.length, spec.events.length); index += 1) {
    const want = spec.events[index];
    const got = mine[index];
    if (got?.surfaceOp?.op !== 'replace') diffs.push('#' + String(index) + ' 不是 replace');
    if (got?.surfaceOp?.startSeq !== want.startSeq || got?.surfaceOp?.endSeq !== want.endSeq) {
      diffs.push('#' + String(index) + ' 区间不符：规格 ' + String(want.startSeq) + '..' + String(want.endSeq) + '，实际 ' + String(got?.surfaceOp?.startSeq) + '..' + String(got?.surfaceOp?.endSeq));
    }
    const refs = Array.isArray(got?.sourceEventSeqs) ? got.sourceEventSeqs : [];
    if (JSON.stringify(refs) !== JSON.stringify(want.seqs)) diffs.push('#' + String(index) + ' sourceEventSeqs 不符');
    const text = String(got?.data?.message?.content?.[0]?.text ?? '');
    if (text !== want.text) diffs.push('#' + String(index) + ' 文本不符：规格 ' + JSON.stringify(want.text) + '，实际 ' + JSON.stringify(text));
  }
  return diffs;
}
