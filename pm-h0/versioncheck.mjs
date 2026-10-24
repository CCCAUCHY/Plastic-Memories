/**
 * 版本号一致性检查。
 *
 * 版本号写在三个地方，它们必须一致：
 *   1. package.json 的 version
 *   2. presets/pm.patch.yml 里 preset 的 name（UI 会话模式列表显示的那一行）
 *   3. presets/pm.patch.yml 里 persona.suffix 正文开头的标记（模型上下文里能看到）
 *
 * 为什么值得一条测试：加载侧判断"跑的是不是新版"最省事的办法就是看名字，
 * 一旦三处漂移，那个判断就会骗人 —— 而这正是我们花了好几轮对账想避免的事。
 *
 * 运行：node versioncheck.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from '/var/data/.npm/_npx/1e7f6d9597241db0/node_modules/js-yaml/index.js';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (extra === undefined ? '' : '  → ' + extra)); } };

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (d) => ({ __js: d }) });
const doc = yaml.load(readFileSync(fileURLToPath(new URL('./presets/pm.patch.yml', import.meta.url)), 'utf8'), {
  schema: yaml.DEFAULT_SCHEMA.extend([JsTag]),
});
const cfg = doc[0].insert[0].config;

console.log('\n① package.json 与 preset.name 的版本号一致');
{
  ok(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version), 'package.json version 是语义化版本', pkg.version);
  const m = /v(\d+\.\d+\.\d+)/.exec(cfg.name ?? '');
  ok(m !== null, 'preset.name 里带 vX.Y.Z', String(cfg.name));
  ok(m !== null && m[1] === pkg.version, 'preset.name 的版本 == package.json 的版本', (m ? m[1] : '?') + ' vs ' + pkg.version);
  ok(typeof cfg.description === 'string' && cfg.description.length > 20, 'preset.description 非空（UI 里会显示）');
}

console.log('\n② 提示词正文里的版本号一致');
{
  const persona = cfg.plugins.find((x) => x.id === 'persona');
  ok(persona !== undefined, 'preset 里有 persona 行');
  const suffix = persona?.config?.suffix ?? '';
  const m = /（PM 可塑记忆 v(\d+\.\d+\.\d+)）/.exec(suffix);
  ok(m !== null, 'persona.suffix 开头有版本标记', suffix.split(NL)[2] ?? '(空)');
  ok(m !== null && m[1] === pkg.version, '提示词里的版本 == package.json 的版本', (m ? m[1] : '?') + ' vs ' + pkg.version);
}

console.log('\n③ preset 结构未退化');
{
  ok(cfg.id === 'pm', 'preset id 是 pm', cfg.id);
  ok(cfg.order === 5, 'order 是 5', String(cfg.order));
  ok(Array.isArray(cfg.plugins) && cfg.plugins.length > 10, 'plugins 非空', String(cfg.plugins?.length));
  const comp = (cfg.plugins ?? []).filter((x) => String(x.id).includes('compact'));
  ok(comp.length === 0, '压缩组已移除（PM 是唯一 surface 改写者）', comp.map((x) => x.id).join(','));
  const sf = (cfg.plugins ?? []).find((x) => x.id === 'skill-filesystem');
  ok(sf !== undefined, 'skill-filesystem 仍在');
  const tp = (cfg.plugins ?? []).find((x) => x.id === 'tool-presentation');
  ok(tp?.config?.mode === 'ptc', 'tool-presentation.mode 仍是 ptc（不改成 both：直呼会越过 run_code 的安全限制）', String(tp?.config?.mode));
}

console.log('\n④ 版本号演进：行为代码改了就必须已经升过版本');
{
  // 这一条是「我忘了升版本号」的补丁：version 定成 0.1.0 之后连落 8 个提交（含三个真修复）
  // 而版本号纹丝不动，于是 UI 上完全分不出「能写坏日志的版本」和「修好的版本」。
  //
  // 判据是「版本号有没有比上一个 tag 新」，而不是「行为代码有没有改」—— 只看后者的话，
  // 升完版本号它仍然会报红（这个守护自己犯过这个错）。
  const { execFileSync } = await import('node:child_process');
  let lastTag;
  let changed = [];
  try {
    lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim();
    changed = execFileSync('git', ['diff', '--name-only', lastTag + '..HEAD'], { encoding: 'utf8' })
      .trim().split(NL).filter(Boolean);
    ok(true, '上一个 tag：' + lastTag + '（之后改了 ' + changed.length + ' 个文件）');
  } catch {
    ok(true, '尚无 tag —— 发版时打 tag 即可启用演进检查');
  }
  if (lastTag !== undefined) {
    const tagVersion = lastTag.replace(/^v/, '');
    const behavioral = changed.filter((f) => f === 'engine.js' || f === 'index.js' || f === 'coords.js' || f.startsWith('presets/'));
    const advanced = pkg.version !== tagVersion;
    ok(behavioral.length === 0 || advanced,
      advanced
        ? '版本号 ' + pkg.version + ' 已比 tag ' + lastTag + ' 新，可发版'
        : '行为代码改了但版本号没升（tag ' + lastTag + '，当前 ' + pkg.version + '）',
      advanced ? '' : behavioral.join(', '));
  }
}
console.log('\n⑤ 打包完整性：所有被 import 的本地模块都必须在 files 里');
{
  // 这条是「本地全绿、装到 profile 就 ERR_MODULE_NOT_FOUND」的补丁。
  // files 决定 npm/pnpm 打包内容；测试跑在源码目录里，看不见这个缺口。
  // 新增模块时忘了加 files，本地 229 条断言会全绿，装上去却直接崩。
  const runtimeModules = ['index.js', 'engine.js', 'coords.js', 'schema.js', 'markers.js'];
  const imported = new Set();
  for (const mod of runtimeModules) {
    let source;
    try { source = readFileSync(new URL('./' + mod, import.meta.url), 'utf8'); } catch { continue; }
    for (const m of source.matchAll(/from '\.\/([^']+)'/g)) imported.add(m[1]);
  }
  const missing = [...imported].filter((f) => !pkg.files.includes(f));
  ok(missing.length === 0, '被 import 的本地模块都在 files 里（共 ' + imported.size + ' 个）', missing.join(', '));
  const entry = ['index.js', 'engine.js', 'schema.js', 'markers.js'].filter((f) => !pkg.files.includes(f));
  ok(entry.length === 0, '入口与核心模块都在 files 里', entry.join(', '));
}
console.log('\n══════════════════════════════════════');
console.log(NL + '⑥ 文档里的版本号必须与 package.json 一致');
{
  // 这条守护的由来：README / 测试脚本 / 交接文档里的版本号各漂过一次，
  // 每次都是用户或偶然发现。版本号存在的唯一意义就是区分「哪一版」，漂了就失去意义。
  //
  // 踩过的坑：这里原本用 new URL('.', import.meta.url).pathname ——
  // 它给出的是 **URL 编码**路径（工作区名含中文 → %E5%8F%AF...），读不到文件；
  // 而外面套了 try/catch 把 ENOENT 吞掉，于是守护**静默失效**（故意改坏版本号都不报）。
  // 现在：用 fileURLToPath，且**读不到就报错**，不许跳过。
  const docs = [
    ['README.md', new URL('./README.md', import.meta.url)],
    ['PM-机械测试脚本.md', new URL('../PM-机械测试脚本.md', import.meta.url)],
    ['H0-交接.md', new URL('../H0-交接.md', import.meta.url)],
    ['安装-web2.md', new URL('../安装-web2.md', import.meta.url)],
  ];
  const stale = [];
  const unreadable = [];
  let checked = 0;
  for (const [label, url] of docs) {
    let text;
    try {
      text = readFileSync(fileURLToPath(url), 'utf8');
      checked++;
    } catch (e) {
      unreadable.push(label + ' (' + String(e.code) + ')');
      continue;
    }
    // 正则必须匹配**任意**版本号，不能写死 0.5 ——
// 写死时它会漏掉「被改成别的版本」的情况，守护形同虚设（踩过）。
    const found = new Set(text.match(/v?[0-9]+[.][0-9]+[.][0-9]+/g) ?? []);
    for (const v of found) {
      const norm = v.startsWith('v') ? v.slice(1) : v;
      if (norm !== pkg.version) stale.push(label + ' -> ' + v);
    }
  }
  ok(unreadable.length === 0, '四份文档都读得到（读不到说明路径解析坏了）', unreadable.join(', '));
  ok(checked === docs.length, '确实检查了 ' + docs.length + ' 份文档', String(checked));
  ok(stale.length === 0, '文档里的版本号都是 ' + pkg.version, stale.join(', '));
}

console.log(NL + '⑦ 安装元数据（标准 bundle 安装的前提）');
{
  // 兼容性由 engines.dsh 声明（DSH 在安装时就检查它）。
  // 不用 peerDependencies：本包没有 @deepseek-ai 运行时导入，而 peer 会让 pnpm
  // 在每次安装 link:/file: 依赖时都打一堆警告（实测），还会被 DSH 当作兼容性依据。
  ok(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0,
    'engines.dsh 声明了 DSH 兼容范围', String(pkg.engines?.dsh));
  ok(pkg.peerDependencies === undefined, '不声明 peerDependencies（零运行时依赖）');
  const patches = pkg.dsh?.bundle?.patch;
  const missing = Array.isArray(patches)
    ? patches.filter((rel) => !existsSync(fileURLToPath(new URL('./' + rel, import.meta.url))))
    : ['dsh.bundle.patch 缺失'];
  ok(missing.length === 0 && Array.isArray(patches) && patches.length > 0,
    'dsh.bundle.patch 指向的文件都存在（共 ' + (patches?.length ?? 0) + ' 个）', missing.join(', '));
}

console.log(NL + '⑧ 会话模式隔离 + 提示词变量安全');
{
  // ⑧-1 插件必须挂在 preset 的 plugins 里：preset 的行挂载在**会话作用域**，
  // 工具注册按作用域隔离；其他会话模式（带自动压缩）根本看不到 PM 工具。
  const plugins = cfg.plugins ?? [];
  const row = plugins.find((x) => x.id === 'plastic-memories-h0');
  ok(row !== undefined && row.name === 'dsh-plugin-plastic-memories-h0',
    'PM 插件挂在 preset 的 plugins 里（只在该会话模式加载）', JSON.stringify(row?.name));

  // ⑧-2 bundle 级 cordis.patch.yml 只允许 **UI 宿主行**（config.uiHost === true）：
  // 它不注册工具/命令、不改写 surface，只让浏览器发现 client 半身。
  // 任何没有 uiHost 标记的 bundle 级插件行都会让所有模式真正加载 PM —— 必须报红。
  const bundleDoc = yaml.load(readFileSync(fileURLToPath(new URL('./cordis.patch.yml', import.meta.url)), 'utf8'), {
    schema: yaml.DEFAULT_SCHEMA.extend([JsTag]),
  });
  const bundleRows = Array.isArray(bundleDoc)
    ? bundleDoc.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    : [];
  const nonUiRows = bundleRows.filter((item) => item?.name === pkg.name && item?.config?.uiHost !== true);
  ok(Array.isArray(bundleDoc) && nonUiRows.length === 0,
    'bundle 级 patch 里没有「完整宿主」插件行（否则其他模式也会加载 PM）', JSON.stringify(nonUiRows.map((x) => x.id)));
  const uiRow = bundleRows.find((item) => item?.config?.uiHost === true);
  ok(uiRow !== undefined && uiRow.name === pkg.name,
    'bundle 级 patch 有 UI 宿主行（config.uiHost=true）', JSON.stringify(uiRow?.id));
  ok(row?.config?.uiHost !== true,
    'preset 行是完整宿主（不是 uiHost 空壳）', JSON.stringify(row?.config ?? {}).slice(0, 60));

  // ⑧-3 提示词里只允许 provider / model 两个变量。
  // 实测：写 {{cwd}} 会让 PM 模式启动直接失败 ——「unknown prompt variable」。
  const persona = plugins.find((x) => x.id === 'persona');
  const personaText = JSON.stringify(persona?.config ?? {});
  const vars = [...personaText.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
  const allowed = new Set(['provider', 'model']);
  const bad = vars.filter((name) => !allowed.has(name));
  ok(bad.length === 0, '提示词变量只有 provider / model（{{cwd}} 之类会启动失败）', bad.join(', '));
}

console.log(NL + '⑨ 客户端半身（侧边栏世代视图）');
{
  // 客户端是手写的 loader bundle（window.__ModuleLoader__.load），不走构建工具。
  // 这几条守住「装进 profile 后浏览器真的能发现它」所需的全部声明。
  ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform 是 web', String(pkg.dsh?.client?.platform));
  const clientInject = pkg.dsh?.client?.inject;
  ok(Array.isArray(clientInject) && clientInject.length > 0,
    'dsh.client.inject 非空（声明加载顺序）', JSON.stringify(clientInject));
  ok(typeof pkg.exports?.['./client'] === 'string' || typeof pkg.exports?.['./client']?.default === 'string',
    'exports["./client"] 指向客户端 bundle', JSON.stringify(pkg.exports?.['./client']));
  const clientFile = fileURLToPath(new URL('./client.js', import.meta.url));
  ok(existsSync(clientFile) && pkg.files.includes('client.js'), 'client.js 存在且在 files 白名单里');
  ok(pkg.files.includes('generations.js') && pkg.files.includes('commands.js'),
    'generations.js / commands.js 在 files 白名单里');
  let clientCheckError;
  try {
    execFileSync(process.execPath, ['--check', clientFile], { stdio: 'pipe' });
  } catch (error) {
    clientCheckError = String(error?.stderr ?? error?.message ?? error).slice(0, 200);
  }
  ok(clientCheckError === undefined, 'client.js 通过 node --check', clientCheckError);

  // 客户端 = 私有化后的官方轨迹 bundle（trajectory-vendor.js 打补丁）+ glue。
  const { GENERATIONS_KEY } = await import('./generations.js');
  const clientSource = readFileSync(clientFile, 'utf8');
  ok(GENERATIONS_KEY === 'pmGenerations', 'host 世代投影键是 pmGenerations', GENERATIONS_KEY);
  ok(clientSource.includes(String(pkg.name)), '客户端 bundle id 是包名', String(pkg.name));
  ok(clientSource.includes('pm-trajectory-vendor'), 'client.js 内含 vendored 官方轨迹模块');
  ok(clientSource.length > 300000, 'client.js 包含完整轨迹页面（>300KB）', String(clientSource.length));

  // 私有化改名：与官方轨迹并存且互不干扰所需的全部 id。
  const required = [
    ['loader id', 'id: "pm-trajectory-vendor"'],
    ['target', 'target: "pmTrajectory"'],
    ['hook', 'hooks: ["pmTrajectory"]'],
    ['事件定义 kind', 'kind: "pmtrajectory-'],
    ['图片 slot', 'pmTrajectory.images'],
    ['视图 id', 'id: "pm-generations"'],
    ['视图 order', 'order: 9000,'],
    ['tab 标签', '"view.trajectory": "世代"'],
  ];
  for (const [label, needle] of required) ok(clientSource.includes(needle), '私有化：' + label + ' = ' + needle);
  const forbidden = [
    '@deepseek-ai/dsh-client-ui-trajectory',
    'target: "trajectory"',
    'id: "trajectory"',
    'conversation.trajectory.images',
    'useTrajectory',
    'kind: "trajectory-',
  ];
  const leftovers = forbidden.filter((needle) => clientSource.includes(needle));
  ok(leftovers.length === 0, '没有官方身份残留（不会和官方轨迹抢注册）', leftovers.join(', '));

  // PM 第一层图层：工具栏里的世代页码 + 按世代过滤快照的 bridge。
  const overlay = [
    ['页码 bridge', 'globalThis.__PM_UI__'],
    ['世代投影键', 'pmGenerations'],
    ['页码容器', 'data-pm-pages'],
    ['事件级过滤', 'isHiddenEvent'],
    ['定义包装', 'wrapDefinition'],
    ['定义重注册', 'pmDefinitionRegister'],
    ['重注册入口', 'installReregister'],
    ['已塑形标签', 'pm-reshaped-tag'],
    ['折叠面板', 'pm-reshape-panel'],
    ['已塑形识别', 'isReshapedCell'],
    ['已隐藏文本', '已隐藏'],
    ['快照缓存', 'wrapTargetSource'],
    ['按需装配', 'prepareSnapshot'],
    ['A形态注入', 'applyReshapeRecords'],
    ['展开态版本', 'reshapeVersion'],
    ['内嵌官方视图', 'pm-reshape-embed'],
    ['视图导出', 'pmTrajectoryView'],
    ['视图上下文', 'publishViewContext'],
    ['嵌入模式', '__pmEmbedded'],
  ];
  for (const [label, needle] of overlay) ok(clientSource.includes(needle), 'PM 图层：' + label + ' = ' + needle);

  // 生成物必须与 build-client.mjs 保持一致（改了 vendor 没重新 build 会报红）。
  let buildFresh = true;
  try {
    const before = readFileSync(clientFile, 'utf8');
    execFileSync(process.execPath, ['build-client.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' });
    buildFresh = readFileSync(clientFile, 'utf8') === before;
  } catch (error) {
    buildFresh = false;
  }
  ok(buildFresh, 'client.js 与 build-client.mjs 生成结果一致（未手改、未忘记重新 build）');

}

console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('══════════════════════════════════════');
process.exitCode = fail === 0 ? 0 : 1;