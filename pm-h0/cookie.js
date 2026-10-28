/**
 * PM · cookie —— 自动插入的**内容无关**锚点。
 *
 * ## 为什么需要它（实测证据）
 *
 * 模型定位历史的手段本来只有两种，而两种都会失灵：
 *
 * 1. **关键字匹配** —— 会被模型**自己的推理消息**污染。
 *    实测（session-e2f42183）：模型连续 7 次关键字匹配全部失败，原因全是
 *    「同时匹配到 2-4 条」—— 因为它每次失败后都在推理里**复述那些关键词**，
 *    错误信息里也回显了一遍。模型自己都诊断出来了：
 *    「My own thinking messages keep echoing the keywords.」
 *
 * 2. **偏移量** —— 日志仅追加，负偏移其实是**精确**的，
 *    但模型**数不准**（跨度一大就差一条），而且模型看不见消息边界。
 *
 * 更底层的事实：**模型根本没有「消息」这个概念** ——
 * 请求体会被重新序列化成 token 流，相邻同角色的消息在序列化时**还会被合并**。
 * 实测：会话里 4 条独立 user 消息（user / runtime-context / time-context / cookie）
 * 到模型那里只剩 **1 条**，含 4 个 text 块。
 *
 * 所以需要一个**可见的、内容无关的坐标系** —— 那就是 cookie。
 *
 * ## 自动插入（模型不需要主动调用）
 *
 * 只在提交边界上**顺便**插入：**边界队尾永远保持一个 cookie**。
 * 这一条覆盖工具块结束后 / 用户主动发送的消息后 / turn 末（下一轮用户消息之前）。
 *
 * ## 编号：无状态，且**跨世代唯一**
 *
 * **ID = 日志里最后一条 cookie 的 ID + 1；一条没有则 1。**
 * 扫**全量日志**而不是工作面 —— 被投影遮蔽的 cookie 仍占着它的编号，
 * 否则新 ID 会与它重复。自增**跨世代**进行，唯一目的是保证不重复。
 *
 * ## 身份来自元数据，不来自文本
 *
 * 一条事件**只有**同时满足「type = user/message」与「source.kind = pm-cookie」才算 cookie。
 * 文本（`[Plastic-Memories][cookie][N]`）只用于**容错反解**：万一 source.id 丢了，
 * 才从正文里读编号。
 *
 * 这条边界很重要：在开发 PM 的会话里，这个样式本身会被反复引用
 * （模型回复、代码片段、文档）。若按文本找 cookie，那些引用会被误认成锚点。
 * 现在它们一个都不会 —— 身份来自 source.kind，而助手消息永远不带这个 kind，
 * 普通用户消息也不会（不带标记）。
 *
 * ## 解析：按 ID，不按「第几个可见 cookie」
 *
 * ID 写在消息的 `source.id` 与正文里。模型看见的是**正文里的编号**，
 * 所以解析必须认这个 ID —— 若按「可见 cookie 的第 N 个」数，
 * 一旦某个 cookie 被投影遮蔽，后面所有编号都会错位（贴错位置比找不到更糟）。
 *
 * ## 载体：user/message
 *
 * 与时间快照同构。不用 developer/message：它走 system 通道，
 * 有「flush 时前一条必须是 user 轮」的硬约束，兼容性差。
 *
 * @module dsh-plugin-plastic-memories-h0/cookie
 */

/** cookie 消息的 source.kind —— **身份只由它决定**。 */
export const COOKIE_KIND = 'pm-cookie';

/** cookie 文本的固定前缀（人类可读；不承担防碰撞职责）。 */
export const COOKIE_PREFIX = '[Plastic-Memories][cookie]';

/**
 * 生成第 n 号 cookie 的文本。
 * @param {number} n - 编号。
 * @returns {string} 文本，形如 `[Plastic-Memories][cookie][7]`。
 */
export function cookieText(n) {
  return COOKIE_PREFIX + '[' + n + ']';
}

/** cookie 文本的正则（**只**用于容错反解，不用于识别身份）。
 *
 * **整行锚定**：cookie 消息的正文就是这一行。夹在别的文本里的同样字样
 * 不应该被反解成一个编号 —— 那会让「引用这个样式」变成「制造一个锚点」。
 */
const COOKIE_RE = /^\s*\[Plastic-Memories\]\[cookie\]\[(\d+)\]\s*$/;

/**
 * 从一条消息的文本里解出 cookie 编号。
 * @param {string} text - 消息文本。
 * @returns {number|undefined} 编号；不是 cookie 时 undefined。
 */
export function parseCookieText(text) {
  const m = COOKIE_RE.exec(String(text));
  return m === null ? undefined : Number(m[1]);
}

/**
 * 这条事件是不是 cookie 消息。
 *
 * **只认用户消息 + 元数据标记**：正文里出现同样的文字不算。
 * @param {object} event - 会话事件。
 * @returns {boolean} 结果。
 */
export function isCookie(event) {
  if (event?.type !== 'user/message' && event?.type !== 'developer/message') return false;
  const message = event.type === 'developer/message' ? event.data?.message : event.data;
  return message?.source?.kind === COOKIE_KIND;
}

/**
 * 取一条 cookie 事件的编号。
 *
 * 优先读 `source.id`（写入时就在那里，最可靠）；缺失时从正文反解 ——
 * 后者让**旧日志 / 手工造的事件**也能被正确解析。
 * @param {object} event - 会话事件。
 * @returns {number|undefined} 编号。
 */
export function cookieIdOf(event) {
  if (!isCookie(event)) return undefined;
  const message = event.type === 'developer/message' ? event.data?.message : event.data;
  const src = message?.source;
  if (typeof src.id === 'number' && Number.isSafeInteger(src.id) && src.id > 0) return src.id;
  const blocks = message?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (typeof block?.text === 'string') {
        const parsed = parseCookieText(block.text);
        if (parsed !== undefined) return parsed;
      }
    }
  }
  return undefined;
}

/**
 * 找出日志里全部 cookie（按日志顺序）。
 *
 * **扫全量日志**：被投影遮蔽的 cookie 仍然占着它的编号。
 * @param {object} session - 目标会话。
 * @returns {Array<{id: (number|undefined), seq: number, text: string}>} 结果。
 */
export function listCookies(session) {
  const out = [];
  for (const event of session.snapshotEvents()) {
    const id = cookieIdOf(event);
    if (id === undefined) continue;
    out.push({ id, seq: event.seq, text: cookieText(id) });
  }
  return out;
}

/**
 * 下一个 cookie 的编号：日志里最大的 ID + 1；一条都没有则 1。
 *
 * 用 max 而不是「最后一条的 ID」：两者在本插件的自增规则下等价，
 * 但日志可能被手工造过（测试 / 导入），max 永远保证不重复。
 * @param {object} session - 目标会话。
 * @returns {number} 下一个编号。
 */
export function nextCookieId(session) {
  const all = listCookies(session);
  let max = 0;
  for (const cookie of all) if (typeof cookie.id === 'number' && cookie.id > max) max = cookie.id;
  return max + 1;
}

/**
 * 把一个 cookie 编号解析成它在**当前工作面**里的位置。
 *
 * **按 ID 解析** —— 不是「第几个可见 cookie」。
 * 理由：模型看到的是编号本身，编号不随投影漂移；
 * 若数可见个数，一旦某个 cookie 被遮蔽，后面的编号就会整体错位。
 *
 * @param {object} view - 只读视图（含 surface / eventAt）。
 * @param {number} id - cookie 编号（1 起）。
 * @returns {{index: number, seq: number}|undefined} 位置；不在工作面上时 undefined。
 */
export function cookieIndex(view, id) {
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  const nodes = view.surface.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const event = view.eventAt(nodes[i]);
    if (cookieIdOf(event) === id) return { index: i, seq: nodes[i] };
  }
  return undefined;
}

/**
 * 当前工作面上可见的最大 cookie 编号（错误信息用）。
 * @param {object} view - 只读视图。
 * @returns {number} 最大编号；没有 cookie 时 0。
 */
export function maxVisibleCookieId(view) {
  let max = 0;
  for (const seq of view.surface.nodes) {
    const id = cookieIdOf(view.eventAt(seq));
    if (id !== undefined && id > max) max = id;
  }
  return max;
}

/**
 * 构造一条 cookie 消息（与 appendCookies 写进日志的形态一致）。
 *
 * 它既是「锚点」，也是一条**模型可见的 user 消息** —— 所以可以在
 * `agent/pre-step` 的 decision.messages 里提前插入，和用户消息同批落盘。
 * @param {number} id - cookie 编号（1 起）。
 * @returns {object} user/message 的消息体。
 */
export function cookieMessage(id, role = 'user') {
  return {
    id: 'pm-cookie-' + String(id),
    role,
    content: [{ type: 'text', text: cookieText(id) }],
    source: { kind: COOKIE_KIND, v: 1, id },
  };
}

/**
 * 给**用户主动发送**的消息前后各加一条 cookie。
 *
 * 为什么在 pre-step 做：日志只能追加，消息一旦落盘就没法在它前面插东西；
 * 而 `agent/pre-step` 的 decision.messages 正是「还没落盘、即将按序追加」的那批消息。
 * 在这里把 cookie 摆进队列，落盘顺序就是
 *
 *     [cookie N] 用户消息 [cookie N+1] 时间快照(runtime-context) 助手…
 *
 * 模型因此能在一串连续 token 里区分：
 * - 被两条 cookie 夹住的 = 用户亲口说的；
 * - 没被夹住的 user 消息 = 系统注入的（时间快照 / 队列消息）。
 *
 * 左端点不是无脑加：如果当前工作面队尾**已经是 cookie**（上一个边界补的），
 * 就直接复用它，避免出现「两条 cookie 连在一起」。
 *
 * @param {object} session - 目标会话。
 * @param {Array<object>} messages - pre-step 即将落盘的消息。
 * @returns {Array<object>|undefined} 插好 cookie 的新数组；没有用户消息时 undefined。
 */
export function bracketUserMessages(session, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  let hasUser = false;
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && message.source?.kind === 'user') {
      hasUser = true;
      break;
    }
  }
  if (!hasUser) return undefined;
  const nodes = session.surface.nodes;
  const tail = nodes[nodes.length - 1];
  // 队尾已经是 cookie → 左端点复用它（不要制造连续两条 cookie）。
  let lastWasCookie = tail !== undefined && isCookie(session.eventAt(tail));
  let next = nextCookieId(session);
  const out = [];
  for (const message of messages) {
    const human = message !== null && typeof message === 'object' && message.source?.kind === 'user';
    if (!human) {
      out.push(message);
      lastWasCookie = false;
      continue;
    }
    if (!lastWasCookie) out.push(cookieMessage(next++));
    out.push(message);
    out.push(cookieMessage(next++));
    lastWasCookie = true;
  }
  return out;
}

/**
 * 算出这个提交边界**应当补插**哪些 cookie。
 *
 * 规则只有一条：**边界队尾永远保持一个 cookie。**
 *
 * 队尾不是 cookie 就补一个；已经是就什么都不做。
 *
 * 这一条覆盖了全部需要锚点的位置：
 *
 * - 工具块结束后 —— 边界一到，队尾就是那个结果 → 补一个
 * - 用户主动发送的消息后 —— 同上
 * - **最后一条 assistant 与下一条 user 之间** —— turn 末的边界补一个，
 *   下一轮用户消息落盘时它自然就在前面（日志仅追加，「前面」只能提前埋）
 *
 * **cookie 不标记任何东西。** 它就是流里的一个可见锚点，
 * 编号的含义是「这段文字在流里的位置」。模型只看得见 token 流，
 * 看不见任何元数据 —— 所以插件也不该在元数据里存语义。
 *
 * @param {object} session - 目标会话。
 * @returns {{seq: number}|undefined} 需要补插时返回队尾；否则 undefined。
 */
export function planCookie(session) {
  const nodes = session.surface.nodes;
  const tail = nodes[nodes.length - 1];
  if (tail === undefined) return undefined;
  if (isCookie(session.eventAt(tail))) return undefined;   // 队尾已经是 cookie
  return { seq: tail };
}
