/**
 * PM · 提交边界上的投影写入。
 *
 * ## 唯一职责
 *
 * 扫日志里**待办的 plasticize(execute) 声明**，在提交边界上把它们写成 surfaceOp。
 *
 * ## 为什么是边界，不是工具执行期
 *
 * this（本步整组）的语义是「到这一步彻底结束为止」—— 包含承载调用的 assistant 消息
 * **以及它的全部工具结果**。工具在自己的 execute 里运行时，它自己的 tool/result 还没落地，
 * 「本步整组」的后边界此刻不存在。当场写会把调用消息替换掉，随后落地的结果变成孤儿，
 * 读侧以 does not match an open turn and step 拒绝整份日志（已实测）。
 *
 * 不含 this 的范围只是「后边界已知」的特例 —— 走同一条路，不另开分支。
 *
 * ## 自动隐藏（用户要求）
 *
 * execute **成功时**，为新世代顺手隐藏两类噪音：
 *
 *   1. 报错的 PM 工具步骤组（失败调用只会污染下一个世代）
 *   2. 成功的 plasticize(set) 步骤组（预览已经兑现，留着只会让模型以为还没执行）
 *
 * 两条都只动**纯 PM 步骤组**（那一步里除了 PM 调用没有别的工具），
 * 绝不会连带藏掉同一步里别的工具的成果。
 *
 * @module dsh-plugin-plastic-memories-h0/engine
 */

import { initState, applyEvent } from './generations.js';
import { pmSettledCallIds, pmSource } from './markers.js';
import { previewOf, resolveOps } from './plasticize.js';
import {
  SURFACE_TYPES,
  callIdOf,
  checkBalanced,
  derivedMessage,
  indexOfCall,
  parseCallArgs,
  resultCallIdOf,
  splitCallId,
  stepGroup,
  surfaceNodes,
} from './coords.js';

/** 会产生新世代的工具名。目前只有一个。 */
export const PM_TOOL = 'plasticize';

/** 被认为是「PM 自己」的工具名集合（自动隐藏只动这些调用组成的步骤组）。 */
const PM_TOOLS = new Set([PM_TOOL]);

// 插件私有记录：DSH 允许 ignorable plugin record（plugin:<name>/<kind>），
// 它是给插件存私有数据的官方扩展点；不进入 surface/上下文。
let pluginRecordAppender;
let injectedPluginRecordAppender;

/** 测试/宿主注入 appendPluginRecord（避免裸包名解析问题）。 */
export function installPrivateRecordAppender(append) {
  injectedPluginRecordAppender = append;
}
function appendPluginRecordLazy() {
  if (pluginRecordAppender === undefined) {
    pluginRecordAppender = import('@deepseek-ai/dsh-session')
      .then((module) => (typeof module.appendPluginRecord === 'function' ? module.appendPluginRecord : null))
      .catch(() => null);
  }
  return pluginRecordAppender;
}
// ─────────────────────────────────────────────────────────────────────────────
// 每会话派生缓存（不是事实源；重启后由日志重扫重建）
// ─────────────────────────────────────────────────────────────────────────────

/** @type {WeakMap<object, object>} */
const STATES = new WeakMap();

/**
 * 取（必要时建）一个会话的派生缓存。
 * @param {object} session - 目标会话。
 * @returns {object} 缓存。
 */
function stateOf(session) {
  let state = STATES.get(session);
  if (state === undefined) {
    state = {
      scannedThrough: 0,
      declarations: [],
      /** 已落地的投影 callId（幂等键）；随日志增量重建，不另存状态。 */
      appliedCallIds: new Set(),
      /** 工具执行**报错**的 callId —— 这类声明永远不落地（失败不该产生投影）。 */
      failedCallIds: new Set(),
      warned: new Set(),
      shapeIssues: new Set(),
    };
    STATES.set(session, state);
  }
  return state;
}

/** 报告一次形态异常（绝不静默）。 */
function warnShapeOnce(state, issue, logger) {
  const key = 'shape:' + issue;
  if (state.warned.has(key)) return;
  state.warned.add(key);
  logger?.warn?.('[pm-h0] 消息形态异常（投影可能静默失效）：' + issue);
}

/**
 * 增量扫描日志，收集 plasticize 声明（native 与 PTC 两种呈现都认）。
 *
 * - native：assistant/message 里的 tool-call 块
 * - PTC  ：tool/ptc-dispatch-start 事件（模型通过 run_code 调用，日志里没有 tool-call 块）
 *
 * @param {object} session - 目标会话。
 * @param {object} state - 派生缓存。
 */
function scanNew(session, state) {
  const from = state.scannedThrough;
  const now = session.seq;
  if (from >= now) return;
  for (const event of session.snapshotEvents(from)) {
    // 投影痕迹（幂等键）：PM 自己写下的节点都带 source.kind = 'pm-surface'。
    // user/message 的 source 在 data.source；developer/message 与 tool/result 在 data.message.source。
    const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source;
    // 一条投影可能同时了结多条声明（set + execute 解析出同一区间时只写一条事件）：
    // 标记里的 consumed 也要记为已落地，否则 execute 会在下个边界被重复执行。
    for (const settled of pmSettledCallIds(source)) state.appliedCallIds.add(settled);

    // 工具执行失败的痕迹：native 看 tool/result.isError，PTC 看内层 tool/ptc-dispatch.isError。
    // **失败的调用永远不落地** —— 模型已经收到错误，投影不该悄悄生效（实测踩过：
    // 工具回错误、下一次边界却把投影写进去了，模型会以为失败并重试，结果重复投影）。
    if (event.type === 'tool/result' && event.data?.message?.isError === true) {
      const callId = resultCallIdOf(event.data.message);
      if (typeof callId === 'string') state.failedCallIds.add(callId);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.isError === true) {
      const callId = event.data?.subCallId;
      if (typeof callId === 'string') state.failedCallIds.add(callId);
    }

    if (event.type === 'assistant/message') {
      const content = event.data.message.content;
      if (!Array.isArray(content)) continue;
      for (const call of content) {
        if (call === null || typeof call !== 'object' || call.type !== 'tool-call') continue;
        if (call.name !== PM_TOOL) continue;
        const callId = callIdOf(call);
        if (callId === undefined) {
          state.shapeIssues.add('tool-call 块既没有 callId 也没有 id（keys: ' + Object.keys(call).join(',') + '）');
          continue;
        }
        state.declarations.push({
          callId,
          ownerCallId: callId,
          args: parseCallArgs(call.arguments),
          via: 'native',
          seq: event.seq,
        });
      }
    } else if (event.type === 'tool/ptc-dispatch-start') {
      if (event.data?.name !== PM_TOOL) continue;
      const callId = event.data?.subCallId;
      if (typeof callId !== 'string' || callId.length === 0) {
        state.shapeIssues.add('tool/ptc-dispatch-start 没有 subCallId');
        continue;
      }
      state.declarations.push({
        callId,
        ownerCallId: typeof event.data?.rootCallId === 'string' ? event.data.rootCallId : callId,
        args: event.data?.arguments ?? {},
        via: 'ptc',
        seq: event.seq,
      });
    }
  }
  state.scannedThrough = now;
}

/**
 * 判断一条声明是否已经**了结**（已落地，或执行报错）。
 *
 * 报错的也算「了结」：它不产生投影，也不该在后续每个边界上重试。
 * @param {object} state - 派生缓存。
 * @param {object} declaration - 一条声明。
 * @returns {boolean} 是否已了结。
 */
function isDone(state, declaration) {
  return state.appliedCallIds.has(declaration.callId) || state.failedCallIds.has(declaration.callId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 自动隐藏：只动「纯 PM 步骤组」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这一步是不是**纯 PM** 步骤（除了 PM 调用没有别的工具）。
 *
 * 为什么必须纯：自动隐藏是为 PM 自己的噪音服务的。若那一步里还夹着 bash / write
 * 之类的工作成果，连带隐藏会**直接毁掉模型的工作** —— 宁可留着噪音。
 *
 * @param {object} session - 目标会话。
 * @param {object} declaration - 声明。
 * @param {number[]} seqs - 步骤组的事件 seq。
 * @returns {boolean} 是否纯 PM。
 */
function stepIsPurePm(session, declaration, seqs) {
  if (declaration.via === 'ptc') {
    const dispatches = [];
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'tool/ptc-dispatch-start') continue;
      if (event.data?.rootCallId !== declaration.ownerCallId) continue;
      dispatches.push(String(event.data?.name));
    }
    return dispatches.length > 0 && dispatches.every((name) => PM_TOOLS.has(name));
  }
  const head = session.eventAt(seqs[0]);
  const content = head?.type === 'assistant/message' ? head.data?.message?.content : undefined;
  if (!Array.isArray(content)) return false;
  const calls = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call');
  return calls.length > 0 && calls.every((call) => PM_TOOLS.has(String(call.name)));
}

/**
 * 这一步的 PM 调用有没有报错。
 *
 * native 看组内的 tool/result；PTC 看组内的 tool/ptc-dispatch（内层调用的成败在那里）。
 *
 * @param {object} session - 目标会话。
 * @param {object} declaration - 声明。
 * @param {number[]} seqs - 步骤组的事件 seq。
 * @returns {boolean} 是否报错。
 */
function stepHasError(session, declaration, seqs) {
  if (declaration.via === 'ptc') {
    for (const event of session.snapshotEvents(declaration.seq, seqs[seqs.length - 1] + 1)) {
      if (event.type !== 'tool/ptc-dispatch') continue;
      if (event.data?.subCallId !== declaration.callId) continue;
      if (event.data?.isError === true) return true;
    }
    return false;
  }
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result') continue;
    if (resultCallIdOf(event.data?.message) !== declaration.callId) continue;
    if (event.data?.message?.isError === true) return true;
  }
  return false;
}

/**
 * 收集本轮**应当自动隐藏**的步骤组。
 *
 * 规则（用户定的）：**只在 execute 成功时一起清理** ——
 *   - 成功的 plasticize(set) 步骤组（预览已兑现，留着会让模型以为还没执行）
 *   - 报错的 PM 步骤组（失败调用是纯噪音）
 *
 * 两者都只清理**排在最近一次成功 execute 之前**的（`seq <= settledBefore`）：
 * 之后新出现的噪音 —— 新 set 的预览、新的失败调用 —— 要等**下一次**成功 execute。
 * 真实事故：没有这道先后判断时，测试 3 里全程只有 set、没有 execute，
 * 预览却在下一个边界被当成「已兑现」吞掉 → 模型看不到预览 → 反复重发 set。
 *
 * 约束：全部节点必须仍在工作面上、不与本批显式区间重叠、且那一步是纯 PM 步骤。
 *
 * @param {object} session - 目标会话。
 * @param {object} state - 派生缓存。
 * @param {Set<number>} claimed - 本批显式区间已遮蔽的 seq（会被就地扩展）。
 * @param {number} settledBefore - **成功 execute 的最晚 seq**。
 *   只有排在这之前的 set 才算「已兑现」；更晚的 set 是**当前待决的预览**，必须留在上下文里
 *   （真实事故：预览被自动隐藏吞掉，模型看不到预览 → 反复重发 set，卡死在第三步）。
 * @returns {Array<{shadowed: number[], reason: string, callId: string}>} 目标。
 */
function autoHideTargets(session, state, claimed, settledBefore, locks) {
  const nodes = surfaceNodes(session);
  const visible = new Set(nodes);
  const out = [];
  const seen = new Set();
  for (const declaration of state.declarations) {
    const option = declaration.args?.option;
    if (option !== 'set' && option !== 'execute') continue;
    const group = stepGroup(session, declaration.ownerCallId);
    if (group === undefined || group.complete !== true) continue;
    const seqs = nodes.slice(group.startIndex, group.endIndex + 1);
    if (seqs.length === 0) continue;
    const key = seqs.join(',');
    if (seen.has(key)) continue;
    if (!seqs.every((seq) => visible.has(seq))) continue;
    if (locks !== undefined && locks.size > 0 && seqs.some((seq) => locks.has(seq))) continue;
    if (seqs.some((seq) => claimed.has(seq))) continue;
    if (!stepIsPurePm(session, declaration, seqs)) continue;
    const errored = stepHasError(session, declaration, seqs);
    // **只在 execute 成功时一起清理**：比最近一次成功 execute 更晚的东西一律不动。
    if (declaration.seq > settledBefore) continue;
    // 剩下的：成功的 set（已兑现）与报错的步骤组（纯噪音）。
    if (!errored && option !== 'set') continue;
    seen.add(key);
    out.push({ shadowed: seqs, reason: errored ? 'error' : 'set', callId: declaration.callId });
    for (const seq of seqs) claimed.add(seq);
  }
  return out;
}

/**
 * 把一批声明写成 surfaceOp。
 *
 * **所有区间必须针对同一个冻结的工作面解析，然后才写入。**
 *
 * 为什么：模型发出多条声明时，看到的是**同一个**工作面状态（set 不写工作面），
 * 所以它们的偏移量都针对那一刻。若边解析边写，第二条就会按**已收缩**的工作面理解，
 * 偏移错位（实测：-13..-10 从 #1..#4 漂到 #3..#6，最后落到 #0 system 被拒）。
 *
 * @param {object} session - 目标会话。
 * @param {Array<object>} declarations - 本批声明（日志顺序）。
 * @param {object|undefined} open - 当前打开的 step。
 * @param {object} state - 派生缓存。
 * @param {{autoHide?: boolean}} [options] - 开关。
 * @returns {{explicit: number, auto: number, applied: number, failed: Array<object>}} 结果。
 */
/**
 * 安全区（/lock、/unlock）—— 纯函数：只从会话日志回放，不保存任何内存状态。
 *
 * 私有事件追加在日志里，永不修改；按出现顺序叠加：
 *   - mode:'range'：携带命令执行时解析出的 seq 列表；
 *   - mode:'all'：该事件之前、当前世代工作面上的全部节点；
 *   - mode:'this'：该事件之后的下一条 user 消息（正文随记录一起保存，用于对齐）。
 * 后来的事件不覆盖前面的，只是继续 add / delete。
 *
 * @param {object} session - 目标会话。
 * @returns {Set<number>} 当前安全区内的消息 seq。
 */
export function lockedSeqs(session) {
  const events = session.snapshotEvents();
  const locks = new Set();
  let state = initState();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (typeof event.type !== 'string' || !event.type.startsWith('plugin:plastic-memories/locks')) {
      state = applyEvent(state, event);
      continue;
    }
    const data = event.data ?? {};
    const legacy = Array.isArray(data.add) ? data.add : !data.op && Array.isArray(data.locks) ? data.locks : undefined;
    let seqs = [];
    let op = 'lock';
    if (legacy !== undefined) {
      seqs = legacy;
    } else {
      op = data.op === 'unlock' ? 'unlock' : 'lock';
      if (data.mode === 'range') seqs = Array.isArray(data.seqs) ? data.seqs : [];
      else if (data.mode === 'all') seqs = [...state.seqs];
      else if (data.mode === 'this') {
        const body = typeof data.body === 'string' ? data.body : undefined;
        for (let next = index + 1; next < events.length; next += 1) {
          const candidate = events[next];
          if (candidate.type !== 'user/message' || candidate.data?.source?.kind !== 'user') continue;
          if (body !== undefined) {
            const raw = (candidate.data?.content ?? []).map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
            if (raw !== body) continue;
          }
          if (Number.isSafeInteger(candidate.seq)) seqs = [candidate.seq];
          break;
        }
      }
    }
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq)) continue;
      if (op === 'unlock') locks.delete(seq); else locks.add(seq);
    }
  }
  return locks;
}

/** 解析一个区间为当前工作面上的 seq（不写状态）。 */
export function resolveLockSeqs(session, interval) {
  const resolved = resolveOps(session, [{ spans: [interval], new_text: 'lock' }], undefined);
  return resolved.flatMap((span) => span.shadowed);
}

/** 追加一条安全区私有事件（append-only；官方 plugin record）。 */
export async function appendSafetyRecord(session, payload) {
  const append = await appendPluginRecordLazy();
  if (typeof append !== 'function') throw new Error('当前宿主不支持 plugin record，无法持久化安全区');
  append(session, 'plugin:plastic-memories/locks', payload);
}

/** 检查一组 seq 是否命中安全区。 */
/** 当前全部安全区的提示（可能过时；只用于诊断）。 */
function safetyZoneNote(locks) {
  if (locks === undefined || locks.size === 0) return '';
  const seqs = [...locks].sort((left, right) => left - right);
  const shown = seqs.slice(0, 40).join(',');
  return ' 当前安全区（易过时；后续操作可能改变它）：共 ' + String(seqs.length) + ' 条消息，seq ' + shown + (seqs.length > 40 ? '…' : '') + '。';
}

function assertNotLocked(locks, shadowed) {
  if (locks === undefined || locks.size === 0) return;
  const hit = shadowed.filter((seq) => locks.has(seq));
  if (hit.length > 0) {
    throw new Error('区间命中安全区（/lock）：seq ' + hit.slice(0, 8).join(',') + (hit.length > 8 ? '…' : '') + '；请先 /unlock 或换一个区间。' + safetyZoneNote(locks));
  }
}
function applyDeclarations(session, declarations, open, state, options = {}) {
  const nodes = surfaceNodes(session);
  const locks = lockedSeqs(session);
  const hereOf = (group) => ({ thisSeq: nodes[group.startIndex], thisEndSeq: nodes[group.endIndex] });

  // **零点 = 写下这条 ops 的那条 plasticize。**
  //
  // 模型在 set 时看着某个工作面写下偏移量；execute 时它会重传**同一条 ops**。
  // 那份偏移量的零点属于 set 那条消息 —— 若按 execute 自己的消息算，
  // 两条消息之间隔着的节点会让区间漂移（实测：-13..-10 从 #1..#4 漂到 #3..#6，
  // 于是「看过的预览」和「真正落实的东西」不是同一个）。
  //
  // 所以 execute 带 also_execute_last_set 时，它自己的 ops 也按 set 的零点解析。
  // **每条声明独立解析**：一条写错的声明（例如引用了不存在的 cookie）只应当自己失败，
  // 不能把同一批里其它正确的声明一起拖死 —— 否则一次手滑会让这个会话后面的
  // plasticize 全部失效（待办永远清不掉）。实测过：这正是「半绿」之外最容易忽略的死法。
  const planned = [];
  const failed = [];
  for (const declaration of declarations) {
    try {
      const ops = declaration.args?.ops;
      if (ops !== undefined && (!Array.isArray(ops) || ops.length === 0) && declaration.opsFrom !== 'set') {
        // 空 ops 是合法的：execute 只消费 set 时自身不带段落
      } else if (ops !== undefined && !Array.isArray(ops)) {
        throw new Error('ops 必须是数组');
      }
      if (ops !== undefined && Array.isArray(ops) && ops.length === 0) {
        planned.push({ declaration, resolved: [], group: undefined });
        continue;
      }
      const group = stepGroup(session, declaration.ownerCallId);
      if (group === undefined) throw new Error('找不到承载这条声明的消息');
      if (!group.complete) throw new Error('本步的工具结果还没全部落地，等下一个边界');
      // 用 set 的零点（若这条 execute 声明了 also_execute_last_set 且 set 在批里）
      let anchor = hereOf(group);
      if (declaration.opsAnchorCallId !== undefined) {
        const anchorGroup = stepGroup(session, declaration.opsAnchorCallId);
        if (anchorGroup !== undefined && anchorGroup.complete) anchor = hereOf(anchorGroup);
      }
      const resolved = ops === undefined ? [] : resolveOps(session, ops, anchor);
      for (const span of resolved) assertNotLocked(locks, span.shadowed);
      planned.push({ declaration, resolved, group });
    } catch (error) {
      failed.push({ declaration, error });
    }
  }

  // **同一批声明之间不得重叠**：它们的区间都针对同一个冻结的工作面解析，
  // 重叠意味着第二条要遮蔽的节点已被第一条吞掉 —— 写下去必然失败。
  // 与其报一句 start seq N not found in surface（模型看不出是自己的两条声明撞车），
  // 不如在这里点名说清楚。
  // 同一条 ops 被 set 与 execute 各解析一次时，两者区间**完全相同**（同一零点）——
  // 这是「看了预览再落实」的正常路径，只应用一次即可，不是错误。
  // 只有**部分**重叠（区间不同又相交）才是模型算错了，必须点名报出来。
  const signature = (spans) => spans.map((sp) => sp.shadowed.join()).join();
  const bySignature = new Map();
  for (let i = 0; i < planned.length; i++) {
    const sig = signature(planned[i].resolved);
    if (sig.length === 0) continue;
    const seen = bySignature.get(sig);
    if (seen !== undefined) { planned[i].duplicateOf = seen; continue; }
    bySignature.set(sig, i);
  }
  const claimed = new Set();
  for (let i = 0; i < planned.length; i++) {
    if (planned[i].duplicateOf !== undefined) continue;
    for (const span of planned[i].resolved) {
      for (const seq of span.shadowed) {
        if (claimed.has(seq)) {
          throw new Error(
            '本批声明之间区间重叠：有两条声明都想遮蔽同一段历史。' +
            '每条声明以自己的承载消息为原点，所以隔了一步的两条声明即便写同样的偏移量，' +
            '也会落到不同位置 —— 请分别换算各自的偏移，或合并成一条声明。',
          );
        }
        claimed.add(seq);
      }
    }
  }

  // 自动隐藏的目标也要先算好（与显式区间同一张冻结工作面）。
  // **只有真的有 execute 成功落地时**才动手：失败的调用不该反过来触发清理。
  // settledBefore = 已落地的 execute 与本批**解析成功**的 execute 的最晚 seq；
  // 排在它之后的 set 是待决预览，不隐藏（否则模型看不到自己刚拿到的预览）。
  const executedPlannedSeqs = planned
    .map((entry) => entry.declaration)
    .filter((declaration) => declaration.args?.option === 'execute')
    .map((declaration) => declaration.seq);
  const settledBefore = Math.max(
    options.appliedExecuteSeq ?? -1,
    ...(executedPlannedSeqs.length > 0 ? executedPlannedSeqs : [-1]),
  );
  // 逻辑世代号：已落地的 execute 数 + 本批 execute 的顺序。
  const appliedExecutes = countLogicalGenerations(session);
  let batchExecute = 0;
  const logicalOf = new Map();
  for (const entry of planned) {
    if (entry.declaration.args?.option !== 'execute') continue;
    batchExecute += 1;
    logicalOf.set(entry.declaration.callId, appliedExecutes + batchExecute - 1);
  }
  const batchLogical = appliedExecutes + batchExecute - 1;
  const autoTargets = options.autoHide === true && (planned.length > 0 || options.appliedBefore === true)
    ? autoHideTargets(session, state, claimed, settledBefore, locks)
    : [];

  // 全部解析完再写：上面所有 resolveOps 都针对同一个（尚未改变）的工作面。
  let explicit = 0;
  for (let i = 0; i < planned.length; i++) {
    const { declaration, resolved, duplicateOf } = planned[i];
    if (duplicateOf !== undefined) continue;
    // set 与 execute 解析出同一区间时只写一条事件；但**那条事件必须同时了结两条声明**，
    // 否则 execute 会在下个边界被重新执行一遍（实测：PTC 下会多出一次投影）。
    const consumed = planned
      .filter((entry, j) => j !== i && entry.duplicateOf === i)
      .map((entry) => entry.declaration.callId);
    const generation = session.surface.replaceGeneration + 1;
    for (let k = 0; k < resolved.length; k++) {
      const span = resolved[k];
      const rawText = String(span.op.new_text ?? '');
      const isHole = rawText.length === 0;
      if (isHole && open === undefined) throw new Error('没有打开的 step，纯空洞推迟到下一个边界');
      const consumedLogical = consumed.map((id) => logicalOf.get(id)).find((value) => typeof value === 'number');
      const logicalGeneration = consumedLogical ?? logicalOf.get(declaration.callId) ?? batchLogical;
      const source = pmSource({
        op: isHole ? 'hide' : 'stabilize',
        callId: declaration.callId,
        logicalGeneration,
        generation,
        refs: [...span.shadowed],
        ...(consumed.length === 0 ? {} : { consumed }),
      });
      const startSeq = span.shadowed[0];
      const endSeq = span.shadowed[span.shadowed.length - 1];
      const mark = { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [...span.shadowed] };
      const messageId = 'pm-surface-' + String(declaration.callId) + '-' + String(k);
      // 控制变量实验：所有替代文本（stabilize 与 hide）都写 developer/message。
      const devMessage = {
        id: messageId,
        role: 'developer',
        content: [{ type: 'text', text: isHole ? ' ' : rawText }],
        source,
      };
      if (open !== undefined) {
        session.append('developer/message', { turn: open.turn, step: open.step, message: devMessage }, mark);
      } else {
        session.append('developer/message', { message: devMessage }, mark);
      }
      explicit++;
    }
  }

  // 自动隐藏一律是纯空洞 —— 没有打开的 step 就留到下一个边界（可见性检查天然幂等）。
  let auto = 0;
  if (open !== undefined) {
    for (const target of autoTargets) {
      const generation = session.surface.replaceGeneration + 1;
      const source = pmSource({
        op: 'hide',
        logicalGeneration: batchLogical,
        generation,
        refs: [...target.shadowed],
        note: 'auto-hide:' + target.reason,
      });
      session.append('developer/message', {
        turn: open.turn,
        step: open.step,
        message: {
          // 确定性 id：同一个 callId + 同一段历史 → 同一个 node id，日志可对账、可重放。
          id: 'pm-auto-hide-' + String(target.callId) + '-' + String(target.shadowed[0]),
          role: 'developer',
          content: [{ type: 'text', text: ' ' }],
          source,
        },
      }, {
        surfaceOp: { op: 'replace', startSeq: target.shadowed[0], endSeq: target.shadowed[target.shadowed.length - 1] },
        sourceEventSeqs: [...target.shadowed],
      });
      auto++;
    }
  }
  return { explicit, auto, applied: planned.length, failed };
}

/**
 * 在已扫到的声明里找**最近一条尚未被执行**的 set。
 *
 * 待决状态不另存 —— set 调用的 arguments 本来就在日志里（那份声明就是待决状态）。
 * @param {Array<object>} declarations - 已扫到的声明（日志顺序）。
 * @param {object} before - 只取排在它之前的声明。
 * @returns {object|undefined} 待决的 set 声明。
 */
function findLastPendingSet(declarations, before) {
  const cut = declarations.indexOf(before);
  let found;
  for (let i = 0; i < cut; i++) {
    if (declarations[i].args?.option === 'set') found = declarations[i];
  }
  return found;
}

/**
 * 提交边界：把待办声明写成投影。
 * @param {object} session - 目标会话。
 * @param {{openStep?: {turn: number, step: number}, autoHide?: boolean}} options - 边界参数。
 * @param {object} [logger] - 日志器。
 * @returns {{applied: number, skipped: number, auto: number, generation: number}} 结果。
 */
export function flush(session, options, logger) {
  const open = options?.openStep;
  const autoHide = options?.autoHide !== false;
  const state = stateOf(session);
  scanNew(session, state);

  if (state.shapeIssues.size > 0) {
    for (const issue of state.shapeIssues) warnShapeOnce(state, issue, logger);
    state.shapeIssues.clear();
  }

  // also_execute_last_set：一条 execute 声明可以连带消费**最近一条未执行的 set**。
  // 这必须在 flush 里展开 —— 待决 set 的 ops 需要对**当前**工作面重新解析（工具执行时算不出）。
  const todo = [];
  for (const d of state.declarations) {
    if (d.args?.option !== 'execute') continue;
    if (isDone(state, d)) continue;
    let anchor;
    if (d.args?.also_execute_last_set === true) {
      const pending = findLastPendingSet(state.declarations, d);
      if (pending !== undefined && !isDone(state, pending)) {
        if (!todo.includes(pending)) todo.push(pending);
        // execute 重传的 ops 属于 set 那条消息 —— 零点也必须用 set 的。
        // 锚点必须是**承载消息的调用 id**（PTC 下是 rootCallId；subCallId 反查不到消息）
        anchor = pending.ownerCallId ?? pending.callId;
      }
    }
    todo.push(anchor === undefined ? d : Object.assign(Object.create(Object.getPrototypeOf(d)), d, { opsAnchorCallId: anchor }));
  }

  // 自动隐藏可以在**没有待办**的边界上补做（例如上一个边界没有打开的 step）。
  const hasExecute = todo.some((d) => d.args?.option === 'execute');
  const appliedBefore = state.declarations.some((d) => d.args?.option === 'execute' && state.appliedCallIds.has(d.callId));
  const appliedExecuteSeq = state.declarations
    .filter((d) => d.args?.option === 'execute' && state.appliedCallIds.has(d.callId))
    .reduce((max, d) => Math.max(max, d.seq), -1);
  const autoOnly = todo.length === 0 && autoHide && open !== undefined && appliedBefore;
  if (todo.length === 0 && !autoOnly) return { applied: 0, skipped: 0, auto: 0, generation: session.surface.replaceGeneration };

  let applied = 0;
  let skipped = 0;
  let auto = 0;
  // 一批（execute 声明 + 它连带消费的 set）必须**一起解析、一起写**，
  // 否则后一条会按前一条收缩后的工作面理解偏移。
  try {
    const written = applyDeclarations(session, todo, open, state, {
      autoHide: autoHide && (hasExecute || appliedBefore),
      appliedBefore,
      appliedExecuteSeq,
    });
    auto = written.auto;
    applied = written.applied;
    skipped = written.failed.length;
    for (const { declaration, error } of written.failed) {
      const key = 'd:' + declaration.callId;
      if (state.warned.has(key)) continue;
      state.warned.add(key);
      logger?.warn?.('[pm-h0] ' + PM_TOOL + ' 投影失败：' + String(error?.message ?? error));
    }
  } catch (error) {
    skipped = todo.length;
    applied = 0;
    for (const declaration of todo) {
      const key = 'd:' + declaration.callId;
      if (state.warned.has(key)) continue;
      state.warned.add(key);
      logger?.warn?.('[pm-h0] ' + PM_TOOL + ' 投影失败：' + String(error?.message ?? error));
    }
  }
  return { applied, skipped, auto, generation: session.surface.replaceGeneration };
}

/**
 * 用户侧命令（slash command）直接执行一次投影。
 *
 * 与工具路径的区别：命令没有「承载步骤」，所以
 *   - 不存在 `this` 的零点（明确拒绝，而不是给个差一截的结果）；
 *   - 不进入待办队列，当场写入（用户就在等回执）；
 *   - 不触发自动隐藏（隐藏的是模型的步骤组，不是用户的命令）。
 * @param {object} session - 目标会话。
 * @param {Array<object>} rawOps - 与工具相同的 ops 结构。
 * @param {'set'|'execute'} option - 预览 / 落实。
 * @param {object} [logger] - 日志器。
 * @returns {{text: string, generation: number, written: number}} 命令回执。
 */
// ─────────────────────────────────────────────────────────────────────────────
// /plasticize 命令的待落盘操作（唯一的进程内状态；发送用户消息时约化并写入日志）
//
// 设计：lock / unlock / 稳定化(隐藏) 三类操作只要区间互不重叠就是可交换的。
// 因此不需要有序队列：每次命令只做「与已有待落盘区间是否重叠 / 是否符合安全区约束」的校验，
// 然后加入集合；发送消息时统一约化（合并同操作连续区间）再落盘。
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_USER_OPS = new WeakMap();

function pendingOf(session) {
  let list = PENDING_USER_OPS.get(session);
  if (list === undefined) { list = []; PENDING_USER_OPS.set(session, list); }
  return list;
}

/** 尚未落盘的 /plasticize 操作数。 */
export function pendingUserOperations(session) {
  return (PENDING_USER_OPS.get(session) ?? []).length;
}

/** 清空尚未落盘的操作（诊断/测试用）。 */
export function clearStagedOperations(session) {
  const list = PENDING_USER_OPS.get(session) ?? [];
  PENDING_USER_OPS.delete(session);
  return list.length;
}

/**
 * 登记一条 /plasticize 操作（不写日志）。
 * @param {object} session - 目标会话。
 * @param {'lock'|'unlock'|'project'} kind - 操作种类。
 * @param {string} interval - 区间文本。
 * @param {string} [newText] - 稳定化替代文本（project 用；空 = 隐藏）。
 * @returns {{pending:number, shadowed:number[], kind:string}}
 */
export function stageUserOperation(session, kind, interval, newText) {
  if (kind !== 'lock' && kind !== 'unlock' && kind !== 'project') throw new Error('未知操作：' + String(kind));
  const resolved = resolveOps(session, [{ spans: [interval], new_text: kind === 'project' ? String(newText ?? '') : 'x' }], undefined);
  const seqs = resolved.flatMap((span) => span.shadowed);
  if (seqs.length === 0) throw new Error('区间解析后是空的');
  const list = pendingOf(session);
  const taken = new Set(list.flatMap((entry) => entry.seqs));
  if (seqs.some((seq) => taken.has(seq))) {
    throw new Error('与尚未落盘的 /plasticize 操作区间重叠；三条命令之间区间必须互不重叠。');
  }
  const locks = lockedSeqs(session);
  if (kind === 'lock') {
    const hit = seqs.filter((seq) => locks.has(seq));
    if (hit.length > 0) throw new Error('lock 区间包含已在安全区内的消息：seq ' + hit.slice(0, 8).join(',') + '。' + safetyZoneNote(locks));
  } else if (kind === 'unlock') {
    const outside = seqs.filter((seq) => !locks.has(seq));
    if (outside.length > 0) throw new Error('unlock 区间包含不在安全区内的消息：seq ' + outside.slice(0, 8).join(',') + '。' + safetyZoneNote(locks));
  } else {
    const hit = seqs.filter((seq) => locks.has(seq));
    if (hit.length > 0) throw new Error('区间命中安全区：seq ' + hit.slice(0, 8).join(',') + '；请先 /plasticize unlock。' + safetyZoneNote(locks));
  }
  list.push({ kind, seqs, text: kind === 'project' ? String(newText ?? '') : '', interval });
  return { pending: list.length, shadowed: seqs, kind };
}

async function appendPrivateRecord(session, type, data) {
  const append = injectedPluginRecordAppender ?? (await appendPluginRecordLazy());
  if (typeof append !== 'function') throw new Error('当前宿主不支持 plugin record');
  return append(session, type, data);
}

/** 判断两组连续 seq 在当前工作面上是否相邻。 */
function contiguousSeqs(left, right, position) {
  const leftIndex = position.get(left[left.length - 1]);
  const rightIndex = position.get(right[0]);
  return Number.isSafeInteger(leftIndex) && Number.isSafeInteger(rightIndex) && rightIndex === leftIndex + 1;
}

/**
 * 发送用户消息时：约化（合并同操作的连续区间）并写入日志。
 * 安全区操作写成私有记录；若有稳定化/隐藏，写投影后再追加一条逻辑世代私有记录。
 * @returns {Promise<{projections:number, safety:number}>}
 */
export async function flushUserOperations(session, openStep, logger) {
  const list = PENDING_USER_OPS.get(session);
  if (list === undefined || list.length === 0) return { projections: 0, safety: 0 };
  const state = stateOf(session);
  scanNew(session, state);
  const base = countLogicalGenerations(session);
  const locks = lockedSeqs(session);
  const nodes = session.surface.nodes;
  const position = new Map();
  for (let index = 0; index < nodes.length; index += 1) position.set(nodes[index], index);
  // 约化：按当前工作面位置排序，同操作且相邻的区间合并。
  const sorted = [...list].sort((left, right) => (position.get(left.seqs[0]) ?? 0) - (position.get(right.seqs[0]) ?? 0));
  const groups = [];
  for (const entry of sorted) {
    const key = entry.kind === 'project' ? 'project\u0000' + entry.text : entry.kind;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key && contiguousSeqs(last.seqs, entry.seqs, position)) {
      last.seqs = [...last.seqs, ...entry.seqs];
      continue;
    }
    groups.push({ kind: entry.kind, key, seqs: [...entry.seqs], text: entry.text, interval: entry.interval });
  }
  let safety = 0;
  for (const group of groups) {
    if (group.kind !== 'lock' && group.kind !== 'unlock') continue;
    const visible = new Set(nodes);
    const stillAllowed = group.kind === 'lock'
      ? group.seqs.every((seq) => visible.has(seq)) && !group.seqs.some((seq) => locks.has(seq))
      : group.seqs.every((seq) => visible.has(seq)) && group.seqs.every((seq) => locks.has(seq));
    if (!stillAllowed) { logger?.warn?.('[pm-h0] 待落盘安全区段已失效，跳过：' + group.interval); continue; }
    await appendPrivateRecord(session, 'plugin:plastic-memories/locks', { op: group.kind, mode: 'range', seqs: group.seqs });
    safety += 1;
  }
  let projections = 0;
  for (const group of groups) {
    if (group.kind !== 'project') continue;
    const visible = new Set(session.surface.nodes);
    if (!group.seqs.every((seq) => visible.has(seq)) || group.seqs.some((seq) => locks.has(seq))) {
      logger?.warn?.('[pm-h0] 待落盘投影段已失效，跳过：' + group.interval);
      continue;
    }
    const generation = session.surface.replaceGeneration + 1;
    const isHole = group.text.length === 0;
    const callId = 'pm-user-' + String(session.seq) + '-' + String(projections);
    const source = pmSource({
      op: isHole ? 'hide' : 'stabilize',
      callId,
      generation,
      logicalGeneration: base,
      refs: [...group.seqs],
    });
    const message = {
      id: 'pm-surface-' + callId,
      role: 'developer',
      content: [{ type: 'text', text: isHole ? ' ' : group.text }],
      source,
    };
    const mark = { surfaceOp: { op: 'replace', startSeq: group.seqs[0], endSeq: group.seqs[group.seqs.length - 1] }, sourceEventSeqs: [...group.seqs] };
    if (openStep !== undefined && openStep !== null) {
      session.append('developer/message', { turn: openStep.turn, step: openStep.step, message }, mark);
    } else {
      session.append('developer/message', { message }, mark);
    }
    projections += 1;
  }
  if (projections > 0) {
    await appendPrivateRecord(session, 'plugin:plastic-memories/logical', { logical: base, kind: 'user-projection', count: projections });
  }
  PENDING_USER_OPS.delete(session);
  return { projections, safety };
}
export function executeUserCommand(session, rawOps, option, logger) {
  if (option !== 'set' && option !== 'execute') {
    throw new Error('option 必须是 "set"（预览）或 "execute"（落实）');
  }
  let resolved;
  try {
    resolved = resolveOps(session, rawOps, undefined);
  } catch (error) {
    throw new Error(String(error?.message ?? error) +
      '\n提示：用户命令没有步骤锚点，spans 不能用 "this"；请用 cookie 区间/编号或文本关键字。');
  }
  if (option === 'set') {
    const preview = previewOf(session, resolved, 'pm-command-preview-' + String(session.seq));
    return {
      text: '预览（尚未写入）：下一代会是第 ' + String(preview.generation) + ' 代、' +
        String(preview.messageCount) + ' 条消息。\n' + preview.text,
      generation: session.surface.replaceGeneration,
      written: 0,
    };
  }
  if (resolved.some((span) => String(span.op.new_text ?? '').length === 0)) {
    throw new Error('用户命令不能产生纯空洞（new_text 为空）：纯隐藏请给一个替代文本');
  }
  // 先扫一遍日志，保证 state 是最新的（命令可能在两次边界之间执行）。
  const state = stateOf(session);
  scanNew(session, state);
  const locks = lockedSeqs(session);
  for (const span of resolved) assertNotLocked(locks, span.shadowed);
  const callId = 'pm-user-' + String(session.seq);
  let written = 0;
  let generation = session.surface.replaceGeneration;
  for (const span of resolved) {
    generation = session.surface.replaceGeneration + 1;
    const source = pmSource({
      op: 'stabilize',
      callId,
      generation,
      refs: [...span.shadowed],
    });
    session.append('user/message', {
      id: 'pm-surface-' + callId + '-' + String(written),
      role: 'user',
      content: [{ type: 'text', text: String(span.op.new_text) }],
      source,
    }, {
      surfaceOp: { op: 'replace', startSeq: span.shadowed[0], endSeq: span.shadowed[span.shadowed.length - 1] },
      sourceEventSeqs: [...span.shadowed],
    });
    written++;
  }
  logger?.info?.('[pm-h0] 用户命令应用 ' + String(written) + ' 段，世代 ' + String(generation));
  return { text: '已应用 ' + String(written) + ' 段投影，当前第 ' + String(generation) + ' 代。', generation, written };
}

/** 供 pm_status 用的诊断：列出待办声明。 */
export function pendingReport(session) {
  const state = stateOf(session);
  scanNew(session, state);
  return state.declarations
    .filter((d) => d.args?.option === 'execute' && !isDone(state, d))
    .map((d) => ({ callId: d.callId, via: d.via, seq: d.seq }));
}
// ─────────────────────────────────────────────────────────────────────────────
// 逻辑世代：一次成功的 execute 操作 = 一个逻辑世代；物理世代可能多个。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逻辑世代表（只读推导；不改变投影行为）。
 *
 * 物理世代 = 每条 surfaceOp replace（一次 execute 可能写多条）；
 * 逻辑世代 = 成功的 execute 操作本身（含 also_execute_last_set 消费的 set）。
 *
 * @param {object} session - 目标会话。
 * @returns {{total:number, executes:Array<{callId:string, logical:number, seq:number}>}}
 */
/**
 * 某次 execute 调用应获得的逻辑世代号（工具结果直接返回它，不需要往前数）。
 * 已落地的 execute 数量 + 本批尚未落地 execute 中的序号。
 * @param {object} session - 目标会话。
 * @param {string} callId - 本次调用 id。
 * @returns {number} 逻辑世代号（1 起）。
 */
export function logicalGenerationForCall(session, callId) {
  const state = stateOf(session);
  scanNew(session, state);
  let applied = countLogicalGenerations(session);
  const pending = [];
  for (const declaration of state.declarations) {
    if (declaration.args?.option !== 'execute') continue;
    if (state.appliedCallIds.has(declaration.callId)) { applied += 1; continue; }
    if (state.failedCallIds.has(declaration.callId)) continue;
    pending.push(declaration);
  }
  const index = pending.findIndex((declaration) => declaration.callId === callId);
  // 0 起：前面没有 execute → 0；否则 = 前一个 execute 的结果号 + 1。
  return applied + (index >= 0 ? index : pending.length);
}

export function logicalGenerations(session) {
  const state = stateOf(session);
  scanNew(session, state);
  const applied = state.appliedCallIds;
  const executes = [];
  for (const declaration of state.declarations) {
    if (declaration.args?.option !== 'execute') continue;
    if (!applied.has(declaration.callId)) continue;
    executes.push({ callId: declaration.callId, logical: executes.length, seq: declaration.seq });
  }
  const count = countLogicalGenerations(session);
  return { total: count === 0 ? 0 : count - 1, count, executes };
}

/** 已产生的逻辑世代总数（成功的 execute + 用户命令写入的逻辑世代事件）。 */
export function countLogicalGenerations(session) {
  const state = stateOf(session);
  scanNew(session, state);
  let executes = 0;
  for (const declaration of state.declarations) {
    if (declaration.args?.option !== 'execute') continue;
    if (state.appliedCallIds.has(declaration.callId)) executes += 1;
  }
  let privateEvents = 0;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'plugin:plastic-memories/logical') privateEvents += 1;
  }
  return executes + privateEvents;
}