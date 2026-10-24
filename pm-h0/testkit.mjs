/**
 * PM · 测试辅助。
 *
 * 把「造一个真实的 plasticize 调用」「造一份带 cookie 的夹具」这两件事收在一处 ——
 * 各个测试共用，免得每份都重复实现对日志形态的假设（那正是几次事故的温床）。
 *
 * @module dsh-plugin-plastic-memories-h0/testkit
 */

import { Context } from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
import SessionStore from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookieIdOf, cookieText } from './cookie.js';

const NL = String.fromCharCode(10);

/** 能产生模型可见消息的事件类型。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/** 断言计数器。 */
export function makeCounter(label) {
  let pass = 0;
  let fail = 0;
  const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra === undefined ? '' : '  → ' + extra)); }
  };
  const done = () => {
    console.log(NL + '══════════════════════════════════════');
    console.log('  通过 ' + pass + ' / 失败 ' + fail);
    console.log('══════════════════════════════════════');
    process.exitCode = fail === 0 ? 0 : 1;
  };
  void label;
  return { ok, done };
}

/** 造一个真实 SessionStore。 */
export function makeStore() {
  const ctx = new Context();
  new SessionStore(ctx);
  return ctx;
}

/** 读一份夹具（相对本文件）。 */
export function fixture(name) {
  const url = new URL('./fixtures/' + name, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8').trim().split(NL).map((l) => JSON.parse(l));
}

/** 用夹具 seed 一个会话。 */
export function seeded(ctx, id, name) {
  return ctx.sessions.create(id, { seed: fixture(name).filter((r) => r.type !== 'session') });
}

/** 取派生消息的拼接文本。 */
export function textOf(session) {
  return session.deriveMessages()
    .map((m) => m.content.map((b) => b.text ?? ('[' + b.name + ']')).join(''))
    .join(' | ');
}

/** 造一条 cookie 事件。 */
export function cookieEvent(id, time = Date.now()) {
  return {
    type: 'user/message',
    seq: 0,
    time,
    data: {
      id: 'ck-' + id,
      role: 'user',
      content: [{ type: 'text', text: cookieText(id) }],
      source: { kind: 'pm-cookie', v: 1, id },
    },
    surfaceOp: 'append',
  };
}

/**
 * 夹具 seed + **按生产规则插入的 cookie**（重排 seq）。
 *
 * 插入位置 = 每个「单元边界」之后：system / developer / user / message、
 * 无工具调用的 assistant/message、以及一组 tool/result 的**最后一条**之后。
 * 这样 cookie #k 就是第 k 个边界，测试可以用 `spanOfNodes` 在任意两个边界之间取区间。
 *
 * @param {string} name - 夹具文件名。
 * @returns {Array<object>} 事件数组（已重排 seq、含 cookie）。
 */
export function cookieSeed(name) {
  // session/title 用 messageSeqs **按下标**引用更早的 user/message；
  // 我们在中间插入 cookie 会重排 seq，下标就指错（实测：宿主校验器报
  // "messageSeqs must cite distinct earlier human user/message events"）。
  // 生产里 cookie 只追加在队尾，不会重排，所以这只影响测试 seed —— 直接去掉标题事件。
  const raw = fixture(name).filter((r) => r.type !== 'session'
    && r.type !== 'session/title'
    && r.type !== 'session/title-llm-request');
  const events = [];
  const pending = new Set();
  let cookieId = 0;
  for (const event of raw) {
    events.push({ ...event, seq: events.length });
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool-call') continue;
          const callId = block.id ?? block.callId;
          if (typeof callId === 'string' && callId.length > 0) pending.add(callId);
        }
      }
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId;
      if (typeof callId === 'string') pending.delete(callId);
    }
    if (!SURFACE_TYPES.has(event.type)) continue;
    if (pending.size > 0) continue;
    cookieId += 1;
    events.push({ ...cookieEvent(cookieId, event.time), seq: events.length });
  }
  return events;
}

/** 用 cookieSeed 起一个会话。 */
export function cookieSession(ctx, id, name = 'subagent-95230f54.jsonl') {
  return ctx.sessions.create(id, { seed: cookieSeed(name) });
}

/**
 * 工作面下标 / cookie 节点 / 区间文本。
 * @param {object} session - 目标会话。
 * @returns {Array<{index: number, seq: number, id: number}>} 工作面上的 cookie（按位置）。
 */
export function cookieNodes(session) {
  const nodes = [...session.surface.nodes];
  const out = [];
  nodes.forEach((seq, index) => {
    const id = cookieIdOf(session.eventAt(seq));
    if (id !== undefined) out.push({ index, seq, id });
  });
  return out;
}

/**
 * 造一个 **spans 文本**，正好覆盖工作面下标 `[from, to]` 的节点（不含两侧 cookie）。
 * @param {object} session - 目标会话。
 * @param {number} from - 起始下标（含）。
 * @param {number} to - 结束下标（含）。
 * @returns {string} 形如 `(3,7)`。
 */
export function spanOfNodes(session, from, to) {
  const cs = cookieNodes(session);
  const left = [...cs].reverse().find((c) => c.index < from);
  const right = cs.find((c) => c.index > to);
  if (left === undefined || right === undefined) {
    throw new Error('spanOfNodes: ' + from + '..' + to + ' 找不到两侧的 cookie 边界');
  }
  return '(' + left.id + ',' + right.id + ')';
}

/** 单个节点（`[from,to]` 收紧成同一个下标）。 */
export function spanOfNode(session, index) {
  return spanOfNodes(session, index, index);
}

/** 闭区间：把两侧的 cookie 也包进来。 */
export function spanIncludingNodes(session, from, to) {
  const cs = cookieNodes(session);
  const left = [...cs].reverse().find((c) => c.index <= from);
  const right = cs.find((c) => c.index >= to);
  if (left === undefined || right === undefined) {
    throw new Error('spanIncludingNodes: ' + from + '..' + to + ' 找不到 cookie 边界');
  }
  return '[' + left.id + ',' + right.id + ']';
}

/**
 * 在工作面上开一个新 turn/step。
 * @param {object} session - 目标会话。
 * @param {number} turn - turn 号。
 * @param {number} step - step 号。
 */
export function openStep(session, turn, step) {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step });
}

/**
 * 在**当前打开的 step** 里追加一条真实的 plasticize 调用 + 它的工具结果。
 *
 * turn/step 必须与当前打开的一致，否则读侧校验会拒绝。
 * @param {object} session - 目标会话。
 * @param {{turn: number, step: number}} at - 当前打开的 turn/step。
 * @param {string} callId - 调用 id。
 * @param {object} args - plasticize 参数。
 * @returns {{declSeq: number, resultSeq: number}} 事件 seq。
 */
export function plasticizeCall(session, at, callId, args, options = {}) {
  const declSeq = session.append('assistant/message', {
    turn: at.turn, step: at.step,
    message: {
      id: 'am-' + callId, role: 'assistant', source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: callId, name: options.name ?? 'plasticize', arguments: JSON.stringify(args) }],
    },
    stream: [],
  }, { surfaceOp: 'append' }).seq;
  // **必须有 tool/call 记账**：真实运行时在 assistant 与 result 之间写它。
  // 缺了它，读侧会把这个调用当成「被声明但从未开始」，去读 data.error 然后报
  // not-started error requires an object。
  session.append('tool/call', {
    turn: at.turn, step: at.step, callId,
    name: options.name ?? 'plasticize', arguments: JSON.stringify(args),
  });
  const resultSeq = session.append('tool/result', {
    turn: at.turn, step: at.step,
    message: {
      id: 'tr-' + callId, role: 'tool', toolCallId: callId,
      content: [{ type: 'text', text: options.resultText ?? 'ok' }],
      isError: options.isError === true,
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' }).seq;
  return { declSeq, resultSeq };
}

/**
 * 找当前工作面上的平衡切口下标（before=0 且 after=0）。
 * @param {object} session - 目标会话。
 * @param {Function} pairingMaps - coords 的 pairingMaps。
 * @returns {number[]} 下标列表。
 */
export function balancedIndexes(session, pairingMaps) {
  const nodes = [...session.surface.nodes];
  const pm = pairingMaps(session);
  const out = [];
  nodes.forEach((seq, i) => {
    if (pm.before.get(seq) === 0 && pm.after.get(seq) === 0) out.push(i);
  });
  return out;
}
