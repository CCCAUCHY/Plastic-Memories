/**
 * Plastic Memories — 用户侧 slash 命令。
 *
 * 用户不想（或不需要）经过模型，直接在输入框里用与工具**相同的语法**改写投影：
 *
 *   /plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"set"}
 *   /plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"execute"}
 *   /retrospect {"query":"PM-TEST-A","limit":10}
 *
 * 语义与工具完全一致（同一套 normalizeOp / resolveOps / previewOf / 写入格式）：
 * 命令只是**另一个调用者**，不维护第二套投影逻辑。
 *
 * 与工具唯一的结构性差异：命令没有「承载步骤」，所以 spans 不能用 "this"
 * （engine.executeUserCommand 会明确拒绝并给出提示）。
 *
 * @module dsh-plugin-plastic-memories-h0/commands
 */

import { retrospect } from './retrospect.js';
import { executeUserCommand } from './engine.js';

/** /plasticize 的用法提示。 */
const PLASTICIZE_HINT = '{"ops":[{"spans":["(3,4)"],"new_text":"替代文本"}],"option":"set"}';

/** /retrospect 的用法提示。 */
const RETROSPECT_HINT = '{"query":"关键词","limit":10}';

/**
 * 解析 /plasticize 的原始输入为工具同款的参数。
 * @param {string} rawInput - 命令名之后的全部输入。
 * @returns {{ops: Array<object>, option: 'set'|'execute'}} 参数。
 * @throws {Error} 输入不是合法 JSON 或字段不合法时。
 */
export function parsePlasticizeInput(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (text.length === 0) {
    throw new Error('缺少参数。用法：/plasticize ' + PLASTICIZE_HINT);
  }
  let args;
  try {
    args = JSON.parse(text);
  } catch {
    throw new Error('参数必须是 JSON（与工具参数同形）。用法：/plasticize ' + PLASTICIZE_HINT);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('参数必须是 JSON 对象。用法：/plasticize ' + PLASTICIZE_HINT);
  }
  if (!Array.isArray(args.ops) || args.ops.length === 0) {
    throw new Error('缺少非空 ops 数组。用法：/plasticize ' + PLASTICIZE_HINT);
  }
  // 与工具一致：option 缺省时按 set 处理（先看预览，避免手滑落实）。
  const option = args.option ?? 'set';
  if (option !== 'set' && option !== 'execute') {
    throw new Error('option 只能是 "set" 或 "execute"。');
  }
  return { ops: args.ops, option };
}

/**
 * 解析 /retrospect 的原始输入。
 * @param {string} rawInput - 命令名之后的全部输入。
 * @returns {object} retrospect 工具同款的参数。
 * @throws {Error} 输入为空时。
 */
export function parseRetrospectInput(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (text.length === 0) {
    throw new Error('缺少参数。用法：/retrospect ' + RETROSPECT_HINT);
  }
  if (!text.startsWith('{')) return { query: text };
  let args;
  try {
    args = JSON.parse(text);
  } catch {
    throw new Error('参数必须是 JSON 或纯关键词。用法：/retrospect ' + RETROSPECT_HINT);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('参数必须是 JSON 对象或纯关键词。用法：/retrospect ' + RETROSPECT_HINT);
  }
  if (typeof args.query !== 'string' || args.query.length === 0) {
    throw new Error('缺少 query。用法：/retrospect ' + RETROSPECT_HINT);
  }
  return args;
}

/**
 * 把用户命令接到 `ctx.commands`（可选服务：没有命令面板的 profile 里安静缺席）。
 * @param {object} ctx - 插件上下文（preset/agent 作用域 —— 命令因此只在该作用域可见）。
 * @param {object} [logger] - 日志器。
 */
export function registerCommands(ctx, logger) {
  ctx.inject(['commands'], (commandCtx) => {
    const fail = (error) => ({ kind: 'error', text: String(error?.message ?? error) });
    commandCtx.commands.register({
      name: 'plasticize',
      description: '改写自己会话的上下文投影（与 plasticize 工具同语法）',
      input: { hint: PLASTICIZE_HINT },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined || session === null) return fail(new Error('这条命令需要一个会话'));
        try {
          const { ops, option } = parsePlasticizeInput(rawInput);
          const result = executeUserCommand(session, ops, option, logger);
          return { kind: 'success', text: result.text };
        } catch (error) {
          return fail(error);
        }
      },
    });
    commandCtx.commands.register({
      name: 'retrospect',
      description: '查询已隐藏的原文（与 retrospect 工具同语法）',
      input: { hint: RETROSPECT_HINT },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined || session === null) return fail(new Error('这条命令需要一个会话'));
        try {
          return { kind: 'success', text: retrospect(session, parseRetrospectInput(rawInput)) };
        } catch (error) {
          return fail(error);
        }
      },
    });
  });
}
