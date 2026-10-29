/**
 * Plastic Memories — H0 插件入口。
 *
 * 两个工具：
 *   plasticize  唯一会改变工作面、产生新世代的工具（也能只做预览）
 *   retrospect  只读查询（含已隐藏的原文）
 *
 * 本模块只做**定义与接线**：解析与写入在 plasticize.js / engine.js，坐标在 coords.js。
 *
 * @module dsh-plugin-plastic-memories-h0
 */

import { logicalGenerationForCall, flush, flushUserOperations, pendingReport } from './engine.js';
import { registerCommands } from './commands.js';
import { GENERATIONS_KEY, generationProjection } from './generations.js';
import { stepGroup, surfaceNodes } from './coords.js';
import { resolveOps, previewOf, findLastPendingSet, normalizeOp } from './plasticize.js';
import { retrospect } from './retrospect.js';
import { COOKIE_KIND, bracketUserMessages, cookieMessage, cookieText, nextCookieId, planCookie } from './cookie.js';
import { openSetProfile } from './grouping.js';
import { compileArgsValidator, ToolArgsError } from './schema.js';

/** 插件名。 */
export const name = 'plastic-memories-h0';

/** 需要的服务。 */
export const inject = ['tools'];

/** 允许的配置键（全部是诊断/呈现用途，不改变投影语义）。 */
const KNOWN_CONFIG_KEYS = new Set(['trace', 'probeImports', 'autoHide', 'uiHost']);

/**
 * 归一化配置。
 * @param {object|undefined} raw - patch 行里的 config。
 * @param {object} logger - ctx.logger。
 * @returns {{trace: boolean, probeImports: boolean, autoHide: boolean, uiHost: boolean}} 配置。
 */
function normalizeConfig(raw, logger) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) logger?.warn?.('[pm-h0] 未知配置键 ' + JSON.stringify(key) + '（已忽略）');
  }
  return {
    trace: cfg.trace === true,
    probeImports: cfg.probeImports === true,
    // 默认开：execute 成功时顺手隐藏报错的 PM 步骤组与成功的 set 步骤组（见 engine.js）。
    autoHide: cfg.autoHide !== false,
    // UI 宿主行（bundle 级）：只注册世代投影并让浏览器发现客户端半身；
    // 不注册工具/命令 —— 那是 PM 会话模式（preset 行）的事。
    uiHost: cfg.uiHost === true,
  };
}

/**
 * 注册世代上下文投影（客户端侧边栏读的就是这条 wire 值）。
 * @param {object} ctx - 插件上下文。
 */
function registerGenerationProjection(ctx, ready) {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    ready?.(projectionCtx.sessionProjections);
    projectionCtx.effect(
      () => projectionCtx.sessionProjections.register(generationProjection()),
      'pm-h0: 世代上下文投影',
    );
  });
}

/**
 * 手工构造 registry-ready 的 ToolDefinition（与 defineTool 的产物同形），
 * 并补回它的参数校验行为。
 * @param {object} spec - {name, description, parameters, execute}。
 * @returns {object} ToolDefinition。
 */
function tool(spec) {
  const validate = compileArgsValidator(spec.parameters);
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
    },
    execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return spec.execute(args, exec);
    },
  };
}

/** 取本次调用所属的 agent 会话。 */
function sessionOf(exec) {
  const session = exec?.agent?.session;
  if (session === undefined || session === null) {
    throw new Error('本工具需要一个属于某个 agent 的会话（exec.agent.session 不可用）');
  }
  return session;
}

/**
 * 可选启动自检：探测本 profile 能否解析 @deepseek-ai 运行时包。
 * @param {object} ctx - 插件上下文。
 */
function probeRuntimeImports(ctx) {
  const SPECIFIERS = [
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-compaction',
    '@deepseek-ai/schemastery',
    'zod',
  ];
  void (async () => {
    const lines = [];
    for (const specifier of SPECIFIERS) {
      try {
        const mod = await import(specifier);
        lines.push('  OK   ' + specifier + ' (' + Object.keys(mod).length + ' exports)');
      } catch (error) {
        lines.push('  FAIL ' + specifier + ' — ' + String(error?.code ?? error?.name ?? error));
      }
    }
    ctx.logger?.info?.('[pm-h0] 运行时依赖探针（决定能否改用 @deepseek-ai 包）:\n' + lines.join('\n'));
  })();
}

/**
 * 安装插件。
 * @param {object} ctx - 插件上下文。
 * @param {object|undefined} config - patch 行里的 config。
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config, ctx.logger);

  // bundle 级「UI 宿主」行：只做世代投影 + 让 web 客户端发现本包的 client 半身。
  // （PM 会话模式之外的模式里：没有工具、没有命令、没有任何 surface 改写。）
  if (options.uiHost) {
    registerGenerationProjection(ctx);
    return;
  }

  if (options.probeImports) probeRuntimeImports(ctx);

  // 工具/hook 之外的两件装配：世代投影（轨迹世代选择的数据）与用户侧 slash 命令。
  let projectionService;
  registerGenerationProjection(ctx, (service) => {
    projectionService = service;
  });
  registerCommands(ctx, ctx.logger);

  /**
   * 运行期一致性自检：我们的世代投影状态（可见 seq / 世代号）必须与**官方 surface**
   * （真正用于组装推理请求的那一份）完全一致；不一致只告警一次（诊断用途，不降级功能）。
   * @param {object} session - 目标会话。
   */
  const consistencyWarned = new WeakSet();
  const checkSurfaceConsistency = (session) => {
    if (projectionService === undefined || session === undefined || session === null) return;
    try {
      const state = projectionService.stateOf(session, GENERATIONS_KEY);
      if (state === undefined || state === null) return;
      const officialNodes = session.surface.nodes;
      const officialGeneration = session.surface.replaceGeneration;
      const sameGeneration = state.gen === officialGeneration;
      const sameNodes = state.seqs.length === officialNodes.length
        && state.seqs.every((seq, index) => seq === officialNodes[index]);
      if (sameGeneration && sameNodes) return;
      if (consistencyWarned.has(session)) return;
      consistencyWarned.add(session);
      ctx.logger?.warn?.('[pm-h0] 世代投影与官方 surface 不一致（gen ' + String(state.gen) + ' vs ' + String(officialGeneration) +
        '，nodes ' + String(state.seqs.length) + ' vs ' + String(officialNodes.length) + '）—— 轨迹展示可能偏离真实请求');
    } catch {
      // 自检失败不影响主流程
    }
  };

  // ── 提交边界 ────────────────────────────────────────────────────────────
  // 挂 agent/request：那一刻 step 已打开（dsh-agent-loop 的顺序是
  // pre-step -> step/start -> step()/agent/request -> step/end），
  // 而且本步的工具结果已全部落地 —— 「本步整组」才完整。
  const safeFlush = async (session, where, payload) => {
    if (session === undefined || session === null) return;
    try {
      const openStep = payload !== undefined && Number.isSafeInteger(payload.turn) && Number.isSafeInteger(payload.step)
        ? { turn: payload.turn, step: payload.step }
        : undefined;
      let userResult = { projections: 0, safety: 0 };
      try {
        userResult = await flushUserOperations(session, openStep, ctx.logger);
      } catch (error) {
        ctx.logger?.warn?.('[pm-h0] ' + where + ' 用户 /plasticize 落盘失败（已降级）：' + String(error?.message ?? error));
      }
      const result = flush(session, { openStep, autoHide: options.autoHide }, ctx.logger);
      if (userResult.projections > 0 || userResult.safety > 0) {
        ctx.logger?.info?.('[pm-h0] ' + where + ' 用户 /plasticize 落盘：投影 ' + String(userResult.projections) + '，安全区 ' + String(userResult.safety));
      }
      if (options.trace || result.applied > 0 || result.skipped > 0 || result.auto > 0) {
        ctx.logger?.[result.skipped > 0 ? 'warn' : 'info']?.(
          '[pm-h0] ' + where + ' 投影：应用 ' + result.applied + '，自动隐藏 ' + result.auto +
          '，跳过 ' + result.skipped + '，世代 ' + result.generation,
        );
      }
    } catch (error) {
      // 降级为告警：插件失败不该让用户的 turn 失败（优雅退化）
      ctx.logger?.warn?.('[pm-h0] ' + where + ' flush 失败（已降级，turn 不受影响）：' + String(error?.message ?? error));
    }
  };

  /**
   * 在提交边界**顺便**补插 cookie。
   *
   * 规则只有一条：**队尾永远保持一个 cookie**。
   * 队尾不是 cookie 就补一个，是就什么都不做。
   *
   * 这一条覆盖了全部需要锚点的位置：
   * - 工具块结束后（边界一到，队尾就是那个结果）
   * - 用户主动发送的消息后
   * - **最后一条 assistant 与下一条 user 之间** —— turn 末补一个，
   *   下一轮用户消息落盘时它自然就在前面（日志仅追加，「前面」只能提前埋）
   *
   * **只能往后追加**：surfaceOp 只有 append 与 replace，而且不带 surfaceOp 的
   * user/message 会被 DSH 直接拒绝（实测）。所以已经落盘的消息前面插不进东西。
   *
   * cookie 不标记任何东西 —— 它就是流里的一个可见锚点。
   */
  const insertCookie = (session, payload, role = 'developer') => {
    if (session === undefined || session === null) return 0;
    try {
      const plan = planCookie(session);
      if (plan === undefined) return 0;
      const id = nextCookieId(session);
      if (role === 'user') {
        session.append('user/message', cookieMessage(id), { surfaceOp: 'append' });
        return 1;
      }
      const message = cookieMessage(id, 'developer');
      let turn = Number.isSafeInteger(payload?.turn) ? payload.turn : undefined;
      let step = Number.isSafeInteger(payload?.step) ? payload.step : undefined;
      if (turn === undefined || step === undefined) {
        const events = session.snapshotEvents();
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (turn === undefined && event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn;
          if (step === undefined && event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) step = event.data.step;
          if (turn !== undefined && step !== undefined) break;
        }
      }
      if (!Number.isSafeInteger(turn)) return 0;
      if (!Number.isSafeInteger(step)) step = 0;
      session.append('developer/message', { turn, step, message }, { surfaceOp: 'append' });
      return 1;
    } catch (error) {
      ctx.logger?.warn?.('[pm-h0] 插入 cookie 失败（已降级）：' + String(error?.message ?? error));
      return 0;
    }
  };

  ctx.on(
    'agent/request',
    async (payload, next) => {
      await safeFlush(payload?.agent?.session, 'request', payload);
      insertCookie(payload?.agent?.session, payload);
      checkSurfaceConsistency(payload?.agent?.session);
      return next();
    },
    { prepend: true },
  );

  // turn 末的兜底：只挂 agent/request 会漏掉「模型在本 turn 最后一个动作里调用 PM」。
  ctx.on('agent/turn-stopping', (payload) => {
    void safeFlush(payload?.agent?.session, 'turn-stopping', payload);
    checkSurfaceConsistency(payload?.agent?.session);
  });

  // ── 用户消息夹层 cookie ──────────────────────────────────────────────────
  // 日志只能追加：消息一旦落盘，就没法在它**前面**补 cookie。
  // 而 `agent/pre-step` 的 decision.messages 正是「还没落盘、即将按序追加」的那批消息 ——
  // 在这里把 [cookie][用户消息][cookie] 摆进队列，模型看到的 token 流就是
  //
  //     … [cookie N] 用户消息 [cookie N+1] 时间快照 助手 …
  //
  // 于是「被两条 cookie 夹住的 = 用户亲口说的」与「系统注入的 user 消息」在流里可分，
  // 不需要偏移量（模型数不准第几条消息）。
  //
  // prepend + 包住 next()：拿到**最终** decision 再改，其他 pre-step 监听器的贡献不会丢。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision;
      const session = payload?.agent?.session;
      if (session === undefined || session === null) return decision;
      try {
        const bracketed = bracketUserMessages(session, decision.messages);
        if (bracketed === undefined) return decision;
        return { ...decision, messages: bracketed };
      } catch (error) {
        ctx.logger?.warn?.('[pm-h0] 用户消息夹层 cookie 插入失败（已降级）：' + String(error?.message ?? error));
        return decision;
      }
    },
    { prepend: true },
  );

  // ── 工具 ────────────────────────────────────────────────────────────────

  ctx.tools.register(
    tool({
      name: 'plasticize',
      description:
        'Rewrite how your own past appears in this context — the ONLY tool that changes the surface and starts a new ' +
        'generation. The trajectory itself is never deleted: hidden material stays in the session log, and retrospect ' +
        'can dig it up later. That is archaeology, NOT a scratch pad — do not hide something intending to pull it ' +
        'back, because what retrospect returns joins your CURRENT generation and undoes the projection. ' +

        'HOW TO NAME A SPAN. Your context contains cookie lines of the form ' +
        '"[Plastic-Memories][cookie][N]" — they are inserted automatically at every boundary, and N is a stable ' +
        'address. Spans are written with those numbers: ' +
        '"3" = that cookie message alone; "[3,4]" = both ends included; "(3,4)" = both ends excluded; ' +
        '"[3,4)" or "(3,4]" = one side; "this" = the assistant message that made THIS call plus all of its ' +
        'tool results. Mixing is allowed: "[3,this]". ' +
        'The two ends have NO direction — the plugin sorts them; an interval is a set of points. ' +
        '"this" is an atomic unit: it always means the whole group. ' +
        'A number that is no longer visible (its cookie was hidden) is rejected with a clear error — use the ' +
        'numbers you can see right now. ' +

        'TOOL BLOCKS ARE HANDLED FOR YOU: a tool call and its results are separate messages; a boundary that lands ' +
        'inside such a block is widened to the block edge, so you can never leave an orphan call or orphan result. ' +
        'The span that actually gets replaced may therefore include a few more messages than you literally named. ' +

        'Each entry in ops has spans (one or more span strings) and new_text. All spans in one entry are hidden ' +
        'EXCEPT the last one by position, which receives new_text — that is how you hide several disjoint stretches ' +
        'in one operation. new_text:"" is a pure hole (that is how you express hide). ' +

        'option "set" only computes and shows a preview of the next generation and writes NOTHING: look at it, then ' +
        'either rewrite your ops from scratch (not incrementally) or commit. option "execute" commits at the next ' +
        'submission boundary; with also_execute_last_set:true it also commits the most recent unexecuted set, so one ' +
        'call turns a preview you agreed with into reality. ' +

        'After a successful execute the plugin also hides the PM steps that are pure noise for the new generation: ' +
        'failed plasticize calls and fulfilled plasticize(set) previews. You do not have to clean those up yourself. ' +

        'ONE OPERATION IS POINTLESS: spans ["this"] with new_text:"" as the ENTIRE operation. It hides only ' +
        'this call and its result with no replacement, so the net effect equals never making the call at all ' +
        '(and you cannot even see the receipt). Hiding this TOGETHER with other spans is fine and often useful. ' +
        'To actively hide a target step, hide that step by its cookie interval instead.',
      parameters: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            description: 'One entry per operation. Each entry names one or more spans and ONE replacement message.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                // 注意：宿主的 JSON Schema 子集是**封闭白名单**（dsh-tools/json-schema）：
                // 只认 type / properties / required / additionalProperties / items / enum / const / oneOf。
                // minItems / maxItems 会直接被 assertSupportedJsonSchema 拒绝 —— 不要加。
                // 数量约束（2..16）在 resolveEndpoint 里做。
                // 注意：宿主的 JSON Schema 子集是**封闭白名单**（dsh-tools/json-schema）：
                // 只认 type / properties / required / additionalProperties / items / enum / const / oneOf。
                // minItems / maxItems 会被 assertSupportedJsonSchema 拒绝 —— 不要加。
                spans: {
                  type: 'array',
                  items: { type: 'string' },
                  description: "One or more spans, each written as a cookie range. Forms: '3' (that cookie alone), '[3,4]' closed, '(3,4)' open, '[3,4)' or '(3,4]' half-open, 'this' (the assistant message that made THIS call plus its tool results). Use cookie numbers you can see in your context. Every span is hidden except the LAST one, which receives new_text.",
                },
                new_text: { type: 'string', description: 'The replacement message, placed at the LAST span. Empty string = pure hole (hide). Every earlier span is hidden automatically.' },
                lock_this: { type: 'boolean', description: 'Default false. If true, lock the replacement message itself into the safety zone (it can never be reshaped afterwards).' },
              },
              required: ['spans'],
            },
          },
          option: {
            type: 'string',
            enum: ['set', 'execute'],
            description: 'set = preview only, writes nothing. execute = commit at the next boundary.',
          },
          also_execute_last_set: {
            type: 'boolean',
            description: 'Only valid with option:execute. Also commits the most recent unexecuted set.',
          },
        },
        required: ['ops', 'option'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const option = args?.option;
        if (option !== 'set' && option !== 'execute') throw new Error('option 必须是 set 或 execute');
        if (option === 'set' && args?.also_execute_last_set === true) {
          throw new Error('also_execute_last_set 只能和 option:execute 一起用');
        }

        // 「本步整组」：容纳本次调用的 assistant 消息 … 它的全部工具结果。
        const group = stepGroupFor(session, exec);
        if (group === undefined) throw new Error('找不到承载本次调用的消息');
        const here = group.here;

        const parts = [];
        const batches = [];
        if (option === 'execute' && args?.also_execute_last_set === true) {
          const pending = findLastPendingSet(session);
          if (pending === undefined) parts.push('（没有待执行的 set，跳过 also_execute_last_set）');
          else {
            // **零点属于写下这条 ops 的那条 plasticize（set）**，与 engine 的 flush 一致。
            // 预览与落实必须同源，否则「看过的」和「落实的」不是同一个。
            const pendingGroup = stepGroupFor(session, { callId: pending.callId });
            batches.push({
              from: '上次 set', callId: pending.callId, ops: pending.ops,
              here: pendingGroup === undefined ? here : pendingGroup.here,
            });
          }
        }
        batches.push({ from: '本次调用', callId: exec.callId, ops: args?.ops, here });

        if (option === 'set') {
          const flat = [];
          for (const batch of batches) flat.push(...resolveOps(session, batch.ops, batch.here));
          const pv = previewOf(session, flat, exec.callId);
          parts.push('已登记（未执行）。下一代会是第 ' + pv.generation + ' 代、' + pv.messageCount + ' 条消息：');
          parts.push(pv.text);
          parts.push('看到预览后：同意就再调 plasticize 并传 option: execute, also_execute_last_set: true；不同意就整条重写 ops（不是增量改）。');
        } else {
          // 只登记：真正写入由 flush 在提交边界做（见 engine.js 的说明）。
          let total = 0;
          for (const batch of batches) total += resolveOps(session, batch.ops, batch.here).length;
          parts.push('已登记 ' + total + ' 段，将在下一个提交边界写入。');
          const logicalGeneration = logicalGenerationForCall(session, exec.callId);
          parts.push('逻辑世代 ' + logicalGeneration + '（pm-logical-generation=' + logicalGeneration + '）；物理世代在提交边界产生，仅作参考。');
          for (const batch of batches) parts.push('  · ' + batch.from + '：' + batch.ops.length + ' 个段落');
        }
        return Promise.resolve({ text: parts.join(String.fromCharCode(10)) });
      },
    }),
  );


  ctx.tools.register(
    tool({
      name: 'retrospect',
      description:
        'Read the CONTEXT of ONE PAST logical generation (~ /plasticize history). It never changes anything. ' +
        'Pass generation as either an absolute logical generation number (0-based, e.g. 3) or the ' +
        'label form "self - N" (e.g. "self - 1"). The target MUST be strictly before self: the current ' +
        'generation is already visible in your input, so querying it is meaningless and rejected. ' +
        'Returns a compact STRUCTURED JSON object: {logical, messages, count}. messages is that generation\'s ' +
        'surface context (full text, no truncation), ' +
        'reconstructed by replaying the log to that generation\'s last write; it does NOT include the material that ' +
        'generation hid (that material belonged to the previous generation). ' +
        'To read several generations, call this tool once per generation from a PTC program — it deliberately ' +
        'returns only one generation per call so you can orchestrate/limit the data yourself.',
      parameters: {
        type: 'object',
        properties: {
          generation: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: 'Past logical generation: absolute number (e.g. 3) or "self - N" (e.g. "self - 1"). Must be < self.',
          },
        },
        required: ['generation'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        return Promise.resolve({ text: retrospect(session, args ?? {}) });
      },
    }),
  );

  /**
   * 取承载本次调用的 assistant 消息，以及它的全部工具结果。
   * @param {object} session - 目标会话。
   * @param {object} exec - 工具执行上下文。
   * @returns {object|undefined} 本步整组。
   */
  function stepGroupFor(session, exec) {
    const callId = exec?.callId;
    if (typeof callId !== 'string') return undefined;
    const cut = callId.indexOf(':ptc:');
    const owner = cut === -1 ? callId : callId.slice(0, cut);
    const group = stepGroup(session, owner);
    if (group === undefined) return undefined;
    const nodes = surfaceNodes(session);
    // selfComplete=false：工具执行期，自己的 tool/result 还没落地。
    // 此时 this 的末端只能落在已经存在的节点上；resolveOps 会跳过「收尾在 this 末端」
    // 的配对平衡校验（结果落地后在提交边界上必然闭合）。
    return {
      ...group,
      here: {
        thisSeq: nodes[group.startIndex],
        thisEndSeq: nodes[group.endIndex],
        selfComplete: group.complete,
      },
    };
  }

  void pendingReport;
  void normalizeOp;
}