#!/usr/bin/env node
/**
 * 修复旧日志：给 plugin:plastic-memories/* 事件补上 ignorable 标记。
 *
 * 背景：这些事件最初用 session.append 写入，envelope 里没有 ignorable:true；
 * 不认识该类型的宿主会拒绝加载整份日志（"unknown to this harness and not marked ignorable"）。
 * 现在写入已改走 appendPluginRecord；这个脚本只处理历史文件。
 *
 * 用法：node repair-ignorable.mjs <session.v4.jsonl.zstd> [...]
 * 会在同目录留一份 .bak。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const PREFIX = 'plugin:plastic-memories/';
let fixed = 0;
for (const path of process.argv.slice(2)) {
  const raw = zstdDecompressSync(readFileSync(path)).toString('utf8');
  const lines = raw.split('\n');
  let touched = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let event;
    try { event = JSON.parse(line); } catch { return line; }
    if (typeof event?.type !== 'string' || !event.type.startsWith(PREFIX)) return line;
    if (event.ignorable === true) return line;
    event.ignorable = true;
    touched += 1;
    return JSON.stringify(event);
  });
  if (touched === 0) { console.log(path, '无需修复'); continue; }
  copyFileSync(path, path + '.bak');
  writeFileSync(path, zstdCompressSync(Buffer.from(out.join('\n'), 'utf8')));
  fixed += touched;
  console.log(path, '修复事件', touched);
}
console.log('总计', fixed);
