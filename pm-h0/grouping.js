/**
 * PM · 消息组合（grouping）—— 「多条消息合起来才合法」的统一抽象。
 *
 * ## 为什么需要抽象
 *
 * 底层 Trajectory 里有些节点**不能单独存在**：
 *
 * - `tool/result` 必须跟着发起它的 `assistant/message`（工具调用块）
 * - 将来可能还有别的：并行子代理的派发/回收、成对出现的审批请求与裁决、
 *   流式片段的头尾……
 *
 * 它们的共同形状是：**若干连续节点组成一个原子单元，只有单元边界才是合法切口**。
 * 单元内部的任何切口都会留下孤儿，被读侧拒绝 —— 而那种投影本身没有意义。
 *
 * ## 抽象：把「合法切口」定义成开集归零
 *
 * 每个节点声明它**开启**（opens）与**关闭**（closes）哪些关系键。
 * 沿工作面扫描，维护一个开集：
 *
 *   位置之前开集为 0  →  可以作**起点**
 *   位置之后开集为 0  →  可以作**终点**
 *
 * 于是「扩展」退化成一句话：**把端点滑到最近的开集归零处**。
 *
 * 这个定义**不提及任何具体事件类型** —— 新增一种组合只需注册一个 trait，
 * 配对平衡、端点扩展、错误信息全部自动跟上。
 *
 * @module dsh-plugin-plastic-memories-h0/grouping
 */

const NL = String.fromCharCode(10);

// ─────────────────────────────────────────────────────────────────────────────
// 关系 trait：每注册一个，「多条消息才合法」的结构就多一种被自动处理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 工具调用块：一条 assistant 消息里的每个 tool-call，由对应的 tool/result 关闭。
 *
 * 并发调用天然覆盖 —— 一条 assistant 带多个 tool-call 时开启多个关系键，
 * 全部关闭才算走完这个组合；结果乱序落地也不影响。
 */
export const TOOL_CALL = {
  id: 'tool-call',
  describe: '一次工具调用与它的全部结果',

  /**
   * @param {object} event - 会话事件。
   * @returns {{opens?: string[], closes?: string[], malformed?: boolean}|undefined}} 关系；与此 trait 无关时返回 undefined。
   */
  keyOf(event) {
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return undefined;
      const opens = [];
      let malformed = false;
      for (const block of content) {
        if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue;
        const callId = block.callId ?? block.id;
        if (typeof callId !== 'string' || callId.length === 0) { malformed = true; continue; }
        opens.push('tool-call:' + callId);
      }
      return opens.length === 0 && !malformed ? undefined : { opens, malformed };
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId;
      if (typeof callId !== 'string' || callId.length === 0) return { malformed: true };
      return { closes: ['tool-call:' + callId] };
    }
    return undefined;
  },
};

/**
 * 当前的组合注册表。**新增组合类型只需要在这里加一项。**
 *
 * 每一项都会被下面所有函数自动纳入：开集画像、配对平衡、端点扩展、
 * 以及给模型的错误信息。
 * @type {Map<string, object>}
 */
export const GROUPINGS = new Map([[TOOL_CALL.id, TOOL_CALL]]);

// ─────────────────────────────────────────────────────────────────────────────
// 开集画像 —— 一切判断的事实基础
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个节点开启/关闭了哪些关系。
 * @param {object} event - 会话事件。
 * @param {Map<string, object>} [registry] - trait 注册表；默认 GROUPINGS。
 * @returns {{opens: string[], closes: string[], malformed: number}} 结果。
 */
export function relationsOf(event, registry = GROUPINGS) {
  const opens = [];
  const closes = [];
  let malformed = 0;
  for (const trait of registry.values()) {
    let r;
    try { r = trait.keyOf(event); } catch { r = undefined; }
    if (r === undefined) continue;
    if (Array.isArray(r.opens)) opens.push(...r.opens);
    if (Array.isArray(r.closes)) closes.push(...r.closes);
    if (r.malformed === true) malformed++;
  }
  return { opens, closes, malformed };
}

/**
 * 沿工作面计算开集大小。
 *
 * `before.get(seq) === 0` → 该位置可作起点；
 * `after.get(seq) === 0`  → 该位置可作终点。
 *
 * @param {object} session - 目标会话。
 * @param {Map<string, object>} [registry] - trait 注册表。
 * @returns {{before: Map<number, number>, after: Map<number, number>, malformed: number}} 结果。
 */
export function openSetProfile(session, registry = GROUPINGS) {
  const before = new Map();
  const after = new Map();
  const open = new Set();
  let malformed = 0;
  for (const seq of session.surface.nodes) {
    before.set(seq, open.size);
    const event = session.eventAt(seq);
    if (event !== undefined) {
      const delta = relationsOf(event, registry);
      malformed += delta.malformed;
      for (const k of delta.opens) open.add(k);
      for (const k of delta.closes) open.delete(k);
    }
    after.set(seq, open.size);
  }
  return { before, after, malformed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 端点扩展 —— 「命中组合内任意一条 = 命中整个组合」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一个下标**滑到它所属组合的边界**。
 *
 * 实现只有一句话：**朝那一侧走到最近的开集归零处**。
 *
 * - `side === 'start'` → 向前滑到 `before === 0`
 * - `side === 'end'`   → 向后滑到 `after === 0`
 *
 * 因为「开集归零」是合法切口的**定义**，滑到的位置必然合法 —— 与具体是哪种组合无关。
 * 这比「识别工具块再找它的头尾」更稳：后者要为每种新型组合重写一遍。
 *
 * @param {number[]} nodes - 当前工作面的 seq 列表。
 * @param {object} profile - openSetProfile 的结果。
 * @param {number} index - 命中的下标。
 * @param {'start'|'end'} side - 哪一端。
 * @returns {number} 扩展后的下标。
 */
export function slideToGroupEdge(nodes, profile, index, side) {
  if (index < 0 || index >= nodes.length) return index;
  const clean = (i) => {
    const seq = nodes[i];
    return side === 'start'
      ? (profile.before.get(seq) ?? 0) === 0
      : (profile.after.get(seq) ?? 0) === 0;
  };
  if (clean(index)) return index;
  const step = side === 'start' ? -1 : 1;
  for (let i = index + step; i >= 0 && i < nodes.length; i += step) {
    if (clean(i)) return i;
  }
  // 滑不出去（理论上不该发生：整个工作面的开集必须闭合）
  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// 步骤单元 —— 「一步 = 一条助手消息 + 它的全部工具结果」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 行上的「步骤单元」划分：同一 (turn, step) 的节点属于同一步（助手消息与其工具结果）；
 * 没有 turn/step 的消息（user/cookie 等）各自成单元。
 *
 * PM 的最小操作单位是「一条消息」，而助手消息与它的工具结果由 API 约束绑死；
 * 因此合法投影的隐藏集合必须**整步闭合** —— 不允许只遮住一步里的部分节点。
 *
 * @param {object} view - { surface: { nodes }, eventAt }。
 * @returns {Map<number, string>} seq → 单元键。
 */
export function stepUnitsOf(view) {
  const units = new Map();
  let previousBase;
  let previousMember = false;
  let run = 0;
  for (const seq of view.surface.nodes) {
    const event = view.eventAt(seq);
    const turn = event?.data?.turn;
    const step = event?.data?.step;
    // 只有「助手消息 / 工具结果」按 (turn,step) 组步：它们才是一步的内容。
    // system/prompt、user/cookie、developer 等消息各自是独立的最小单位 ——
    // 尤其是 system prompt 虽然带 turn/step 元数据，但它不属于某一步的助手输出。
    const stepMember = event?.type === 'assistant/message' || event?.type === 'tool/result';
    if (!stepMember || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) {
      units.set(seq, 'node:' + String(seq));
      previousBase = undefined;
      previousMember = false;
      continue;
    }
    // 一步是**连续**的：同一 (turn,step) 的新一段（中间隔了别的消息）算新步骤单元。
    // 真实日志里 turn/step 单调唯一；这样分组也让手工构造的非真实日志保持可解释。
    const baseKey = String(turn) + ':' + String(step);
    if (!(previousMember && previousBase === baseKey)) run += 1;
    units.set(seq, 'step:' + baseKey + '#' + String(run));
    previousBase = baseKey;
    previousMember = true;
  }
  return units;
}

/**
 * 检查一组 seq 是否按步骤单元闭合（要么整步遮、要么整步不遮）。
 * @param {object} view - { surface: { nodes }, eventAt }。
 * @param {Array<number>} seqs - 被隐藏的 seq。
 * @returns {Array<{unit: string, inside: number, size: number}>} 违规列表（空 = 闭合）。
 */
export function closureViolations(view, seqs) {
  const units = stepUnitsOf(view);
  const members = new Map();
  for (const seq of view.surface.nodes) {
    const unit = units.get(seq);
    members.set(unit, (members.get(unit) ?? 0) + 1);
  }
  const inside = new Map();
  for (const seq of seqs) {
    const unit = units.get(seq);
    if (unit === undefined) continue;
    inside.set(unit, (inside.get(unit) ?? 0) + 1);
  }
  const violations = [];
  for (const [unit, count] of inside) {
    const size = members.get(unit) ?? 0;
    if (count !== size) violations.push({ unit, inside: count, size });
  }
  return violations;
}

/**
 * 生成给模型看的**组合边界说明**：哪些位置能作端点。
 *
 * 这是错误信息与 retrospect 输出共用的措辞，保证模型看到的说法一致。
 * @param {Map<string, object>} [registry] - trait 注册表。
 * @returns {string} 说明文本。
 */
export function describeGroupings(registry = GROUPINGS) {
  const names = [...registry.values()].map((t) => t.describe);
  return names.length === 0 ? '(no grouping types registered)' : names.join('; ');
}

void NL;