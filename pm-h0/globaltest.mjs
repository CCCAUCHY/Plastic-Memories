/**
 * 全局 bundle 注册冒烟：apply 必须在没有 PM preset 的普通 ctx 里注册工具和命令。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCounter } from './testkit.mjs';
import { apply } from './index.js';

const { ok, done } = makeCounter('globaltest');
const home = join(tmpdir(), 'pm-global-' + String(process.pid));
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const tools = [];
const commands = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined; },
  inject(names, callback) {
    if (names.includes('commands')) callback({ commands: { register(definition) { commands.push(definition.name); } } });
  },
  effect(effect) { try { return effect(); } catch { return undefined; } },
  on() { return () => {}; },
  tools: { register(definition) { tools.push(definition.name); } },
  root: undefined,
};
apply(ctx, {});
ok(tools.includes('plasticize') && tools.includes('retrospect') && tools.includes('letter'), '全局注册三个工具', tools.join(','));
ok(commands.includes('plasticize'), '全局注册 /plasticize', commands.join(','));
ok(!tools.includes('undefined'), '没有空工具');
done();
