/**
 * 全局 bundle 注册冒烟：apply 必须在没有 PM preset 的普通 ctx 里注册工具和命令。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCounter, makeStore, cookieSeed } from './testkit.mjs';
import { apply } from './index.js';

const { ok, done } = makeCounter('globaltest');
const home = join(tmpdir(), 'pm-global-' + String(process.pid));
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const tools = [];
const definitions = [];
const commands = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined; },
  inject(names, callback) {
    if (names.includes('commands')) callback({ commands: { register(definition) { commands.push(definition.name); } } });
  },
  effect(effect) { try { return effect(); } catch { return undefined; } },
  on() { return () => {}; },
  tools: { register(definition) { tools.push(definition.name); definitions.push(definition); } },
  root: undefined,
};
apply(ctx, {});
ok(tools.includes('plasticize') && tools.includes('retrospect') && tools.includes('letter'), '全局注册三个工具', tools.join(','));
ok(commands.includes('plasticize'), '全局注册 /plasticize', commands.join(','));
ok(!tools.includes('undefined'), '没有空工具');

const store = makeStore();
const session = store.sessions.create('global-retro', { seed: cookieSeed('subagent-95230f54.jsonl') });
const retrospect = definitions.find((definition) => definition.name === 'retrospect');
let unitData;
try {
  const result = await retrospect.execute({ generation: 'self' }, { agent: { session } });
  unitData = JSON.parse(result.text);
} catch (error) {
  unitData = { error: String(error.message) };
}
ok(unitData.error === undefined && unitData.count > 0 && unitData.units[0].n === 0, 'staged retrospect(self) 返回单元数组', JSON.stringify(unitData).slice(0, 160));
ok(unitData.units !== undefined && unitData.units[0].type === 'system', '0 号单元是 system');
done();