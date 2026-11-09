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
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerCommands } from './commands.js';
import { GENERATIONS_KEY, generationProjection } from './generations.js';
import { stepGroup, surfaceNodes } from './coords.js';
import { resolveOps, previewOf, findLastPendingSet, normalizeOp } from './plasticize.js';
import { resolveUnitOps } from './unitops.js';
import { retrospect } from './retrospect.js';
import { retrospectUnits } from './unitretro.js';
import { retrospectMessages } from './messages.js';
import { replayCompactedSafety } from './safetyreplay.js';
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
const KNOWN_CONFIG_KEYS = new Set(['trace', 'autoHide', 'uiHost', 'captureMessages', 'captureDir']);

/**
 * Profile 级状态目录：$DSH_HOME/profiles/<profile>/.pm。
 * profileDir 从 host 的 pluginPackages resolution 读取；测试/无该服务时返回 undefined。
 * @param {object} ctx - 插件上下文。
 * @returns {string|undefined} .pm 目录。
 */
function profileHomes() {
  const homes = new Set();
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) homes.add(process.env.DSH_HOME);
  try { homes.add(join(homedir(), '.dsh')); } catch { /* no home */ }
  try {
    const apps = join(homedir(), '.var', 'app');
    for (const entry of readdirSync(apps, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(apps, entry.name, 'data', '.dsh');
      if (existsSync(candidate)) homes.add(candidate);
    }
  } catch { /* no flatpak dirs */ }
  return [...homes];
}
function profileStateCandidates() {
  const pluginDir = (() => {
    try { return realpathSync(fileURLToPath(new URL('.', import.meta.url))); } catch { return undefined; }
  })();
  const out = [];
  for (const home of profileHomes()) {
    const profilesDir = join(home, 'profiles');
    let entries;
    try { entries = readdirSync(profilesDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileDir = join(profilesDir, entry.name);
      if (pluginDir !== undefined) {
        try {
          const linked = realpathSync(join(profileDir, 'node_modules', 'dsh-plugin-plastic-memories-h0'));
          if (linked !== pluginDir) continue;
        } catch { continue; }
      }
      out.push(profileDir);
    }
  }
  return out;
}
export function resolveProfileStateDir(ctx) {
  let profileDir;
  try {
    const fromService = ctx.get('pluginPackages')?.resolution?.profileDir;
    if (typeof fromService === 'string' && fromService.length > 0) profileDir = fromService;
  } catch { /* fallback below */ }
  if (profileDir === undefined) {
    const candidates = profileStateCandidates();
    const preferred = process.env.DSH_PROFILE === undefined ? undefined : candidates.find((candidate) => candidate.endsWith('/' + process.env.DSH_PROFILE));
    if (preferred !== undefined) profileDir = preferred;
    else if (candidates.length === 1) profileDir = candidates[0];
  }
  if (profileDir === undefined) return undefined;
  try {
    const stateDir = join(profileDir, '.pm');
    mkdirSync(stateDir, { recursive: true });
    return stateDir;
  } catch {
    return undefined;
  }
}
/**
 * Write .pm/status.json once at startup so the user can verify which profile config was read.
 * @param {string} stateDir - .pm directory.
 * @param {object} options - resolved config.
 * @param {string} captureDir - capture destination.
 */
function writeStateStatus(stateDir, options, captureDir) {
  try {
    let version = null;
    try { version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { /* optional */ }
    writeFileSync(join(stateDir, 'status.json'), JSON.stringify({
      time: Date.now(),
      version,
      role: options.uiHost === true ? 'ui-host' : 'preset',
      captureMessages: options.captureMessages,
      captureDir,
      configFile: join(stateDir, 'config.json'),
    }, null, 2) + String.fromCharCode(10));
    if (options.captureMessages) mkdirSync(captureDir, { recursive: true });
  } catch { /* diagnostics only */ }
}

/**
 * 读取 profile 的 .pm/config.json；只接受用户可调键。
 * @param {string} stateDir - .pm 目录。
 * @param {object} logger - ctx.logger。
 * @returns {object} 用户覆盖项。
 */
export function readProfileUserConfig(stateDir, logger) {
  const filename = join(stateDir, 'config.json');
  if (!existsSync(filename)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger?.warn?.('[pm-h0] .pm/config.json must be a JSON object');
      return {};
    }
    const allowed = new Set(['trace', 'autoHide', 'captureMessages', 'captureDir']);
    const out = {};
    for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) {
        logger?.warn?.('[pm-h0] .pm/config.json ignores unknown key ' + JSON.stringify(key));
        continue;
      }
      out[key] = parsed[key];
    }
    return out;
  } catch (error) {
    logger?.warn?.('[pm-h0] failed to read .pm/config.json: ' + String(error?.message ?? error));
    return {};
  }
}

/**
 * 归一化配置。
 * @param {object|undefined} raw - patch 行里的 config。
 * @param {object} logger - ctx.logger。
 * @returns {{trace: boolean, autoHide: boolean, uiHost: boolean, captureMessages: boolean, captureDir: string}} 配置。
 */
function normalizeConfig(raw, logger) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) logger?.warn?.('[pm-h0] 未知配置键 ' + JSON.stringify(key) + '（已忽略）');
  }
  return {
    trace: cfg.trace === true,
    // 默认开：execute 成功时顺手隐藏报错的 PM 步骤组与成功的 set 步骤组（见 engine.js）。
    autoHide: cfg.autoHide !== false,
    // UI 宿主行（bundle 级）：只注册世代投影并让浏览器发现客户端半身；
    // 不注册工具/命令 —— 那是 PM 会话模式（preset 行）的事。
    uiHost: cfg.uiHost === true,
    // 调试选项（默认关闭）：把每次真实请求的 messages 追加到 profile 的 .pm/captures/<sessionId>.jsonl。
    captureMessages: cfg.captureMessages === true,
    captureDir: typeof cfg.captureDir === 'string' ? cfg.captureDir : '',
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
  const preset = session.header?.agentPreset;
  if (typeof preset === 'string' && preset !== 'ptc') {
    throw new Error('Plastic Memories requires the PTC preset (current preset: ' + preset + '); retrospect unit lookup depends on run_code filtering');
  }
  return session;
}

/**
 * 安装插件。
 * @param {object} ctx - 插件上下文。
 * @param {object|undefined} config - patch 行里的 config。
 */
export function apply(ctx, config) {
  const stateDir = resolveProfileStateDir(ctx);
  const userConfig = stateDir === undefined ? {} : readProfileUserConfig(stateDir, ctx.logger);
  const options = normalizeConfig({ ...config, ...userConfig }, ctx.logger);
  const baseDir = stateDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pm');
  const captureDir = options.captureDir.length === 0
    ? join(baseDir, 'captures')
    : (isAbsolute(options.captureDir) ? options.captureDir : resolve(baseDir, options.captureDir));
  if (stateDir !== undefined) writeStateStatus(stateDir, options, captureDir);

  // 通用模式：不再要求 PM preset；bundle 行直接注册工具、命令、投影。
  // 旧分支仍可通过 old 分支找回 PM 会话模式。

  if (options.captureMessages) {
    const capture = createMessageCapture({ dir: captureDir, logger: ctx.logger });
    const eventCtx = ctx.root ?? ctx;
    const listener = (request, next) => {
      try {
        appendFileSync(join(captureDir, '_events.log'), JSON.stringify({
          time: Date.now(),
          sessionId: typeof request?.sessionId === 'string' ? request.sessionId : null,
          messageCount: Array.isArray(request?.messages) ? request.messages.length : null,
        }) + String.fromCharCode(10));
        const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined;
        if (sessionId !== undefined) {
          let session = { id: sessionId, header: {} };
          try {
            const sessions = ctx.get?.('sessions');
            const found = sessions?.get?.(sessionId);
            if (found !== undefined) session = found;
          } catch { /* fallback to request identity */ }
          void capture(session, request);
        }
      } catch (error) {
        ctx.logger?.warn?.('[pm-h0] message capture failed: ' + String(error?.message ?? error));
      }
      return next();
    };
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = eventCtx.on('llm/stream', listener, { global: true });
        return () => { if (typeof dispose === 'function') dispose(); };
      });
    } else {
      eventCtx.on('llm/stream', listener, { global: true });
    }
  }

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

  ctx.on(
    'agent/request',
    async (payload, next) => {
      await safeFlush(payload?.agent?.session, 'request', payload);
      try { replayCompactedSafety(payload?.agent?.session, payload); } catch (error) { ctx.logger?.warn?.('[pm-h0] safety replay failed: ' + String(error?.message ?? error)); }
      checkSurfaceConsistency(payload?.agent?.session);
      return next();
    },
    { prepend: true },
  );

  // turn 末的兜底：只挂 agent/request 会漏掉「模型在本 turn 最后一个动作里调用 PM」。
  ctx.on('agent/turn-stopping', (payload) => {
    void safeFlush(payload?.agent?.session, 'turn-stopping', payload);
    try { replayCompactedSafety(payload?.agent?.session, payload); } catch (error) { ctx.logger?.warn?.('[pm-h0] safety replay failed: ' + String(error?.message ?? error)); }
    checkSurfaceConsistency(payload?.agent?.session);
  });

  // ── 工具 ────────────────────────────────────────────────────────────────

  ctx.tools.register(
    tool({
      name: 'plasticize',
      description: [
        "Reshape how your own past appears in this context. This is the only tool that changes the surface and starts a new logical generation. The trajectory is never deleted: hidden material remains in the session log and can be inspected with retrospect. Treat this as editing the context, not as a scratch pad.",
        "POSITIONS. Use the 0-based unit numbers returned by retrospect(self) or shown in the Generation tab. The system prompt is unit 0. An assistant message and its tool results are one unit; tool results are not addressed separately. Forms: 3, '[3,7]', 'this'. Hidden units are no longer part of the current generation and cannot be targeted.",
        "OPS. Each op has positions and new_text. Every selected unit is hidden except the last by position, which is replaced by new_text. An empty new_text is a pure hole (hide). One op may cover several disjoint ranges.",
        "MODES. option:\"set\" previews and writes nothing. option:\"execute\" commits at the next submission boundary. Only ONE plasticize call is allowed per run_code program (or per assistant message); set and execute count the same. Do not issue two plasticize calls before the next boundary. also_execute_last_set defaults to true: an execute commits the most recent unexecuted set as well; pass false to leave it pending. The field is not valid on set. A set result states whether committing is available.",
        "lock_this:true locks the replacement message itself into the safety zone; default false.",
        "SAFETY ZONE. Locked messages cannot be reshaped. A span that intersects the safety zone fails and reports the locked region as cookie intervals; the user can unlock it with /plasticize unlock.",
        "AUTO-HIDE. After a successful execute, whole units (assistant message plus all its tool results) written before that execute are auto-hidden when they contain a failed call to any Plastic Memories tool (plasticize, retrospect, letter), any plasticize(set) preview (fulfilled or not), or any successful letter. Other tools mixed into the same unit are hidden with it. The execute receipt itself remains visible.",
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
                positions: {
                  type: 'array',
                  items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
                  description: "Current-generation unit numbers (0 = system prompt). Forms: 3, '[3,7]', 'this'. Every selected unit is hidden except the last, which is replaced by new_text. Tool results are part of the assistant unit and are not addressed separately.",
                },
                spans: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Deprecated migration form: cookie ranges. Use positions.',
                },
                new_text: { type: 'string', description: 'Default: "" (pure hole/hide). Placed at the LAST span: the replacement message. Earlier spans are hidden automatically.' },
                lock_this: { type: 'boolean', description: 'Default false. If true, lock the replacement message itself into the safety zone (it can never be reshaped afterwards).' },
                types: {
                  type: 'array',
                  items: { type: 'string', enum: ['user', 'developer', 'assistant', 'error', 'letter'] },
                  description: 'Default: [] (no filter). Type filter inside each resolved span: user/developer match one message; assistant/error/letter match the whole unit (assistant message + its tool results). Cookie messages never match, even as user/developer. Matched units are hidden; the last matched unit is replaced by new_text. If omitted or empty, every message in the interval matches, cookies included.',
                },
              },
              // positions 是新语法；spans 保留给旧测试/迁移期，工具层二选一校验。
              required: [],
            },
          },
          option: {
            type: 'string',
            enum: ['set', 'execute'],
            description: 'Required. set = preview only, writes nothing. execute = commit at the next boundary.',
          },
          also_execute_last_set: {
            type: 'boolean',
            description: 'Default true. Only valid with option:execute. When true, also commits the most recent unexecuted set; set false to leave it pending.',
          },
        },
        required: ['ops', 'option'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const option = args?.option;
        if (option !== 'set' && option !== 'execute') throw new Error('option must be "set" or "execute"');
        if (option === 'set' && args?.also_execute_last_set !== undefined) {
          throw new Error('also_execute_last_set is only valid with option:"execute"');
        }
        assertSinglePendingPlasticize(session, exec.callId);

        // 「本步整组」：容纳本次调用的 assistant 消息 … 它的全部工具结果。
        const group = stepGroupFor(session, exec);
        if (group === undefined) throw new Error('could not locate the assistant message carrying this call');
        const here = group.here;

        const parts = [];
        const batches = [];
        if (option === 'execute' && args?.also_execute_last_set !== false) {
          const pending = findLastPendingSet(session);
          if (pending !== undefined) {
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
            const resolved = resolveBatchOps(session, batch.ops, batch.here);
            assertResolvedUnlocked(session, resolved);
            flat.push(...resolved);
          }
          const pv = previewOf(session, flat, exec.callId);
          parts.push('Preview only (not committed). The next generation would contain ' + pv.messageCount + ' messages:');
          parts.push(pv.text);
          parts.push('To commit this preview, call plasticize with option:"execute" while this is still the most recent unexecuted set; it is committed automatically unless also_execute_last_set:false. Otherwise rewrite ops completely, not incrementally.');
        } else {
          // 只登记：真正写入由 flush 在提交边界做（见 engine.js 的说明）。
          let total = 0;
          for (const batch of batches) {
            const resolved = resolveBatchOps(session, batch.ops, batch.here);
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
        "Read the context of a logical generation, past or current. Pure read.",
        "Pass an absolute 0-based logical generation number, \"self\" (the current generation), or \"self - N\" (for example \"self - 1\"). Past generations are frozen; self returns the current surface as the model sees it now.",
        "A successful execute freezes logical generation N and returns N; continued reasoning belongs to generation N + 1, so generation N is immediately queryable with self - 1.",
        "Returns {logical,count,messages,letter?}. messages are compact model-context rows: {n,unit,type,text,calls?,locked?}; n is order, unit is the plasticize position, type is system/user/developer/assistant/tool/agent/skill/other. preview=true clips text.",
        "Historical generations return the input of the request that produced their execute call. The generation that hid material belongs to the previous generation; read the previous generation to see it.",
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
      parameters: {
        type: 'object',
        properties: {
          generation: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: 'Required. Logical generation: absolute number (e.g. 3), "self" (current), or "self - N" (e.g. "self - 1").',
          },
          preview: {
            type: 'boolean',
            description: 'Default false. When true, clip message text.',
          },
          units: {
            type: 'boolean',
            description: 'Internal migration flag: when true, return current-generation units with 0-based n.',
          },
        },
        required: ['generation'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const generation = args?.generation;
        const isSelf = typeof generation === 'string' && /^self(?:\s*-\s*0)?$/iu.test(generation.trim());
        if (args?.units === true) return Promise.resolve({ text: retrospectUnits(session, args ?? {}) });
        if (isSelf) return Promise.resolve({ text: JSON.stringify(retrospectMessages(session, args?.preview === true)) });
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
          text: { type: 'string', description: 'Required. The note to leave. One letter per call.' },
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
  function resolveBatchOps(session, ops, here) {
    return Array.isArray(ops) && ops.some((op) => op !== null && typeof op === 'object' && Object.hasOwn(op, 'positions'))
      ? resolveUnitOps(session, ops, here)
      : resolveOps(session, ops, here);
  }

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