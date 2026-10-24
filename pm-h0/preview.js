/**
 * PM · 预览。
 *
 * **走宿主管线纯计算，不碰真日志。**
 *
 * 做法：用 session.constructor.create(id, events) **静态直建**一个影子 session，
 * seed = 真实事件 + 假想事件。折叠由宿主自己做 —— 我们不复刻任何折叠逻辑，
 * 所以宿主换了折叠实现、加了新的 surfaceOp 形态，预览自动跟上。
 *
 * 为什么不用 ctx.sessions.create()：它会把自己注册进 store，每次预览留一个垃圾会话。
 * 静态 create 不经过 store（已实测：store 条目数不变、真日志 seq 不变、世代不变）。
 *
 * 为什么不用 foldSurface()：它在 @deepseek-ai/dsh-session 里，而 profile 解析不到那个包；
 * session.constructor 是运行时拿到的句柄，不引入任何 import。
 *
 * @module dsh-plugin-plastic-memories-h0/preview
 */

import { clip, derivedMessage, messageText } from './coords.js';

const NL = String.fromCharCode(10);
let shadowCounter = 0;

/**
 * 在一个影子会话上折叠「真实事件 + 假想事件」，返回下一代工作面的消息。
 * @param {object} session - 真实会话（**只读**）。
 * @param {Array<object>} hypothetical - 假想的 surface 事件。
 * @returns {{messages: Array<object>, generation: number}} 影子结果。
 */
export function projectNext(session, hypothetical) {
  const events = [...session.snapshotEvents(), ...hypothetical];
  const shadow = session.constructor.create(
    'pm-preview-' + String(++shadowCounter),
    JSON.parse(JSON.stringify(events)),
  );
  const messages = [];
  for (const seq of shadow.surface.nodes) {
    const message = derivedMessage(shadow, shadow.eventAt(seq));
    if (message !== undefined) messages.push(message);
  }
  return { messages, generation: shadow.surface.replaceGeneration };
}

/**
 * 把下一代工作面渲染成**给模型看的**预览文本。
 *
 * 每条消息用「<开头文本>……<结尾文本>」呈现；**自适应**：短消息整条显示，不省略。
 * @param {Array<object>} messages - 影子工作面的消息。
 * @param {{head?: number, tail?: number}} [opt] - 截断参数。
 * @returns {string} 预览正文。
 */
export function renderPreview(messages, opt = {}) {
  const head = opt.head ?? 100;
  const tail = opt.tail ?? 60;
  const lines = [];
  messages.forEach((message, index) => {
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    lines.push('  #' + index + ' [' + String(message.role) + '] ' + clip(text, head, tail));
  });
  return lines.join(NL);
}
