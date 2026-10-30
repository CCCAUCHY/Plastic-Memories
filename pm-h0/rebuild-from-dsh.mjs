#!/usr/bin/env node
/**
 * rebuild-from-dsh.mjs —— 从当前 DSH 安装重建「不能 import 但依赖 DSH」的产物。
 *
 * 重建内容：
 *   1. presets/pm.patch.yml —— 以 dsh-web-app/presets/ptc.patch.yml 为基线，
 *      改 preset 身份、去掉 compaction 组、挂载 PM 插件；
 *   2. trajectory-vendor.js —— dsh-client-ui-trajectory 的 ./client 入口。
 *
 * 用法：
 *   node rebuild-from-dsh.mjs                 # 重建并 build-client
 *   node rebuild-from-dsh.mjs --check         # 只检查漂移，不写文件
 *   node rebuild-from-dsh.mjs --dsh-root DIR  # 指定 DSH @deepseek-ai 目录
 *
 * 入口变化时脚本会显式报错（找不到 ptc.patch.yml / ./client 导出），不会静默生成半成品。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const rootArgIndex = args.indexOf('--dsh-root');
const rootArg = rootArgIndex === -1 ? undefined : args[rootArgIndex + 1];

function fail(message) {
  console.error('[rebuild-from-dsh] ' + message);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function locateDshRoot() {
  const candidates = [];
  if (rootArg !== undefined) candidates.push(resolve(rootArg));
  if (process.env.DSH_ROOT !== undefined) candidates.push(resolve(process.env.DSH_ROOT));
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (bin.length > 0) {
      const real = realpathSync(bin);
      const marker = join('node_modules', '@deepseek-ai');
      const at = real.indexOf(marker);
      if (at >= 0) candidates.push(real.slice(0, at + marker.length));
    }
  } catch {
    // 继续尝试其它来源
  }
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(join(npmRoot, '@deepseek-ai'));
  } catch {
    // 继续尝试其它来源
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh', 'package.json'))) return candidate;
  }
  fail('cannot locate DSH install; pass --dsh-root <.../@deepseek-ai> or set DSH_ROOT');
}

function locatePtcPreset(dshRoot) {
  const direct = join(dshRoot, 'dsh-web-app', 'presets', 'ptc.patch.yml');
  if (existsSync(direct)) return direct;
  const dir = join(dshRoot, 'dsh-web-app', 'presets');
  if (!existsSync(dir)) fail('dsh-web-app/presets directory not found at ' + dir);
  const matches = readdirSync(dir).filter((name) => name.endsWith('.yml')).map((name) => join(dir, name))
    .filter((path) => readFileSync(path, 'utf8').includes('id: preset-ptc'));
  if (matches.length !== 1) fail('cannot identify the PTC preset (found ' + String(matches.length) + ' candidates in ' + dir + ')');
  return matches[0];
}


function derivePmPreset(ptcText, version) {
  const insertIndex = ptcText.indexOf('- insert:');
  if (insertIndex < 0) fail('PTC preset has no "- insert:" block; upstream preset structure changed');
  let body = ptcText.slice(insertIndex);
  body = body.replace('- id: preset-ptc', '- id: preset-pm');
  const configPattern = /^        id: ptc\n        order: \d+$/m;
  if (!configPattern.test(body)) fail('PTC preset config block changed (expected "id: ptc" + "order: N")');
  body = body.replace(configPattern,
    '        id: pm\n' +
    '        name: PM · 可塑记忆 v' + version + '\n' +
    '        description: >-\n' +
    '          以 ptc 为基线，去掉压缩组，并挂载 Plastic Memories 插件。\n' +
    '          模型可以主动改写自己过往的呈现方式：把已完成的工作压成结论、把无关段落隐去，底层轨迹一字不失（retrospect 可事后考古）。\n' +
    '        order: 5');
  const compactionStart = body.indexOf('          - id: compaction\n');
  if (compactionStart < 0) fail('PTC preset has no compaction block; baseline changed');
  const afterCompaction = body.slice(compactionStart + '          - id: compaction\n'.length);
  const nextEntry = afterCompaction.search(/^          - id: /m);
  if (nextEntry < 0) fail('cannot find the entry after the compaction block');
  const compactionBlock = body.slice(compactionStart, compactionStart + '          - id: compaction\n'.length + nextEntry);
  if (!compactionBlock.includes('compaction-basic') || !compactionBlock.includes('tool-result-pruner')) {
    fail('compaction block shape changed; refusing to remove blindly');
  }
  body = body.slice(0, compactionStart) + body.slice(compactionStart + '          - id: compaction\n'.length + nextEntry);
  const pmPlugin = [
    '          - id: plastic-memories-h0',
    '            name: dsh-plugin-plastic-memories-h0',
    '            config:',
    '              trace: false',
    '              probeImports: false',
    '              autoHide: true',
    '',
  ].join('\n');
  const toolPresentation = '          - id: tool-presentation\n';
  if (body.includes('          - id: plastic-memories-h0\n')) {
    // 已经包含：替换该块，保证配置是最新的。
    const start = body.indexOf('          - id: plastic-memories-h0\n');
    const rest = body.slice(start + '          - id: plastic-memories-h0\n'.length);
    const next = rest.search(/^          - id: /m);
    if (next < 0) fail('cannot find the entry after the PM plugin block');
    body = body.slice(0, start) + pmPlugin + body.slice(start + '          - id: plastic-memories-h0\n'.length + next);
  } else {
    if (!body.includes(toolPresentation)) fail('PTC preset has no tool-presentation entry; insertion point changed');
    body = body.replace(toolPresentation, pmPlugin + toolPresentation);
  }
  const header = [
    '# Agent preset pm：由 rebuild-from-dsh.mjs 从当前 DSH 的 PTC 基线生成。',
    '#',
    '# 与 ptc 的结构差异只有两处：',
    '#   1. 删除 compaction 组（PM 是会话内唯一的 surface 改写者，压缩会与它争用同一个 surface）；',
    '#   2. plugins 里增加 dsh-plugin-plastic-memories-h0（PM 工具）。',
    '#',
    '# 修改基线后请运行：node rebuild-from-dsh.mjs',
    '',
  ].join('\n');
  return header + body;
}

function locateTrajectoryClient(dshRoot) {
  const pkgDir = join(dshRoot, 'dsh-client-ui-trajectory');
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) fail('dsh-client-ui-trajectory package not found at ' + pkgDir);
  const pkg = readJson(pkgPath);
  const exportEntry = pkg.exports?.['./client'];
  const relative = typeof exportEntry === 'string' ? exportEntry : exportEntry?.default;
  if (typeof relative !== 'string' || relative.length === 0) {
    fail('dsh-client-ui-trajectory package.json has no ./client export; entry changed');
  }
  const file = join(pkgDir, relative.replace(/^\.\//, ''));
  if (!existsSync(file)) fail('trajectory client entry missing: ' + file);
  return { pkg, file };
}

const dshRoot = locateDshRoot();
const dshVersion = readJson(join(dshRoot, 'dsh', 'package.json')).version;
const version = readJson(join(here, 'package.json')).version;
const ptcPath = locatePtcPreset(dshRoot);
const ptcText = readFileSync(ptcPath, 'utf8');
const derivedPreset = derivePmPreset(ptcText, version);
const presetPath = join(here, 'presets', 'pm.patch.yml');
const currentPreset = readFileSync(presetPath, 'utf8');
const presetDrift = currentPreset !== derivedPreset;
const trajectory = locateTrajectoryClient(dshRoot);
const expectedVendor = readFileSync(trajectory.file);
const vendorPath = join(here, 'trajectory-vendor.js');
const currentVendor = readFileSync(vendorPath);
const vendorDrift = !currentVendor.equals(expectedVendor);

console.log('[rebuild-from-dsh] DSH ' + dshVersion + ' at ' + dshRoot);
console.log('[rebuild-from-dsh] PTC preset: ' + ptcPath);
console.log('[rebuild-from-dsh] trajectory client: ' + trajectory.file);
console.log('[rebuild-from-dsh] pm preset drift: ' + (presetDrift ? 'YES' : 'no'));
console.log('[rebuild-from-dsh] vendor drift: ' + (vendorDrift ? 'YES' : 'no'));

if (check) {
  if (presetDrift || vendorDrift) {
    console.error('[rebuild-from-dsh] drift detected; run: node rebuild-from-dsh.mjs');
    process.exit(1);
  }
  console.log('[rebuild-from-dsh] check OK');
  process.exit(0);
}

if (presetDrift) writeFileSync(presetPath, derivedPreset);
if (vendorDrift) writeFileSync(vendorPath, expectedVendor);
if (presetDrift || vendorDrift) {
  execFileSync(process.execPath, ['build-client.mjs'], { cwd: here, stdio: 'inherit' });
  execFileSync(process.execPath, ['versioncheck.mjs'], { cwd: here, stdio: 'inherit' });
  console.log('[rebuild-from-dsh] rebuilt preset/vendor and verified versioncheck');
} else {
  console.log('[rebuild-from-dsh] nothing to rebuild');
}