/**
 * 宿主模块解析器。
 *
 * 测试需要 DSH 的运行时包（cordis / dsh-session / dsh-tools …）。它们不在本仓库里，
 * 所以按下面的顺序找一份 DSH 检出：
 *
 *   1. 环境变量 DSH_CHECKOUT
 *   2. 本机 npx 缓存里的默认路径
 *   3. 本目录下的 node_modules（如果有人把 DSH 装在这里）
 *
 * 用法：DSH_CHECKOUT=/path/to/dsh npm test
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.DSH_CHECKOUT,
  '/var/data/.npm/_npx/1e7f6d9597241db0',
  new URL('.', import.meta.url).pathname + 'node_modules/..',
].filter((value) => typeof value === 'string' && value.length > 0);

async function load(pkg, entry = 'lib/index.js') {
  const tried = [];
  for (const base of CANDIDATES) {
    const path = join(base, 'node_modules', pkg, entry);
    tried.push(path);
    if (!existsSync(path)) continue;
    return import(path);
  }
  throw new Error('cannot locate ' + pkg + '; set DSH_CHECKOUT to a DSH checkout (tried: ' + tried.join(', ') + ')');
}

const cordis = await load('@deepseek-ai/cordis');
const session = await load('@deepseek-ai/dsh-session');
const systemPrompt = await load('@deepseek-ai/dsh-system-prompt');
const tools = await load('@deepseek-ai/dsh-tools');
const projection = await load('@deepseek-ai/dsh-session-projection');
const yamlModule = await load('js-yaml', 'index.js');

export const { Context } = cordis;
export const SessionStore = session.default;
export const { appendPluginRecord } = session;
export const SystemPrompt = systemPrompt.default;
export const ToolRuntime = tools.default;
export const { assertObjectJsonSchema, assertSupportedJsonSchema } = tools;
export const SessionProjectionRegistry = projection.default;
export const yaml = yamlModule.default;
