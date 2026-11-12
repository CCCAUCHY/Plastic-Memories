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
import { previewOf, findLastPendingSet, normalizeOp } from './plasticize.js';
import { resolveUnitOps } from './unitops.js';
import { normalizeSelector, isLastSetMacro } from './opshape.js';
import { isThisSelector } from './units.js';
import { retrospect } from './retrospect.js';
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

/** ops 选填：缺省即 []（execute with [] 只兑现上一条 set）。 */
function normalizeOps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('ops must be an array');
  return value;
}

/** 取本次调用所属的 agent 会话。全局注册：任何 preset 都能用。 */
function sessionOf(exec) {
  const session = exec?.agent?.session;
  if (session === undefined || session === null) {
    throw new Error('this tool requires an agent session (exec.agent.session is unavailable)');
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
        '重塑你自己过去的呈现。它会改写模型当前看到的上下文，并开启一个新的逻辑世代；会话日志不会被删除，被隐藏的消息之后仍可用 retrospect 读回。把它当成编辑上下文，不是草稿纸。',
        '位置用 retrospect(self) 返回的单元号（0 起），系统提示是 unit 0。一条 assistant 消息连同它的全部工具结果算一个单元，工具结果不能单独选中。ops 是操作数组：每个操作给出一个选择器与一条替代文本，选择器命中的整段会被替代文本取代，替代文本为空即隐藏；要改多段就写多个操作。数组里还可以放 { "the last plasticize(set)": true }，它会在原位展开成上一条尚未提交的 set 的操作，只能出现一次。',
        'option:"set" 只返回预览，不写入；option:"execute" 在下一个提交边界生效。一次程序（或一条消息）只能调用一次 plasticize。',
        '安全区里的单元不能被重塑；命中安全区会失败并报出锁定范围，需要用户解锁。',
        '成功 execute 之后，早于它的单元如果包含失败的 Plastic Memories 调用、set 预览或成功的 letter，会被自动隐藏；execute 的回执保留。',
        '如果整个 ops 只有 [{ positions: "this" }] 且替代文本为空，就只隐藏这次调用本身，效果等于没有调用。',
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
      parameters: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            description: '必填且非空。元素是一条操作，或占位元素 { "the last plasticize(set)": true }（展开上一条未提交的 set；只能出现一次；set 不能用）。',
            items: {
              oneOf: [
                { type: 'string', const: 'the last plasticize(set)' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: { 'the last plasticize(set)': { type: 'boolean', const: true } },
                  required: ['the last plasticize(set)'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    positions: {
                      oneOf: [{ type: 'integer' }, { type: 'string' }],
                      description: "这条操作的选择器，只能填一个：unit 3、unit 3 to 7、this，或数字。",
                    },
                    new_text: { type: 'string', description: '替代文本；空表示隐藏。默认空。' },
                    lock_this: { type: 'boolean', description: 'true 时把替代文本本身放进安全区。默认 false。' },
                  },
                  required: ['positions'],
                },
              ],
            },
          },
          option: {
            type: 'string',
            enum: ['set', 'execute'],
            description: 'set 只预览；execute 在下一个提交边界生效。',
          },
          preview_positions: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: '仅 set 用：只预览这个选择器命中的单元。默认不过滤。',
          },
        },
        required: ['ops', 'option'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const option = args?.option;
        if (option !== 'set' && option !== 'execute') throw new Error('option must be "set" or "execute"');
        // 结果窗口：只返回这些单元的行，用来在非 PTC 模式里主动限制工具结果大小。
        const previewSelectors = normalizeSelector(args?.preview_positions, 'preview_positions');
        assertSinglePendingPlasticize(session, exec.callId);

        // 「本步整组」：容纳本次调用的 assistant 消息 … 它的全部工具结果。
        const group = stepGroupFor(session, exec);
        if (group === undefined) throw new Error('could not locate the assistant message carrying this call');
        const here = group.here;

        const parts = [];
        const ops = normalizeOps(args?.ops);
        const wantsReplay = ops.some((one) => isLastSetMacro(one));
        if (option === 'set' && wantsReplay) {
          throw new Error('option:"set" cannot replay the last set: a set must carry its own ops so it has something to preview');
        }
        const batch = { from: 'this call', callId: exec.callId, ops, here };

        if (option === 'set') {
          // set 的全部意义就是「给出一个可预览的下一代」；没有 op 就没有预览，属于非法调用。
          if (ops.length === 0) {
            throw new Error('option:"set" requires at least one op: a set with no ops has no preview to show.');
          }
          const flat = resolveUnitOps(session, batch.ops, batch.here);
          assertResolvedUnlocked(session, flat);
          const pv = previewOf(session, flat, exec.callId, { selectors: previewSelectors });
          const scope = previewSelectors === undefined ? '' : ' (showing units ' + (pv.units ?? []).join(', ') + ' of ' + pv.total + ')';
          parts.push('Preview only (not committed). The next generation would contain ' + pv.messageCount + ' messages' + scope + ':');
          parts.push(pv.text);
          parts.push('To commit this preview, call plasticize with option:"execute" while this is still the most recent unexecuted set; to commit it verbatim, call option:"execute" with ops:[{positions:["the last plasticize(set)"]}]; otherwise rewrite ops completely, not incrementally.');
        } else {
          // 只登记：真正写入由 flush 在提交边界做（见 engine.js 的说明）。
          let total = 0;
          const resolved = resolveUnitOps(session, batch.ops, batch.here);
          assertResolvedUnlocked(session, resolved);
          total += resolved.length;
          parts.push('Registered ' + total + ' segment(s); they will be written at the next submission boundary.');
          const logicalGeneration = logicalGenerationForCall(session, exec.callId);
          parts.push('Logical generation ' + logicalGeneration + ' (pm-logical-generation=' + logicalGeneration + ').');
          parts.push('  · ' + batch.from + ': ' + batch.ops.length + ' op(s)');
        }
        return Promise.resolve({ text: parts.join(String.fromCharCode(10)) });
      },
    }),
  );


  ctx.tools.register(
    tool({
      name: 'retrospect',
      description: [
        '读取某个逻辑世代的上下文。只读，不修改任何东西。',
        'generation 可以是绝对编号、self（当前世代）或 self - N。历史世代已经冻结；self 返回模型此刻看到的上下文。',
        '成功的 execute 会冻结当前世代并返回它的编号，之后的推理属于下一代，所以刚冻结的世代可以立刻用 self - 1 读到。',
        '返回 { logical, count, messages, letter? }。messages 每行对应一个单元的一部分：n 是行号，unit 是单元号，type 是来源类型，text 是内容；assistant 行可能带 calls，当前世代的行可能带 locked。preview=true 时裁剪 text。',
        '历史世代返回它冻结前模型最后一次收到的输入。某个世代隐藏掉的内容属于上一代，要看得读上一代。',
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
      parameters: {
        type: 'object',
        properties: {
          generation: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: '绝对编号、"self" 或 "self - N"。',
          },
          preview: {
            type: 'boolean',
            description: 'true 时裁剪每条 text。默认 false。',
          },
          result_positions: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: '只返回这个选择器命中的单元，并附 total 与 units；要看多段就多调一次。不接受 this。',
          },
        },
        required: ['generation'],
      },
      execute(args, exec) {
        const session = sessionOf(exec);
        const generation = args?.generation;
        const isSelf = typeof generation === 'string' && /^self(?:\s*-\s*0)?$/iu.test(generation.trim());
        // 结果窗口：命令里的 this 没有锚点，这里直接拒绝。
        const selectors = normalizeSelector(args?.result_positions, 'result_positions');
        if (selectors !== undefined && isThisSelector(selectors)) {
          throw new Error('result_positions 不能用 this：它指模型本次调用所在的单元，而 retrospect 读的是历史快照；请写具体单元号');
        }
        if (isSelf) return Promise.resolve({ text: JSON.stringify(retrospectMessages(session, args?.preview === true, selectors)) });
        return Promise.resolve({ text: retrospect(session, { ...args, positions: selectors }) });
      },
    }),
  );

  ctx.tools.register(
    tool({
      name: 'letter',
      description: [
        '给未来世代留一张便条。便条不会留在上下文里：成功调用后，这个单元会在下一次成功 execute 时被自动隐藏，之后只能用 retrospect 读回。',
        '每次调用一张纯文本。它不写上下文、不产生世代。需要影响未来世代的内容，应该写进塑形操作本身，而不是便条里。',
      ].join(String.fromCharCode(10) + String.fromCharCode(10)),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '便条内容，每次一张。' },
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