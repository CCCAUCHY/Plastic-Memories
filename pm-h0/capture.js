/**
 * 只读抓取：把模型实际收到的 messages 数组追加到 JSONL。
 *
 * 挂在 llm/stream waterfall 上，只观察 options，不修改、不消费流；
 * 写文件是唯一副作用，失败只告警一次，绝不影响请求。
 *
 * @module capture
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * @param {string} value - session id。
 * @returns {string} 可安全用作文件名的字符串。
 */
function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
}

/**
 * 创建一个按 session 串行追加的抓取器。
 *
 * @param {{dir?: string, logger?: object}} [options] - 目录（相对 session cwd）与日志器。
 * @returns {(session: object, request: object) => Promise<void>} 抓取函数。
 */
export function createMessageCapture(options = {}) {
  const directory = typeof options.dir === 'string' && options.dir.length > 0 ? options.dir : '.pm-capture';
  const logger = options.logger;
  let warned = false;
  const warnOnce = (error) => {
    if (warned) return;
    warned = true;
    logger?.warn?.('[pm-h0] message capture failed: ' + String(error?.message ?? error));
  };
  return (session, request) => {
    const cwd = typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd();
    const targetDir = isAbsolute(directory) ? directory : resolve(cwd, directory);
    const target = join(targetDir, safeSegment(session?.id ?? 'session') + '.jsonl');
    try {
      const line = JSON.stringify({
        time: Date.now(),
        sessionId: session?.id ?? null,
        sessionSeq: Number.isSafeInteger(session?.seq) ? session.seq : null,
        provider: request?.provider ?? null,
        model: request?.model ?? null,
        messageCount: Array.isArray(request?.messages) ? request.messages.length : 0,
        messages: request?.messages ?? null,
      }) + String.fromCharCode(10);
      mkdirSync(targetDir, { recursive: true });
      appendFileSync(target, line, 'utf8');
    } catch (error) {
      try {
        mkdirSync(targetDir, { recursive: true });
        appendFileSync(join(targetDir, '_capture-errors.log'), JSON.stringify({ time: Date.now(), message: String(error?.message ?? error) }) + String.fromCharCode(10));
      } catch { /* diagnostics only */ }
      warnOnce(error);
    }
    return Promise.resolve();
  };
}