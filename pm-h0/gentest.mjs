/**
 * PM · 世代视图回归：预览 ≡ 结果，历史 = 提交前。
 *
 * 两条性质都跨实现比对：
 *   P1  set 预览的行（影子会话 fold）== 提交后 retrospect(self) 的开头若干行（前缀 fold）
 *   P2  retrospect(self - 1) 的行 == 提交前那一段前缀 fold 的行
 */
import { makeCounter, makeStore, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';
import { retrospect } from './retrospect.js';
import { previewOf } from './plasticize.js';
import { resolveUnitOps } from './unitops.js';
import { rowsAt, cutoffForCall } from './messages.js';

const { ok, done } = makeCounter('gentest');
const quiet = { warn() {}, info() {} };
const NL = String.fromCharCode(10);
const shape = (rows) => rows.map((row) => String(row.unit) + '|' + String(row.text ?? ''));

const ctx = makeStore();
const session = ctx.sessions.create('gen-view', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(session, 2, 1);

const OPS = [{ positions: 'unit 2', new_text: '⟨SYNTAX⟩' }];

// —— set 时刻：调用已在日志里（assistant 消息），结果还没写。
session.append('assistant/message', {
  turn: 2, step: 1,
  message: {
    id: 'am-set', role: 'assistant',
    source: { kind: 'model', provider: 'q', model: 'd' },
    content: [{ type: 'tool-call', id: 'set-1', name: 'plasticize', arguments: '{}' }],
  },
  stream: [],
}, { surfaceOp: 'append' });

const baseRows = rowsAt(session, cutoffForCall(session, 'set-1')).window.rows;
const originalText = String(baseRows[2].text);
const preview = previewOf(session, resolveUnitOps(session, OPS, undefined), 'set-1');
const previewShape = shape(preview.rows);

console.log(NL + 'P1 预览 = 提交后的开头若干行');
{
  // 补上 set 的结果，然后真正提交一次 execute。
  session.append('tool/call', { turn: 2, step: 1, callId: 'set-1', name: 'plasticize', arguments: '{}' });
  session.append('tool/result', {
    turn: 2, step: 1,
    message: { id: 'tr-set', role: 'tool', toolCallId: 'set-1', content: [{ type: 'text', text: 'Preview only' }], isError: false, source: { kind: 'tool', callId: 'set-1' } },
  }, { surfaceOp: 'append' });
  plasticizeCall(session, { turn: 2, step: 1 }, 'exec-1', { ops: OPS, option: 'execute' });
  flush(session, { openStep: { turn: 2, step: 1 } }, quiet);

  // 下一轮：模型发起 retrospect(self)
  openStep(session, 3, 1);
  session.append('assistant/message', {
    turn: 3, step: 1,
    message: {
      id: 'am-retro', role: 'assistant',
      source: { kind: 'model', provider: 'q', model: 'd' },
      content: [{ type: 'tool-call', id: 'retro-1', name: 'retrospect', arguments: '{}' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });

  const self = JSON.parse(retrospect(session, { generation: 'self', callId: 'retro-1' })).messages;
  const selfShape = shape(self);
  ok(JSON.stringify(selfShape.slice(0, previewShape.length)) === JSON.stringify(previewShape),
    '提交后的开头若干行 == 预览', JSON.stringify({ preview: previewShape.length, self: selfShape.length }).slice(0, 120));
  ok(selfShape.filter((line) => line.includes('⟨SYNTAX⟩')).length === 1, '替代文本只出现一次');
  ok(!selfShape.includes('2|' + originalText), '被替换的原文不再是 2 号单元');
}

console.log(NL + 'P2 历史 = 提交前的前缀');
{
  const execSeq = session.snapshotEvents()
    .filter((event) => event.type === 'assistant/message')
    .map((event) => event.seq)[2];
  void execSeq;
  const hist = JSON.parse(retrospect(session, { generation: 'self - 1' })).messages;
  const want = rowsAt(session, cutoffForCall(session, 'exec-1'), { selectors: undefined }).window.rows;
  ok(JSON.stringify(shape(hist)) === JSON.stringify(shape(want)), 'self-1 == 提交前的行', JSON.stringify({ got: hist.length, want: want.length }));
  ok(!shape(hist).some((line) => line.includes('⟨SYNTAX⟩')), 'self-1 里没有替代文本');
  ok(shape(hist).includes('2|' + originalText), 'self-1 里 2 号单元仍是原文');
}

done();
