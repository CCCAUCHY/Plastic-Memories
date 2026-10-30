# dsh-plugin-plastic-memories-h0

> 📌 交接与测试看工作区根目录的 [../H0-交接.md](../H0-交接.md) 与 [../PM-机械测试脚本.md](../PM-机械测试脚本.md)。

**Plastic Memories — H0 路线**：基于 `surfaceOp` 的可塑记忆投影（客户端 Surface）。

> Trajectory 是不可变的历史事实；Surface 是历史的可塑投影；Context 是 Surface 在模型输入中的具体存在形态。
> —— 这三层 DSH 已经内建（`Session.log` / `surface.nodes` / `deriveMessages()`）。
> 本插件**不发明机制**，只把已有机制从「只有压缩插件在用」变成「模型可以主动使用，并且能自指」。

---

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：两个工具 + 两个提交边界 + cookie 自动补插 |
| `engine.js` | 投影引擎：声明扫描、区间解析、配对平衡、延迟 flush、幂等、自动隐藏 |
| `cookie.js` | cookie 文本/编号/解析（**按 ID**，不按可见顺序） |
| `spans.js` | 区间语法：`"3"` / `[3,4]` / `(3,4)` / `this` |
| `coords.js` | 工作面访问 / 归一化 / 定位 / 本步整组 |
| `grouping.js` | 「多条消息组合才合法」的统一抽象（开集归零） |
| `plasticize.js` | 段落解析 + 预览 + 待决查找（不写日志） |
| `preview.js` | 影子 session 折叠（静态 create，真日志零污染） |
| `retrospect.js` | 只读查询，**只返回已隐藏的原文** |
| `markers.js` | 投影标记（幂等键 + 世代号） |
| `schema.js` | 参数校验（手工实现，零运行时依赖） |
| `presets/pm.patch.yml` | **PM 会话模式**：`ptc` − 压缩组 + 系统提示词里的 PM 协议 |

零 `@deepseek-ai` 运行时依赖（profile 的 `node_modules` 解析不到它们，实测 `ERR_MODULE_NOT_FOUND`），
全部能力从 `ctx` 与 `session` 对象上取。

---

## 安装

本包是一个**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 声明两个 patch 文件 ——
`cordis.patch.yml`（**故意为空**：不在 profile 级挂任何东西）与 `presets/pm.patch.yml`
（PM 会话模式；**插件行挂在这里**，因此只在 PM 模式下加载）。
安装只需要一条标准命令 —— 它会同时把依赖装进 profile 的 `node_modules`，
并把包名写进 `dsh.profile.bundles`（后者才是「启用」）。

工作区根目录的 [`install-pm.sh`](../install-pm.sh) 把这套流程包好了：

```bash
./install-pm.sh            # link 方式装进 web2（开发迭代用：改完代码冷启动即生效）
./install-pm.sh stage      # 构建 staged/<name>/（发布产物的稳定镜像）
./install-pm.sh staged-link# 一次性：把 web2 依赖指向 link:<staged 目录>（长期开发推荐）
./install-pm.sh pack       # 用 dist/*.tgz 装（冻结快照，可搬移/归档）
./install-pm.sh verify     # 校验（依赖 + bundles + 模块 import + dump-config + 启动冒烟）
./install-pm.sh repair     # 工作区改名/基线被重建后的修复
./install-pm.sh uninstall  # 卸载（依赖与 bundles 行一起移除）
```

等价的手工标准命令：

```bash
dsh plugin --profile web2 add link:/绝对路径/可塑性记忆/pm-h0
dsh plugin --profile web2 add file:/绝对路径/可塑性记忆/dist/dsh-plugin-plastic-memories-h0-0.41.0.tgz
```

> ⚠️ **改了包内容必须冷启动**：宿主按裸包名缓存模块，热重载只换配置不换 JS。
> **不要再手工建 `node_modules` 符号链接**，也不要手改 `dsh.profile.bundles` ——
> 标准命令会一致地维护它们；手工状态在 profile 基线被重建时会静默丢失。
>
> **长期开发推荐 stage 模式**：`./install-pm.sh stage` 把 `npm pack` 的产物镜像到
> `staged/dsh-plugin-plastic-memories-h0/`，profile 只建一次符号链接指向它；
> 之后每次发版跑一次 `stage` + 冷启动即可。`pack` 模式是**拷贝**，重启不会更新。

### 从 GitHub / 本地 tarball 装

- GitHub：`dsh plugin --profile web2 add github:<owner>/<repo>`
- tarball：`./install-pm.sh pack` 会先 `npm pack` 出 `dist/*.tgz` 再安装

### 兼容性声明

本包**没有** `@deepseek-ai` peerDependencies（它零运行时导入），
兼容范围由 `package.json` 的 `engines.dsh` 声明，DSH 在安装时直接检查
（当前范围：0.2 线的 rc.2 及以后，直到 0.3 之前）。

这样 `pnpm` 不会对 `link:` / `file:` 依赖反复警告「peer 不会被解析」，
而版本不匹配仍会在安装阶段被拒绝。

---

## PM 会话模式（推荐用法）

本 bundle 的核心是一个 **agent preset**：`presets/pm.patch.yml`（`id: pm`，`order: 5`）。

它 = `ptc` 模式 **− 压缩组** **+ 系统提示词里的 PM 协议**。

| 与 `ptc` 的差异 | 为什么 |
|---|---|
| 删掉 `compaction` 组 | PM 应是会话内**唯一**的 surface 改写者。压缩插件的范围会吸收 PM 的墓碑与摘要节点，两者同时挂载会互相破坏（可行性报告 §5.14） |
| `persona.suffix` 追加 PM 协议正文 | `persona` 是**作用域限定**的行，挂在 preset 里只影响该会话；它的 `suffix` 落在 order 10200（工具目录之后），正是「怎么做事」该在的位置 |

> **PM 插件只挂在这个 preset 里**（`plugins` 列表中的 `plastic-memories-h0` 行）。
> preset 的 plugins 挂载在**会话作用域**，工具注册按作用域隔离 ——
> 其他会话模式（ptc 等，带自动压缩）既不会加载它，`wireSchemas` 里也不会出现
> `plasticize` / `retrospect`。这是结构性的隔离，不是「约定别调」。
>
> 不要把插件行搬回 bundle 的 `cordis.patch.yml`：那样所有模式都会加载 PM，
> 而带自动压缩的模式会让压缩插件与 PM 争用同一个 surface（可行性报告 §5.14）。

## 「世代」选项卡：官方轨迹页面的私有化复刻（v0.41.0+）

会话主区域的视图选项卡里新增 **世代**，紧贴 **轨迹** 之后（`order = 9000`：官方 Chat=0、
轨迹=10，未来任何插件选项卡 order < 9000 都落在轨迹与世代之间 —— 世代始终最后）。

**这一版是官方轨迹页面的 1:1 复刻**：把 `@deepseek-ai/dsh-client-ui-trajectory` 的
loader bundle **逐字节复制**进本包（`trajectory-vendor.js`），由 `build-client.mjs`
做**私有化改名**后拼进 `client.js`：

| 官方身份 | 私有化后 | 为什么必须改 |
|---|---|---|
| 模块 id `@deepseek-ai/dsh-client-ui-trajectory` | `pm-trajectory-vendor` | 同一浏览器里两个模块 id 不能重名 |
| target / provide hook `trajectory` | `pmTrajectory` | conversation target 与 uiSession hook 按名注册，重名会互相覆盖 |
| 事件定义 kind `trajectory-*` | `pmtrajectory-*` | 事件定义注册表按 kind 去重 |
| slot `conversation.trajectory.images` | `pmTrajectory.images` | slot 名全局唯一 |
| locale NS `trajectory` | `pm-trajectory`（标签改成「世代」） | locale 命名空间不能重名 |
| 视图 id/order `trajectory` / 10 | `pm-generations` / 9000 | 排在官方轨迹之后 |

于是**官方轨迹页原封不动**，我们得到一个外观与行为一致的第二份轨迹页；
`versioncheck ⑨` 会检查私有化改名、官方身份无残留、以及 `client.js` 和
`build-client.mjs` 的生成结果一致（手改或忘记重新 build 会报红）。

### 升级 DSH 时怎么更新这份复刻

1. 从新版本 `node_modules` 重新复制
   `@deepseek-ai/dsh-client-ui-trajectory/lib/client.js` → `pm-h0/trajectory-vendor.js`
   （保留文件头部的来源注释）；
2. `node build-client.mjs` —— 每个私有化补丁都必须命中，否则直接抛错（不会静默生成半成品）；
3. `node versioncheck.mjs` + `npm test`。

### 第一层 PM 图层：世代选择（v0.41.0+）

工具栏（时长 / 轮次 / 调用 那一行）**最右侧、搜索框左边**新增论坛式世代选择：

    世代  0   …   5   6   7   8   …   12

- **按钮上的数字就是世代号**（与「第 N 代」同步）：0 = 初始工作面，最大数 = 最新世代；
- 当前世代高亮；数字太少时直接列全，两端固定显示首末世代、中间按当前世代开窗；
- 点第 k 个按钮 = 切换到第 k 代；点末代 = 跟随最新（有新投影时自动停在最新）；
- 少于 2 代时不显示。

右侧还有一行**逻辑世代页码**：

    逻辑  L0  L1  L2  L3

- 物理页码（上一条）是 DSH 的 surface 替换页，用于直接翻官方轨迹；
- 逻辑页码来自替代消息的 `logicalGeneration` 标记，只把每个逻辑世代映射到它**冻结时的第一个物理页**；
- 中间物理世代（auto-hide、多 span 等）不产生新的逻辑页；
- 模型侧只报逻辑世代号，用户点对应 L 按钮即可跳到物理页；模型结果里不需要出现物理世代号。

第 k 代显示的是「拿官方实时轨迹快照按第 k 代过滤」的结果：丢掉该世代之后才出现的节点、
丢掉被该世代及更早 PM 操作遮蔽的节点，替代消息作为普通用户消息留在原位 ——
看起来就像真的存在一个只说那些话的会话；行渲染 / 折叠 / 详情面板仍然全部是官方代码。

> **这不是重写官方的投影。** 世代数据来自 host 的 `sessionProjections` 单元
> （`generations.js`，同一套 extension 机制，其 fold 在 tests 里逐节点对齐
> `dsh-session` 官方的 `foldSurface`）；客户端只是把 host 给的「可见 seq / 遮蔽 seq /
> asOfSeq」当作字典，对官方快照做展示层过滤。DSH 本身没有「按世代取快照」的官方函数
> （世代是 PM 自己的概念），所以没有可直接复用的官方投影函数；但也没有第二套投影语义。

### 事实源与一致性：日志 → 官方投影 → 真实上下文 → 轨迹（v0.41.0+）

按「不要发明第二套转换算法」的原则，世代轨迹现在**不再过滤官方快照**，而是走一条链：

    Host：会话日志
      → 官方 SessionStore 重放（官方 surface fold）
      → surface.nodes（该世代真实上下文的消息序列）
      → session.deriveEventMessage()（官方 deriveMessages 的逐节点形态）

    Client：官方轨迹的事件定义（Definition）在 match 阶段跳过「不属于该世代」的事件
      → 官方装配器重建快照
      → 官方的行/折叠/详情面板渲染

也就是说：**轨迹 = 官方代码对「该世代真实日志」的装配结果**；请求上下文与轨迹展示
共享同一份「可见 seq 字典」，不再存在「快照过滤 ↔ 真实消息」的转换算法。

具体保证：

1. **字典的来源可验证**：`diffcheck.mjs` 对每个世代边界，用官方 `SessionStore`
   以「截断到该边界的日志前缀」重建影子会话，比较官方 `surface.nodes / replaceGeneration`
   与 host 投影快照；真实日志与真实插件操作日志都逐代相等。
2. **上下文链可验证**：`contexttest.mjs` 校验 `generation-context.js` 给出的、按世代
   还原的 rows —— 消息序列必须逐条等于官方 `deriveMessages()`，seq 序列必须等于官方
   `surface.nodes`，且两次调用完全可重复（无状态）。
3. **事件级过滤**：隐藏 `seq`、隐藏 `callId`（连带 tool/call 与 PTC 分发）、整步被遮时的
   step/turn 结构事件都会被跳过；切世代时 dispose + 重新注册 9 个事件定义，
   触发官方装配器按新世代重建快照。
4. **运行期自检**：每个提交边界后比较 host 投影状态与官方 `session.surface`，
   不一致只告警一次，不会静默漂移。

**步骤原子性（已从「已知边界」升级为不变量）**：一步 = 一条助手消息 + 它的全部工具结果；
工具结果必须跟随工具调用（API 约束）、PM 最小操作单位是一条消息，所以合法投影不可能拆步。
这一点现在由三层保证：
1. grouping 的开集归零把端点滑到整步边界；
2. `resolveOps` 在提交边界显式校验 `closureViolations`，拆步直接报内部不变量错误；
3. `atomicity.mjs` 在**真实会话导出**上逐条扫描历史投影：8 份会话、147 条投影中
   只有 2 条旧版本（balance 事故前）遗留的拆步记录，现行语义下零新增。

**性能**：切世代需要重装配整个已加载窗口，超长会话可能有一瞬卡顿。

### 相邻世代差异：已塑形折叠（A 形态，v0.41.0+）

- 只展示当前代与上一代的差异；第 0 代没有已塑形；
- 差异 = 相邻两代官方可见面直接 diff：上一代可见面 ∩ 本代 replace 的 [startSeq,endSeq]，
  新增节点 = 本代替代消息（纯隐藏时是空文本）。host 投影的 `replacements[].shadowed` 即此；
  不新增 PM 语法解析器，也不是合成事件。
- 点粉色「已塑形」：**不展开隐藏的原有轨迹**，而是把被覆盖的真实事件放行给官方装配器，
  并在官方 records 层把「已塑形」行搬到覆盖区间之前；收起后恢复原引用 ——
  不展开时的轨迹与没有差异功能时完全相同（有测试锁住引用相等）。
- 官方快照缓存分变体：`base`（不展开，正确性基线）与 `expanded`（仅展示用）；
  历史世代两种变体各自缓存，展开/收起命中缓存时零装配；**live 世代两者都不缓存**。
- 切世代/收起会清空展开态；展开态快照永不写入 base 缓存。

### 之后：PM 的 UI 逐步加上去

先把官方轨迹 1:1 立住，再在这份复刻上逐步加 PM 的图层（差异高亮、页码、投影折叠等），
每加一个都用截图对齐；宿主侧的 `pmGenerations` 投影（每代工作面 / 原始节点 / 替换历史）
已经就绪，供这些图层使用。

> 这条 UI 需要 **bundle 级 UI 宿主行**（`cordis.patch.yml` 的 `plastic-memories-ui`，
> `config.uiHost: true`）让浏览器发现 `client.js`；它只注册世代投影，不注册工具/命令。
> 改完插件后**重启 dsh + 刷新页面**（客户端 bundle 不在热重载范围内）。

## 用户侧命令（v0.41.0+）

输入框里以 `/` 开头，参数与工具**逐字段相同**（同一套 spans / ops 语法）：

```text
/plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"set"}
/plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"execute"}
/retrospect {"query":"PM-TEST-A","limit":10}
```

- `option` 省略时按 `set` 预览（先看效果，再决定是否 `execute`）；
- 命令没有「承载步骤」，所以 spans **不能用 `this`**（会明确拒绝并提示改用 cookie/编号）；
- 与工具共用同一个 `resolveOps` / `previewOf` / 写入格式，不维护第二套投影逻辑；
- 只在 **PM 会话模式**里注册（agent 作用域），其他模式看不到这两条命令。

### 为什么把 PM 知识放进系统提示词，而不是写成 skill

- skill 是**按需加载**的：模型得先决定去读它。而 PM 协议要在**第一条消息**就生效。
- 它讲的主要是**行为约束**（「看到替代文本就结束」），不是一个可以按需查阅的参考手册。

---

## 冷加载

```bash
dsh --profile web2 --port 3081
```

启动时看两件事：

1. **没有** `Cannot find package` / `patch: entry ... not found` 之类的告警；
2. 会话的工具列表里出现 **plasticize / retrospect / letter**（只有这三个）。

会话模式选择器里应显示 **PM · 可塑记忆 v0.41.0**。机械验收步骤见 `../PM-机械测试脚本.md`。

---

## 工具

只有三个。旧版的 pm_hide / pm_stabilize / pm_rehydrate / pm_inspect / pm_status / cookie 已全部移除。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| plasticize | **唯一**会改变工作面、产生新世代的工具（也能只预览）；ops 支持 types 类型过滤 | ops / option / also_execute_last_set |
| letter | 无副作用地留一条给未来世代回看的便签；不是主动发送的消息，写/读都只在原生轨迹里 | text（一篇纯文本） |
| retrospect | 只读**一个历史逻辑世代（严格 < self）**的上下文，返回完整结构化 JSON（含该世代 letter）；当前世代不查 | generation（绝对编号或 self - N） |

### types：区间内按消息类型匹配

plasticize 的每个 op 可加 `types` 数组：`user` / `developer` / `assistant` / `error` / `letter`。它在 span 解析出的区间内只匹配这些类型：`user`、`developer` 匹配单条消息；`assistant`、`error`、`letter` 匹配整个步骤单元（助手消息 + 其全部工具结果），保证不留下孤儿；**cookie 消息永不参与匹配**。匹配到的单元全部隐藏，最后一个匹配单元接收 `new_text`。不写 `types` 时保持旧行为：区间内的全部消息都匹配（cookie 也一样按旧语义处理）。

### letter：交给未来世代回看的便签

`letter` 是独立工具，一次输入一篇纯文本，工具只回执「登记成功」。它**不是**主动发给未来世代的消息，而是留在轨迹里等未来世代回看的便签；继承的前提是不影响未来世代：小范围稳定化或隐藏可以继承，大幅修改或已经过时的 letter 不建议继承。真正要引导未来世代的信息应写进塑形操作本身。`retrospect({ generation })` 的 `letter` 数组按调用顺序返回该逻辑世代的便签，每项形如 `{ index, text }`。

### cookie：自动插入的坐标

模型只看得见 **token 流**，看不见任何元数据 —— 所以需要一个**可见的、内容无关**的锚点。

**规则一：提交边界的队尾永远保持一个 cookie。** 队尾不是 cookie 就补一个，是就什么都不做。
它负责工具块之后的锚点，也负责「turn 末补一个 → 下一轮用户消息自然在它后面」。

**规则二：每条用户主动发送的消息，前后各夹一条 cookie**（v0.41.0+）。
一次主动发送产生两条 cookie：

    … 助手回复 [cookie N] 用户亲口说的 [cookie N+1] 时间快照 助手 …
                                              ↑ runtime-context 不再被夹

实现点是 `agent/pre-step`：日志只能追加，消息落盘前把 `[cookie][用户消息][cookie]`
摆进 `decision.messages`，落盘顺序就是上面那样。
左端点会**复用**队尾已有的 cookie（避免连续两条 cookie 连着出现）；
`runtime-context`（时间快照）这类系统注入消息**不夹** ——
于是「被两条 cookie 夹住的 = 用户亲口说的」在连续 token 流里直接可分，
不需要偏移量（模型数不准第几条消息）。

cookie 文本（每行实时带上当前上下文水位，首个请求前未知窗口时省略前缀）：

```
[42% of context used][Plastic-Memories][cookie][1]
```

水位 = `tokenMeter.measure(session).totalTokens / 最近一次 request/context 的 contextWindow`，在每次插入 cookie 时重新读取；只用于自我判断，不参与解析。

**身份来自元数据，不来自文本**：只有 `type = user/message` 且 `source.kind = pm-cookie`
的事件才算 cookie。正文里出现同样的字样（例如模型在回复里引用这个样式）不会被误认成锚点；
`parseCookieText` 只用于容错反解，且**整行锚定**。

编号 **无状态**：扫**全量日志**取 max + 1（被遮蔽的 cookie 仍占着它的编号），所以跨世代唯一。
解析**按 ID**（`source.id`，缺失时从正文反解）—— **不是**数第几个可见 cookie：
那样一旦某个 cookie 被遮蔽，后面所有编号都会错位（比找不到更糟）。

### ops：每个元素选中**若干**区间，替换成**一条**消息

```json
plasticize({
  "ops": [{ "spans": ["(3,7)", "[9,11]"], "new_text": "…" }],
  "option": "set" | "execute",
  "also_execute_last_set": true
})
```

| 字段 | 含义 |
|---|---|
| spans | 区间文本数组。同一段落里：前面的区间全部隐藏，**只有最靠后的那个**接收 new_text |
| new_text | 替代文本。**空字符串 = 纯空洞**（这就是 hide 的表达） |

**区间语法**（端点只有 cookie 编号与 `this`）：

    "3"          仅端点 —— 就是 3 号 cookie 那条消息
    "[3,4]"      闭区间，两端都含
    "(3,4)"      开区间，两端都不含
    "[3,4)"      半开半闭
    "(3,4]"      半开半闭
    "this"       本次 plasticize 所在的 assistant 消息 + 它的全部工具结果
    "[3,this]"   可以混用

- 两端**不分起始与结束**，插件自动排序 —— 区间是数轴上的点集，没有方向。
- 开括号对 `this` = **排除整个 this 组**（组是原子单元，不能只排除一半）。
- 引用已隐藏的 cookie 会明确报错。

### option

- **"set"** —— 只算预览并返回下一代的逐条消息，**什么都不写**。
- **"execute"** —— 登记，由 flush 在**提交边界**写入。

配合 `also_execute_last_set: true`，一次 execute 可以连带落实最近一条未执行的 set。
**零点属于写下这条 ops 的那条 plasticize**：所以 set 之后用 execute **原样重传同一条 ops**，
就会落实你看过的那个预览 —— 尤其是 `this`（execute 自己的 this 与 set 的 this 不是同一个位置）。

### 自动隐藏

execute **成功时**，插件顺手为新世代隐藏两类纯噪音：

1. **报错的 PM 步骤组**（失败调用只会污染下一个世代）
2. **成功的 plasticize(set) 步骤组**（预览已兑现，留着会让模型以为还没执行）

硬约束：**只动纯 PM 步骤组** —— 那一步里若还有 bash / write 之类的工作成果，
连带隐藏会毁掉模型的工作，所以宁可留着噪音。可用 `autoHide: false` 关闭。

### 硬约束

- 两端必须落在**整条消息**上（工具调用与它的结果是两条独立消息）。
- 区间**不得拆开一对 tool-call / tool-result**（真实供应商会拒绝）。
  落进块中间的端点会被**自动滑到块边界**，所以正常路径不会失败。
- 同一批声明之间**不得部分重叠**（完全相同的区间会被合并，只应用一次；部分重叠点名报错）。
- **一条声明解析失败不会拖死同批其它声明**（各自独立解析，失败的只算自己跳过）。

### 为什么投影一律延迟到提交边界

`this` 的含义是「**到这一步彻底结束为止**」，包含承载调用的 assistant 消息**以及它的全部工具结果**。

工具在自己的 execute 里运行时，**它自己的 tool/result 还没落地**。当场写会把自己的调用消息替换掉，
随后落地的结果变成**孤儿**，读侧以 `does not match an open turn and step` 拒绝整份日志（已实测）。

所以工具只登记，由 flush 在边界写入。不含 `this` 的范围只是「后边界已知」的特例 ——
**走同一条路，只维护一条路径。**

---

## 配置

```yaml
- id: plastic-memories-h0
  name: dsh-plugin-plastic-memories-h0
  config:
    trace: false          # 诊断：每次边界后打一行摘要
    probeImports: false   # 诊断：启动时探测能否解析 @deepseek-ai 运行时包
    autoHide: true        # execute 成功时自动隐藏含 set/报错 PM 调用的整个步骤组
```

---

## 测试

```bash
cd pm-h0 && npm test
```

17 套 / 637 条断言：

    selftest       61  区间语法 / this / 组扩展 / cookie 遮蔽后不漂移
    integration    22  工具注册、参数校验、宿主的 schema 校验器
    livetest       36  真实日志上的坐标解析、retrospect 世代坐标
    hooks          39  提交边界、O1 异常吞掉、O2 兜底、边界自动补 cookie、用户消息夹层、卸载退化
    ptctest        43  PTC 呈现路径 + 工具执行期 this / 失败声明不落地 / PTC 锚点与 consumed
    multicall      20  一步多调用的 surface 结构
    balanced       19  配对平衡 + **穷举所有 cookie 区间**
    persist        16  写盘后用宿主 released-v4 校验器重新加载
    zeroanchor     21  this 的零点属于 set；cookie 端点没有零点问题；去重后不重复执行
    groupingtest   13  组合抽象本身
    cookietest     59  cookie 编号 / 文本 / 按 ID 解析 / 身份不误认 / planCookie / 用户消息夹层
    autohide       55  自动隐藏（只在 execute 成功时清理；待决预览不吞）
    uitest         89  vendored 轨迹私有化 / 世代选择 / 事件级过滤 / 已塑形差异 / 快照缓存 / 内嵌视图
    diffcheck       4  逐世代与官方 surface fold 差分校验（影子会话重放日志前缀）
    versioncheck   67  版本号演进 + 打包完整性 + 文档一致性 + 安装元数据 + 会话隔离 + 私有化轨迹 + PM 图层
    contexttest     4  官方上下文链：rows == deriveMessages / surface.nodes，可重复
    atomicity      12  步骤原子性：滑点/真实日志整步闭合/this 整步

夹具在 `fixtures/`，是**真实导出**的会话日志 —— 几次事故都只在真实日志里复现。
`testkit.mjs` 收敛了「造一个真实 plasticize 调用」与「造一份带 cookie 的 seed」。

---

## v0.7 已知边界

| 边界 | 说明 |
|---|---|
| **区间不得拆开工具对** | 端点会被自动滑到开集归零处；不会留下孤儿 |
| **纯空洞需要已打开的 step** | `new_text: ""` 写成 `developer/message`，必须落在已打开的 `turn/step` 内。没有时**推迟**到下一个边界 |
| **不新增事件类型** | `KNOWN_SESSION_EVENT_TYPES` 硬编码，重启时拒绝未知类型。全部投影都用既有类型 + `surfaceOp` |
| **失败的声明会一直 pending** | 它不阻塞其它声明（各自独立解析），但每次边界都会重试一次并只告警一次 |
| **未挂 compaction** | PM 应是会话内**唯一**的 surface 改写者 |
| **自动隐藏命中含 set/报错 PM 调用的整组** | 其他工具若混在同一步，也会被一起隐藏；应分开执行 |

---

## 设计要点（对应可行性报告）

| 约束 | 落点 |
|---|---|
| **O1** flush 异常会杀死整个 turn | `index.js` 的 `safeFlush` 自己 `try/catch` 并降级为告警 |
| **O2** turn 末 pre-step 窗口关闭 | 同时挂 `agent/request` 与 `agent/turn-stopping` |
| **O3** 待办必须日志派生 | `engine.js` 扫描日志里的 plasticize 调用；被遮蔽后自然不在 surface 上（C9），天然幂等 |
| **C4** assistant 不能作为替换节点 | 替换一律用 `user/message`（墓碑）与 `developer/message`（纯空洞） |
| **C5** tool/result 只能改 content | 本版不对 tool/result 做内容级替换，避开该限制 |
| **C8** 溯源必须完整 | `sourceEventSeqs` 一律传完整被遮蔽节点集 |
| **C9** 已遮蔽节点不能再作目标 | 解析只认当前 `surface.nodes` |

**幂等键** = 被追加节点 `message.source.callId`。
存在即已完成；重启后扫描日志即可重建，**不依赖任何内存状态**。
## 与 DSH 版本同步（重建）

PM 有两类**不能 import、只能复制/生成**的 DSH 依赖：

1. `presets/pm.patch.yml`：以当前 DSH 的 `dsh-web-app/presets/ptc.patch.yml` 为基线，去 compaction、挂 PM；
2. `trajectory-vendor.js`：当前 DSH 的 `dsh-client-ui-trajectory` 的 `./client` 入口；
3. 客户端依赖契约：`package.json` 的 `dsh.client.inject` / `platform` 与官方 trajectory 包保持一致。

重建命令（check:dsh 也会检查客户端 inject/platform 是否漂移）：

    node rebuild-from-dsh.mjs          # 重新生成 preset、刷新 vendor、build 并跑 versioncheck
    npm run check:dsh                  # 只检查是否漂移（CI / 升级后自检）

脚本会自动定位当前 DSH 安装；也可以用 `--dsh-root <.../@deepseek-ai>` 或 `DSH_ROOT` 指定。
如果上游 **入口变化**（找不到 `ptc.patch.yml`、`dsh-client-ui-trajectory` 没有 `./client` 导出、或 compaction 块结构变化），脚本会**显式报错并拒绝生成**，不会静默产出半成品；此时需要人工检查上游结构并更新脚本。