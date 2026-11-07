/**
 * 通用版版本/打包一致性检查。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/js-yaml/index.js';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (extra === undefined ? '' : '  → ' + extra)); } };
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (d) => ({ __js: d }) });

console.log(NL + '① package.json');
ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '语义化版本', pkg.version);
ok(Array.isArray(pkg.dsh?.bundle?.patch), 'dsh.bundle.patch 存在');

console.log(NL + '② bundle patch 通用化');
{
  const doc = yaml.load(readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([JsTag]) });
  const rows = Array.isArray(doc) ? doc.flatMap((entry) => entry.insert ?? []) : [];
  const pm = rows.find((row) => row.id === 'plastic-memories-ui');
  ok(pm !== undefined, 'bundle 里有全局插件行');
  ok(pm?.config?.uiHost !== true, '不再是 uiHost 空壳', JSON.stringify(pm?.config));
  ok(!pkg.dsh.bundle.patch.some((entry) => String(entry).includes('presets/')), '不安装 PM preset', JSON.stringify(pkg.dsh.bundle.patch));
}

console.log(NL + '③ 打包完整性');
{
  const runtimeModules = ['index.js', 'engine.js', 'coords.js', 'schema.js', 'markers.js', 'units.js', 'unitops.js', 'unitretro.js', 'boundaries.js', 'safetyreplay.js'];
  const imported = new Set();
  for (const mod of runtimeModules) {
    let source;
    try { source = readFileSync(new URL('./' + mod, import.meta.url), 'utf8'); } catch { continue; }
    for (const match of source.matchAll(/from '\.\/([^']+)'/g)) imported.add(match[1]);
  }
  const missing = [...imported].filter((file) => !pkg.files.includes(file));
  ok(missing.length === 0, '被 import 的本地模块都在 files 里（共 ' + imported.size + ' 个）', missing.join(', '));
  for (const entry of ['index.js', 'engine.js', 'units.js', 'unitops.js', 'unitretro.js', 'boundaries.js', 'safetyreplay.js']) {
    ok(pkg.files.includes(entry), 'files 包含 ' + entry);
  }
}

console.log(NL + '④ 文档版本一致');
{
  const docs = ['README.md', '../README.md', '../PM-机械测试脚本.md', '../H0-交接.md'];
  let checked = 0;
  const stale = [];
  for (const rel of docs) {
    let text;
    try { text = readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { stale.push(rel + ' (unreadable)'); continue; }
    checked += 1;
    for (const match of text.matchAll(/0\.\d+\.\d+/g)) if (match[0] !== pkg.version) stale.push(rel + ':' + match[0]);
  }
  ok(checked === docs.length, '四份文档都读得到', String(checked));
  ok(stale.length === 0, '文档版本都是 ' + pkg.version, stale.slice(0, 8).join(', '));
}

console.log(NL + '══════════════════════════════════════');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('══════════════════════════════════════');
process.exitCode = fail === 0 ? 0 : 1;
