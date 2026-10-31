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

import { assertSinglePendingPlasticize, logicalGenerationForCall, flush, flushUserOperations, pendingReport, assertResolvedUnlocked, installPrivateRecordAppender } from './engine.js';
import { registerCommands } from './commands.js';
import { GENERATIONS_KEY, generationProjection } from './generations.js';
import { stepGroup, surfaceNodes } from './coords.js';
import { resolveOps, previewOf, findLastPendingSet, normalizeOp } from './plasticize.js';
import { retrospect } from './retrospect.js';
import { COOKIE_KIND, bracketUserMessages, cookieMessage, cookieText, nextCookieId, planCookie } from './cookie.js';
import { openSetProfile } from './grouping.js';
import { compileArgsValidator, ToolArgsError } from './schema.js';
import { createMessageCapture } from './capture.js';

// 插件记录必须走 appendPluginRecord（event.ignorable=true），否则导出/持久化会拒绝该日志。
// 从宿主 CLI 的模块解析位置找到 dsh-session；测试环境找不到时保留 fallback。
let hostAppendPluginRecord;
try {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const candidates = [process.argv[1], process.cwd() + '/package.json', import.meta.url].filter((value) => typeof value === 'string');
  let resolved;
  for (const candidate of candidates) {
    try {
      const request = createRequire(candidate);
      resolved = request.resolve('@deepseek-ai/dsh-session');
      break;
    } catch { /* try next */ }
  }
  if (resolved !== undefined) {
    const module = await import(pathToFileURL(resolved).href);
    if (typeof module.appendPluginRecord === 'function') hostAppendPluginRecord = module.appendPluginRecord;
  }
} catch { /* fallback below */ }
if (hostAppendPluginRecord === undefined) {
  try {
    const module = await import('@deepseek-ai/dsh-session');
    if (typeof module.appendPluginRecord === 'function') hostAppendPluginRecord = module.appendPluginRecord;
  } catch { /* test environment */ }
}
if (hostAppendPluginRecord !== undefined) installPrivateRecordAppender(hostAppendPluginRecord);

/** 插件名。 */
export const name = 'plastic-memories-h0';

/** 需要的服务。 */
export const inject = ['tools'];

/** 允许的配置键（全部是诊断/呈现用途，不改变投影语义）。 */
const KNOWN_CONFIG_KEYS = new Set(['trace', 'probeImports', 'autoHide', 'uiHost', 'captureMessages', 'captureDir']);

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
    // 测试证据：把每次真实请求的 messages 追加到 <session.cwd>/.pm-capture/<sessionId>.jsonl。
    captureMessages: cfg.captureMessages !== false,
    captureDir: typeof cfg.captureDir === 'string' && cfg.captureDir.length > 0 ? cfg.captureDir : '.pm-capture',
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
    throw new Error('this tool requires an agent session (exec.agent.session is unavailable)');
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

  if (options.captureMessages) {
    const capture = createMessageCapture({ dir: options.captureDir, logger: ctx.logger });
    ctx.on('llm/stream', (request, next) => {
      try {
        const session = typeof request?.sessionId === 'string' ? ctx.sessions.get(request.sessionId) : undefined;
        if (session !== undefined) void capture(session, request);
      } catch (error) {
        ctx.logger?.warn?.('[pm-h0] message capture failed: ' + String(error?.message ?? error));
      }
      return next();
    }, { global: true });
  }

  if (options.probeImports) probeRuntimeImports(ctx);

  // 工具/hook 之外的两件装配：世代投影（轨迹世代选择的数据）与用户侧 slash 命令。
  let projectionService;
  registerGenerationProjection(ctx, (service) => {
    projectionService = service;
  });
  registerCommands(ctx, ctx.logger);

  // 极短的 PM 总纲（仿照 PTC_ONLY 那种 brief instruction 的密度）。
  const pmGuide = 'Plastic Memories tools are available in this session: plasticize reshapes how your own past appears, ' +
    'retrospect reads one past logical generation, and letter leaves a note for future generations. They operate on the ' +
    'session surface; the trajectory itself is never deleted.';
  try {
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('PTC_ONLY') + 10
        : 810;
      ctx.effect(() => systemPrompt.section({ name: 'plastic-memories:guide', order, text: pmGuide }));
    }
  } catch {
    // 没有 systemPrompt 服务时静默跳过；工具描述本身仍完整。
  }

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
  /** 当前上下文水位（百分比整数）；缺少 tokenMeter/contextWindow 时返回 undefined。 */
  function contextUsagePercent(session) {
    try {
      const meter = ctx.get('tokenMeter');
      if (meter === undefined || meter === null || typeof meter.measure !== 'function') return undefined;
      let contextWindow;
      const events = session.snapshotEvents();
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'request/context' && Number.isSafeInteger(event.data?.contextWindow) && event.data.contextWindow > 0) {
          contextWindow = event.data.contextWindow;
          break;
        }
      }
      if (contextWindow === undefined) return undefined;
      const measurement = meter.measure(session);
      const used = Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : measurement?.surfaceTokens;
      if (!Number.isFinite(used) || used < 0) return undefined;
      return Math.round((used / contextWindow) * 100);
    } catch {
      return undefined;
    }
  }

  const insertCookie = (session, payload, role = 'developer') => {
    if (session === undefined || session === null) return 0;
    try {
      const plan = planCookie(session);
      if (plan === undefined) return 0;
      const id = nextCookieId(session);
      const contextPercent = contextUsagePercent(session);
      if (role === 'user') {
        session.append('user/message', cookieMessage(id, 'user', contextPercent), { surfaceOp: 'append' });
        return 1;
      }
      const message = cookieMessage(id, 'developer', contextPercent);
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
        const bracketed = bracketUserMessages(session, decision.messages, contextUsagePercent(session));
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
      description: [
        "Reshape how your own past appears in this context. This is the only tool that changes the surface and starts a new logical generation. The trajectory is never deleted: hidden material remains in the session log and can be inspected with retrospect. Treat this as editing the context, not as a scratch pad.",
        "SPANS. Cookie lines look like \"[xx% of context used][Plastic-Memories][cookie][N]\"; the percentage is a live context watermark. Use those numbers: \"3\" (one point), \"[3,4]\" (closed), \"(3,4)\" (open), \"[3,4)\" or \"(3,4]\" (one side excluded), or \"this\" (the assistant message that made this call plus all its tool results). Mixed forms such as \"[3,this]\" are allowed. Endpoints are unordered. Numbers that are no longer visible are rejected.",
        "An assistant message and its tool results form one unit. A span that cuts through such a unit is widened to the unit boundary, so no orphan call or result is left; the replaced range may therefore be larger than the span you named.",
        "OPS. Each op has spans and new_text. Every span is hidden except the last by position, which is replaced by new_text. An empty new_text is a pure hole (hide). One op may cover several disjoint ranges.",
        "TYPES. An op may include types=[...] (user, developer, assistant, error, letter) to restrict matching inside the span. user and developer match one message; assistant, error and letter match the whole unit (assistant message plus its tool results). Cookie messages never match, even as user or developer. Matched units are hidden; the last matched unit is replaced by new_text. If types is omitted, every message in the interval matches, cookies included.",
        "MODES. option:\"set\" previews and writes nothing. option:\"execute\" commits at the next submission boundary. Only ONE plasticize call is allowed per run_code program (or per assistant message); set and execute count the same. Do not issue two plasticize calls before the next boundary. also_execute_last_set is optional: when an execute call sets it true, the most recent unexecuted set is committed as well. A set result states whether this condition applies.",
        "lock_this:true locks the replacement message itself into the safety zone; default false.",
        "SAFETY ZONE. Locked messages cannot be reshaped. A span that intersects the safety zone fails and reports the locked region as cookie intervals; the user can unlock it with /plasticize unlock.",
        "AUTO-HIDE. After a successful execute, whole units (assistant message plus all its tool results) that contain a failed call to any Plastic Memories tool (plasticize, retrospect, letter) or a fulfilled plasticize(set) preview are auto-hidden. Other tools mixed into the same unit are hidden with it.",
        "WEAK OPERATION. spans [\"this\"] with an empty new_text as the ENTIRE operation hides only this call and its result; its net effect equals not making the call. A long run of cookie messages can indicate that this has happened repeatedly. Hiding this together with other spans is useful; to hide a target step, use its cookie interval.",
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
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
                  description: "Cookie ranges. Forms: '3' (one point), '[3,4]' closed, '(3,4)' open, '[3,4)' or '(3,4]' half-open, 'this' (the assistant message that made this call plus its tool results). A span cutting an assistant-message-plus-tool-results unit is widened to the unit boundary. Every span is hidden except the last, which is replaced by new_text.",
                },
                new_text: { type: 'string', description: 'Placed at the LAST span: the replacement message. Empty string = pure hole (hide). Earlier spans are hidden automatically.' },
                lock_this: { type: 'boolean', description: 'Default false. If true, lock the replacement message itself into the safety zone (it can never be reshaped afterwards).' },
                types: {
                  type: 'array',
                  items: { type: 'string', enum: ['user', 'developer', 'assistant', 'error', 'letter'] },
                  description: 'Optional type filter inside each resolved span: user/developer match one message; assistant/error/letter match the whole unit (assistant message + its tool results). Cookie messages never match, even as user/developer. Matched units are hidden; the last matched unit is replaced by new_text. If omitted, every message in the interval matches, cookies included.',
                },
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
            description: 'Optional with option:execute. When true, also commits the most recent unexecuted set.',
          },
        },
        required: ['ops', 'option'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const option = args?.option;
        if (option !== 'set' && option !== 'execute') throw new Error('option must be "set" or "execute"');
        if (option === 'set' && args?.also_execute_last_set === true) {
          throw new Error('also_execute_last_set is only valid with option:"execute"');
        }
        assertSinglePendingPlasticize(session, exec.callId);

        // 「本步整组」：容纳本次调用的 assistant 消息 … 它的全部工具结果。
        const group = stepGroupFor(session, exec);
        if (group === undefined) throw new Error('could not locate the assistant message carrying this call');
        const here = group.here;

        const parts = [];
        const batches = [];
        if (option === 'execute' && args?.also_execute_last_set === true) {
          const pending = findLastPendingSet(session);
          if (pending === undefined) parts.push('No unexecuted set to commit; also_execute_last_set was ignored.');
          else {
            // **零点属于写下这条 ops 的那条 plasticize（set）**，与 engine 的 flush 一致。
            // 预览与落实必须同源，否则「看过的」和「落实的」不是同一个。
            const pendingGroup = stepGroupFor(session, { callId: pending.callId });
            batches.push({
              from: 'previous set', callId: pending.callId, ops: pending.ops,
              here: pendingGroup === undefined ? here : pendingGroup.here,
            });
          }
        }
        batches.push({ from: 'this call', callId: exec.callId, ops: args?.ops, here });

        if (option === 'set') {
          const flat = [];
          for (const batch of batches) {
            const resolved = resolveOps(session, batch.ops, batch.here);
            assertResolvedUnlocked(session, resolved);
            flat.push(...resolved);
          }
          const pv = previewOf(session, flat, exec.callId);
          parts.push('Preview only (not committed). The next generation would contain ' + pv.messageCount + ' messages:');
          parts.push(pv.text);
          parts.push('To commit this preview, call plasticize with option:"execute" and also_execute_last_set:true while this is still the most recent unexecuted set. Otherwise rewrite ops completely, not incrementally.');
        } else {
          // 只登记：真正写入由 flush 在提交边界做（见 engine.js 的说明）。
          let total = 0;
          for (const batch of batches) {
            const resolved = resolveOps(session, batch.ops, batch.here);
            assertResolvedUnlocked(session, resolved);
            total += resolved.length;
          }
          parts.push('Registered ' + total + ' segment(s); they will be written at the next submission boundary.');
          const logicalGeneration = logicalGenerationForCall(session, exec.callId);
          parts.push('Logical generation ' + logicalGeneration + ' (pm-logical-generation=' + logicalGeneration + ').');
          for (const batch of batches) parts.push('  · ' + batch.from + ': ' + batch.ops.length + ' segment(s)');
        }
        return Promise.resolve({ text: parts.join(String.fromCharCode(10)) });
      },
    }),
  );


  ctx.tools.register(
    tool({
      name: 'retrospect',
      description: [
        "Read the context of one PAST logical generation. Pure read.",
        "Pass an absolute 0-based logical generation number or \"self - N\" (for example \"self - 1\", where self is the current logical generation number). The target must be less than self; the current generation is already visible and is rejected.",
        "A successful execute freezes logical generation N and returns N; continued reasoning belongs to generation N + 1, so generation N is immediately queryable with self - 1.",
        "Returns compact JSON: {logical, messages, count, letter}. Each message is {role, text, time}; each letter is {index, text, time}. index is the message position inside that generation when the letter was written. time is the log epoch-millisecond timestamp, useful for staleness checks.",
        "messages are that generation's surface context, replayed to that generation's last write. The material that generation hid belonged to the previous generation and is not included; read the previous generation to see it. Call once per generation; use a run_code program to iterate over several generations.",
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
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

  ctx.tools.register(
    tool({
      name: 'letter',
      description: [
        "Leave a note for future generations. This is not a message sent to them; it is a note intended for retrieval via retrospect. Inherit it only when it will not distort future generations: small stabilizations or hides may carry it forward; major rewrites or stale notes should not. Information that must guide future generations belongs in the shaping operations themselves.",
        "One plain-text letter per call. No side effects: no surfaceOp, no private data, no generation; the text exists only in this tool call's trajectory. Returns \"Registered.\" retrospect({generation}) returns that logical generation's letters in order, each with its in-generation message index and timestamp.",
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note to leave. One letter per call.' },
        },
        required: ['text'],
      },
      execute(args, exec) {
        sessionOf(exec);
        // Minimal English receipt.
        return Promise.resolve({ text: 'Registered.' });
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