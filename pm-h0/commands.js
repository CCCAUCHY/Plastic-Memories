/**
 * Plastic Memories — 用户侧 slash 命令（单一入口）。
 *
 *   /plasticize <单元序号或[起,止]> <替代文本>  稳定化（文本原样，可含换行；空 = 隐藏）
 *   /plasticize hide <单元序号或[起,止]>  隐藏
 *   /plasticize lock <单元序号或[起,止]>  纳入安全区
 *   /plasticize unlock <单元序号或[起,止]>  移出安全区
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
import { parseOpText } from './opshape.js';
import { isThisSelector } from './units.js';

/** `this` 只有模型在 run_code 里调用时才有意义。 */
const THIS_HINT = '命令里不能用 this：它指模型本次工具调用所在的单元，只有模型在 run_code 里调用时才有；请写具体单元号，例如 unit 17';

const HINT = '<unit 17: 替代文本> 或 <unit 17 to 28: 替代文本> | hide/lock/unlock <选择器> | unlock all | prelock | clear';

/**
 * 解析 /plasticize 输入。
 * @param {string} rawInput - 命令名之后的全部输入。
 * @returns {{action:'clear'}|{action:'stage', kind:string, mode:string, interval?:string, newText?:string}}
 */
export function parsePlasticizeCommand(rawInput, locale = 'zh') {
  const en = locale === 'en';
  const hint = en ? '<unit 17: replacement> or <unit 17 to 28: replacement> | hide/lock/unlock <selector> | unlock all | prelock | clear' : HINT;
  const text = String(rawInput ?? '').replace(/^\s+/, '');
  const command = text.replace(/[ \t\r\n]+$/, '');
  if (command.length === 0) throw new Error((en ? 'Usage: /plasticize ' : '用法：/plasticize ') + hint);
  if (command === 'clear') return { action: 'clear' };
  if (command === 'prelock') return { action: 'stage', kind: 'lock', mode: 'prelock' };
  for (const kind of ['lock', 'unlock', 'hide']) {
    if (command !== kind && !command.startsWith(kind + ' ') && !command.startsWith(kind + '\t')) continue;
    const rest = command.slice(kind.length).trim();
    if (rest.length === 0) throw new Error(en ? '/plasticize ' + kind + ' must be followed by a unit or a range.' : '/plasticize ' + kind + ' 后必须是一个单元或区间。');
    if (rest === 'all') {
      if (kind !== 'unlock') throw new Error(en ? 'lock all is not supported; name units explicitly.' : 'lock all 已取消；请逐个指定单元。');
      return { action: 'stage', kind: 'unlock', mode: 'all', newText: '' };
    }
    if (isThisSelector(rest)) throw new Error(THIS_HINT);
    return { action: 'stage', kind: kind === 'hide' ? 'project' : kind, mode: 'range', positions: [rest], newText: '' };
  }

  // 投影与工具共用同一套 op 语法：<selector>: <new_text>；没有冒号就是纯隐藏。
  let op;
  try {
    op = parseOpText(text, { allowThis: false });
  } catch (error) {
    const message = String(error.message);
    // this 是语义错误，原样抛出（它自带解释）；其余按语法错误提示通用用法。
    if (message.includes('this')) throw error;
    if (message.includes('unit') || message.includes('选择器')) {
      throw new Error((en ? 'Write the selector, then a colon, then the replacement: /plasticize unit 17: text' : '选择器后面要用冒号接替代文本：/plasticize unit 17: 要写入的文本'));
    }
    throw new Error((en ? 'Usage: /plasticize ' : '用法：/plasticize ') + hint);
  }
  return { action: 'stage', kind: 'project', mode: 'range', positions: op.positions, newText: op.new_text };
}

/**
 * 把用户命令接到 `ctx.commands`（可选服务：没有命令面板的 profile 里安静缺席）。
 * @param {object} ctx - 插件上下文。
 * @param {object} [logger] - 日志器。
 */
export function registerCommands(ctx, logger) {
  const currentLocale = () => {
    try {
      const settings = ctx.get('settings');
      const forms = settings !== undefined && settings !== null && typeof settings.describe === 'function' ? settings.describe() : undefined;
      const form = Array.isArray(forms) ? forms.find((entry) => entry.ns === 'locale' || String(entry.ns).includes('locale')) : undefined;
      const preference = form?.user?.preference ?? form?.value?.preference;
      return preference === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  };
  ctx.inject(['commands'], (commandCtx) => {
    const locale = currentLocale();
    const en = locale === 'en';
    const hint = en ? '<unit 17: replacement> or <unit 17 to 28: replacement> | hide/lock/unlock <selector> | unlock all | prelock | clear' : HINT;
    const fail = (error) => ({ kind: 'error', text: String(error?.message ?? error) });
    const busyError = () => new Error(en ? 'Cannot run /plasticize while the model is running; wait for this inference to finish.' : '正在推理中，暂不能执行 /plasticize；请等本次推理结束后再试。');
    commandCtx.commands.register({
      name: 'plasticize',
      description: en ? '/plasticize <selector>: <replacement> | hide/lock/unlock <selector> | unlock all | prelock | clear' : '/plasticize <选择器>: <替代文本> | hide/lock/unlock <选择器> | unlock all | prelock | clear',
      input: { hint },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined || session === null) return fail(new Error(en ? 'This command needs a session.' : '这条命令需要一个会话'));
        if (agent.status !== 'idle') return fail(busyError());
        try {
          const parsed = parsePlasticizeCommand(rawInput, locale);
          if (parsed.action === 'clear') {
            const cleared = clearStagedOperations(session);
            return { kind: 'success', text: en ? 'Cleared ' + String(cleared) + ' staged operation(s).' : '已清空 ' + String(cleared) + ' 条待落盘操作。' };
          }
          const result = stageUserOperation(session, { ...parsed, comment: String(rawInput ?? '') });
          const what = en
            ? (parsed.mode === 'all'
              ? (parsed.kind === 'lock' ? 'include the whole current generation in the safety zone' : 'remove the whole current generation from the safety zone')
              : parsed.mode === 'prelock'
                ? 'include the next user message in the safety zone'
                : parsed.kind === 'lock' ? 'include in the safety zone' : parsed.kind === 'unlock' ? 'remove from the safety zone'
                  : 'stabilize/hide ' + (parsed.newText.length === 0 ? '(hide)' : JSON.stringify(parsed.newText.slice(0, 24))))
            : (parsed.mode === 'all'
              ? (parsed.kind === 'lock' ? '当前世代全部纳入安全区' : '当前世代全部移出安全区')
              : parsed.mode === 'prelock'
                ? '下一条用户消息纳入安全区'
                : parsed.kind === 'lock' ? '纳入安全区' : parsed.kind === 'unlock' ? '移出安全区'
                  : '稳定化/隐藏 ' + (parsed.newText.length === 0 ? '（隐藏）' : JSON.stringify(parsed.newText.slice(0, 24))));
          return {
            kind: 'success',
            text: en
              ? 'Registered: ' + what + '. ' + String(pendingUserOperations(session)) +
                ' staged operation(s); they are reduced and written when the next user message is sent; /plasticize clear clears them (in-memory state, lost on crash/shutdown).'
              : '已登记：' + what + '。待落盘 ' + String(pendingUserOperations(session)) +
                ' 条；发送下一条用户消息时约化并写入；/plasticize clear 可清空（内存状态，崩溃/关机丢失）。',
          };
        } catch (error) {
          return fail(error);
        }
      },
    });
  });
}