/**
 * PM · 世代视图回归：语法 → 世代内容。
 *
 * 性质（都只看 PM 语法，基线直接取 DSH 折叠出的消息）：
 *   P1  set 预览的行 == 语法描述的下一代
 *   P2  提交后 retrospect(self) 的行 == 语法描述的下一代
 *   P3  提交后 retrospect(self-1) 的行 == 提交前那一代
 */
import { makeCounter, makeStore, cookieSeed, openStep, plasticizeCall } from './testkit.mjs';
import { flush } from './engine.js';
import { retrospect } from './retrospect.js';
import { previewOf } from './plasticize.js';
import { resolveUnitOps } from './unitops.js';
import { rowsOfMessages, expectedRows, shapeOfRows } from './genview.mjs';

const { ok, done } = makeCounter('gentest');
const quiet = { warn() {}, info() {} };
const NL = String.fromCharCode(10);

const ctx = makeStore();
const session = ctx.sessions.create('gen-view', { seed: cookieSeed('subagent-95230f54.jsonl') });
openStep(session, 2, 1);

const baseRows = rowsOfMessages(session.deriveMessages());
const ops = [{ positions: 'unit 2', new_text: '⟨SYNTAX⟩' }];

// 预览：此时调用还没进日志，先算 set 预览。
const resolved = resolveUnitOps(session, ops, undefined);
const preview = previewOf(session, resolved, 'gen-preview');
const expectedBeforeCall = expectedRows(baseRows, ops);

console.log(NL + 'P1 set 预览 = 语法描述');
{
  const want = shapeOfRows(expectedBeforeCall);
  const got = shapeOfRows(preview.rows);
  ok(JSON.stringify(got) === JSON.stringify(want), '预览与语法一致', JSON.stringify({ gotLen: got.length, wantLen: want.length, firstDiff: got.findIndex((line, index) => line !== want[index]) }).slice(0, 200));
}

// 提交
plasticizeCall(session, { turn: 2, step: 1 }, 'gen-exec', { ops, option: 'execute' });
flush(session, { openStep: { turn: 2, step: 1 } }, quiet);

const callRows = rowsOfMessages(session.deriveMessages()).slice(-2);
const expectedAfter = [...expectedRows(baseRows, ops), ...callRows];

console.log(NL + 'P2 retrospect(self) = 语法描述');
{
  // 真实读取发生在下一条 assistant 消息里；用它做截止点。
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
  const got = shapeOfRows(JSON.parse(retrospect(session, { generation: 'self', callId: 'retro-1' })).messages
    .map((row) => ({ unit: row.unit, text: row.text })));
  const want = shapeOfRows(expectedAfter);
  ok(JSON.stringify(got) === JSON.stringify(want), 'self 与语法一致', JSON.stringify({ gotLen: got.length, wantLen: want.length, firstDiff: got.findIndex((line, index) => line !== want[index]) }).slice(0, 200));
}

console.log(NL + 'P3 retrospect(self-1) = 提交前那一代');
{
  const got = shapeOfRows(JSON.parse(retrospect(session, { generation: 'self - 1' })).messages
    .map((row) => ({ unit: row.unit, type: row.type, text: row.text })));
  const want = shapeOfRows(baseRows);
  ok(JSON.stringify(got) === JSON.stringify(want), 'self-1 等于基线', JSON.stringify({ gotLen: got.length, wantLen: want.length, firstDiff: got.findIndex((line, index) => line !== want[index]) }).slice(0, 200));
}

done();
