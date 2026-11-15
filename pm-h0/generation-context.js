/**
 * 世代上下文：会话日志 → 官方投影 → 该世代的真实上下文 → 可还原成轨迹的行。
 *
 * 这是「事实源链」的唯一实现：
 *
 *   会话日志（截断到世代边界）
 *     → 官方 SessionStore 重放（官方 surface fold）
 *     → 官方 surface.nodes（真实上下文的消息序列）
 *     → session.deriveEventMessage()（官方 deriveMessages 的逐节点形态）
 *     → rows（轨迹行：seq + 官方消息 + turn/step 元数据）
 *
 * 注意：这里**没有任何我们自己写的投影/去重/派生逻辑** —— 全部走官方代码。
 * 我们只做两件事：从完整日志里截出该世代的前缀；把官方给出的 (seq, message) 配上
 * 该事件自带的 turn/step，作为轨迹行的数据。
 *
 * 宿主侧的使用方式（下一步接 UI）：每个世代的 rows 可以直接交给「世代轨迹」渲染；
 * 最新世代直接用 live session（无需影子会话）。
 *
 * 本模块零 import：宿主进程里运行，profile 的 node_modules 解析不到 @deepseek-ai 包；
 * SessionStore 由调用方从 ctx.sessions 传入。
 *
 * @module dsh-plugin-plastic-memories-h0/generation-context
 */

/**
 * 用官方投影重放日志前缀，得到某个世代的真实上下文（逐节点）。
 * @param {object} store - ctx.sessions（官方 SessionStore）。
 * @param {Array<object>} events - 该会话的完整日志（seq 连续）。
 * @param {{asOfSeq: number, gen: number}} generation - 世代边界（含）。
 * @param {string} [idPrefix] - 影子会话 id 前缀（避免多代之间重名）。
 * @returns {{generation: number, rows: Array<object>}} 官方投影结果 + 轨迹行。
 */
export function generationRows(store, events, generation, idPrefix = 'pm-generation-shadow') {
  const seed = events.filter((event) => event.seq <= generation.asOfSeq);
  const shadow = store.create(idPrefix + '-' + String(generation.gen), { seed });
  const nodes = [...shadow.surface.nodes];
  const rows = [];
  for (const seq of nodes) {
    const event = shadow.eventAt(seq);
    if (event === undefined) continue;
    const message = shadow.deriveEventMessage(event);
    rows.push({
      seq,
      eventType: event.type,
      // 官方日志里 assistant/tool/result 事件自带 turn/step；user/cookie 没有，保持 undefined。
      ...(Number.isSafeInteger(event.data?.turn) ? { turn: event.data.turn } : {}),
      ...(Number.isSafeInteger(event.data?.step) ? { step: event.data.step } : {}),
      message,
    });
  }
  return { generation: shadow.surface.replaceGeneration, rows };
}

/**
 * 最新世代直接取 live session（官方当前 surface + 官方派生消息），不需要影子会话。
 * @param {object} session - 官方 Session 实例。
 * @returns {{generation: number, rows: Array<object>}} 官方当前上下文 + 轨迹行。
 */
export function liveGenerationRows(session) {
  const nodes = [...session.surface.nodes];
  const rows = [];
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    rows.push({
      seq,
      eventType: event.type,
      ...(Number.isSafeInteger(event.data?.turn) ? { turn: event.data.turn } : {}),
      ...(Number.isSafeInteger(event.data?.step) ? { step: event.data.step } : {}),
      message,
    });
  }
  return { generation: session.surface.replaceGeneration, rows };
}
