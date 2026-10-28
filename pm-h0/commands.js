/**
 * Plastic Memories — 用户侧 slash 命令（单一入口）。
 *
 *   /plasticize <区间> <替代文本>    稳定化（替代文本原样，可含换行；空 = 隐藏）
 *   /plasticize hide <区间>        隐藏
 *   /plasticize lock <区间>        纳入安全区
 *   /plasticize unlock <区间>      移出安全区
 *
 * 三类操作只要**区间互不重叠**就可交换，因此没有有序队列：
 *   每次命令只做重叠检测与安全区约束检查，然后加入待落盘集合；
 *   发送下一条用户消息时统一约化（合并同操作的连续区间）后写入日志。
 *
 * 安全区是纯日志回放；稳定化/隐藏会写入一条逻辑世代私有记录，使逻辑世代 +1。
 * 待落盘集合是进程内状态，不发送用户消息就不会落盘；崩溃/关机丢失。
 *
 * 推理进行中（agent.status !== 'idle'）不允许执行本命令。
 *
 * @module dsh-plugin-plastic-memories-h0/commands
 */

import { stageUserOperation } from './engine.js';

const HINT = '<区间> <替代文本> | hide <区间> | lock <区间> | unlock <区间>';

/**
 * 解析 /plasticize 输入。
 * @param {string} rawInput - 命令名之后的全部输入。
 * @returns {{action:'stage', kind:'lock'|'unlock'|'project', interval:string, newText:string}}
 */
export function parsePlasticizeCommand(rawInput) {
  const text = String(rawInput ?? '').replace(/^\s+/, '');
  if (text.length === 0) throw new Error('用法：/plasticize ' + HINT);
  for (const kind of ['lock', 'unlock', 'hide']) {
    if (text !== kind && !text.startsWith(kind + ' ') && !text.startsWith(kind + '\t')) continue;
    const match = new RegExp('^' + kind + '[ \t]+(\\S+)[ \t]*$').exec(text);
    if (match === null) throw new Error('/plasticize ' + kind + ' 后必须是一个区间。');
    return { action: 'stage', kind: kind === 'hide' ? 'project' : kind, interval: match[1], newText: '' };
  }
  const match = /^(\S+)[ \t\r\n]+([\s\S]*)$/.exec(text);
  if (match === null) throw new Error('用法：/plasticize ' + HINT + '（替代文本可以含换行；隐藏请用 hide）');
  return { action: 'stage', kind: 'project', interval: match[1], newText: match[2] };
}

/**
 * 把用户命令接到 `ctx.commands`（可选服务：没有命令面板的 profile 里安静缺席）。
 * @param {object} ctx - 插件上下文（preset/agent 作用域）。
 * @param {object} [logger] - 日志器。
 */
export function registerCommands(ctx, logger) {
  ctx.inject(['commands'], (commandCtx) => {
    const fail = (error) => ({ kind: 'error', text: String(error?.message ?? error) });
    const busyError = () => new Error('正在推理中，暂不能执行 /plasticize；请等本次推理结束后再试。');
    commandCtx.commands.register({
      name: 'plasticize',
      description: '/plasticize <区间> <替代文本> | hide <区间> | lock <区间> | unlock <区间>（发送下一条消息时落盘）',
      input: { hint: HINT },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined || session === null) return fail(new Error('这条命令需要一个会话'));
        if (agent.status !== 'idle') return fail(busyError());
        try {
          const parsed = parsePlasticizeCommand(rawInput);
          const result = stageUserOperation(session, parsed.kind, parsed.interval, parsed.newText);
          const label = parsed.kind === 'lock' ? '纳入安全区' : parsed.kind === 'unlock' ? '移出安全区' : '稳定化/隐藏';
          return {
            kind: 'success',
            text: '已登记' + label + '：区间 ' + parsed.interval + '（' + String(result.shadowed.length) + ' 条消息）。' +
              '待落盘 ' + String(result.pending) + ' 条；发送下一条用户消息时约化并写入，崩溃/关机丢失。',
          };
        } catch (error) {
          return fail(error);
        }
      },
    });
  });
}
