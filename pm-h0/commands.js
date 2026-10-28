/**
 * Plastic Memories — 用户侧 slash 命令（单一入口）。
 *
 *   /plasticize <区间> <替代文本>    稳定化（文本原样，可含换行；空 = 隐藏）
 *   /plasticize hide <区间>        隐藏
 *   /plasticize lock <区间>        纳入安全区
 *   /plasticize unlock <区间>      移出安全区
 *   /plasticize lock all           当前世代全部轨迹纳入安全区
 *   /plasticize unlock all         当前世代全部轨迹移出安全区
 *   /plasticize prelock             下一条用户消息（触发落盘的那条）纳入安全区
 *   /plasticize clear               清空当前全部待落盘操作
 *
 * 三类操作只要区间互不重叠就可交换；重叠检测与工具共用 overlap.js。
 * 安全区/逻辑世代都以私有事件写入日志；待落盘集合是进程内状态，发送消息时才落盘。
 *
 * @module dsh-plugin-plastic-memories-h0/commands
 */

import { clearStagedOperations, pendingUserOperations, stageUserOperation } from './engine.js';

const HINT = '<区间> <替代文本> | hide <区间> | lock <区间> | lock all | unlock <区间> | unlock all | prelock | clear';

/**
 * 解析 /plasticize 输入。
 * @param {string} rawInput - 命令名之后的全部输入。
 * @returns {{action:'clear'}|{action:'stage', kind:string, mode:string, interval?:string, newText?:string}}
 */
export function parsePlasticizeCommand(rawInput) {
  const text = String(rawInput ?? '').replace(/^\s+/, '');
  if (text.length === 0) throw new Error('用法：/plasticize ' + HINT);
  if (text === 'clear') return { action: 'clear' };
  if (text === 'prelock') return { action: 'stage', kind: 'lock', mode: 'prelock' };
  if (text === 'lock all' || text === 'lock\tall') return { action: 'stage', kind: 'lock', mode: 'all' };
  if (text === 'unlock all' || text === 'unlock\tall') return { action: 'stage', kind: 'unlock', mode: 'all' };
  for (const kind of ['lock', 'unlock', 'hide']) {
    if (text !== kind && !text.startsWith(kind + ' ') && !text.startsWith(kind + '\t')) continue;
    const match = new RegExp('^' + kind + '[ \t]+(\\S+)[ \t]*$').exec(text);
    if (match === null) throw new Error('/plasticize ' + kind + ' 后必须是一个区间（或 all）。');
    return { action: 'stage', kind: kind === 'hide' ? 'project' : kind, mode: 'range', interval: match[1], newText: '' };
  }
  const match = /^(\S+)[ \t\r\n]+([\s\S]*)$/.exec(text);
  if (match === null) throw new Error('用法：/plasticize ' + HINT);
  return { action: 'stage', kind: 'project', mode: 'range', interval: match[1], newText: match[2] };
}

/**
 * 把用户命令接到 `ctx.commands`（可选服务：没有命令面板的 profile 里安静缺席）。
 * @param {object} ctx - 插件上下文。
 * @param {object} [logger] - 日志器。
 */
export function registerCommands(ctx, logger) {
  ctx.inject(['commands'], (commandCtx) => {
    const fail = (error) => ({ kind: 'error', text: String(error?.message ?? error) });
    const busyError = () => new Error('正在推理中，暂不能执行 /plasticize；请等本次推理结束后再试。');
    commandCtx.commands.register({
      name: 'plasticize',
      description: '/plasticize <区间> <替代文本> | hide/lock/unlock <区间> | lock all | unlock all | prelock | clear',
      input: { hint: HINT },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined || session === null) return fail(new Error('这条命令需要一个会话'));
        if (agent.status !== 'idle') return fail(busyError());
        try {
          const parsed = parsePlasticizeCommand(rawInput);
          if (parsed.action === 'clear') {
            const cleared = clearStagedOperations(session);
            return { kind: 'success', text: '已清空 ' + String(cleared) + ' 条待落盘操作。' };
          }
          const result = stageUserOperation(session, parsed);
          const what = parsed.mode === 'all'
            ? (parsed.kind === 'lock' ? '当前世代全部纳入安全区' : '当前世代全部移出安全区')
            : parsed.mode === 'prelock'
              ? '下一条用户消息纳入安全区'
              : parsed.kind === 'lock' ? '纳入安全区' : parsed.kind === 'unlock' ? '移出安全区'
                : '稳定化/隐藏 ' + (parsed.newText.length === 0 ? '（隐藏）' : JSON.stringify(parsed.newText.slice(0, 24)));
          return {
            kind: 'success',
            text: '已登记：' + what + '。待落盘 ' + String(pendingUserOperations(session)) +
              ' 条；发送下一条用户消息时约化并写入；/plasticize clear 可清空（内存状态，崩溃/关机丢失）。',
          };
        } catch (error) {
          return fail(error);
        }
      },
    });
  });
}
