# Changelog

版本号同时出现在三处，versioncheck.mjs 守住一致性，并会在「行为代码改了但版本号没升」时报红：

- package.json 的 version
- presets/pm.patch.yml 里 preset 的 name（UI 会话模式列表显示：PM · 可塑记忆 vX.Y.Z）
- presets/pm.patch.yml 里 persona.suffix 正文开头（模型上下文里能看到）

## 0.15.4

**A 形态头部行搬家的兜底：records 里拿不到 sourceSeq/index 时，按「紧随被覆盖区间」定位已塑形行。**

- 展开态下已塑形行的原始位置必然在被覆盖区间之后；若 cell.index/sourceSeq 均不可用，
  取最后一条覆盖记录的下一条作为头部行，移除后插到覆盖区间第一条之前；
- 移除操作改为按**记录对象引用**过滤（不再依赖字段），避免误删/漏删。

全套 **17 套 574 条**。
## 0.15.3

**修复 A 形态：已塑形行没有搬到覆盖区间之前；覆盖区间里的子工具行消失。**

- 头部行改用**官方 cell.index** 识别（切换展开时记录 cell.index），不再依赖 sourceSeq
  在 records 里的可用性；展开时按 index 找到该行、从原位置移除并插到覆盖区间第一条之前；
- 展开放行时同时把覆盖节点的 callId 从隐藏集合移除，使 tool/call、PTC 分发行（子工具）
  恢复显示。

全套 **17 套 574 条**。
## 0.15.2

**修复：快照校验过松，仍可能接受上一代快照（世代滞后一代、已塑形缺失/错位、展开为空）。**

- 旧校验只看「不超 asOfSeq、不含被遮蔽 seq」——上一代快照天然满足，于是被误当成本代；
- 新校验额外要求：历史世代快照必须包含**该代自己的替代消息**（只有装配到这一代才会出现）；
  展开变体还必须包含**全部被覆盖 seq**（否则只是未展开的 base 快照）；
- 校验失败不写缓存、下一拍重读；读缓存同样校验。

全套 **17 套 574 条**。
## 0.15.1

**修复：缓存的快照可能属于「装配未完成时的上一個状态」，导致世代显示错位、已塑形消失/展开为空。**

- 根因：展开/切换世代时定义重注册后，官方装配器可能还没完成就第一次读快照，
  旧实现直接把它按新的世代号写进缓存 → 之后一直读错（1 代显示 0 代、0 代显示最新，
  已塑形判断按当前世代号因此对不上）；
- 修复：写缓存前校验快照确实属于目标世代（eventNodes 不超出该代 asOfSeq、不包含该代
  仍被遮蔽的 seq；expanded 变体额外放行覆盖区间）；校验失败不写缓存并下一拍重读；
  读缓存时也再校验一次，脏缓存直接丢弃重读。

全套 **17 套 574 条**（快照缓存相关断言保持通过）。
## 0.15.0

**已塑形改成 A 形态（行内真插入）；官方快照缓存改为 base/expanded 双变体。**

- 差异来源：相邻两代官方可见面的直接 diff（上一代可见面 ∩ replace 范围 / 新增替代消息），
  不新增语法解析，也不注入合成事件；
- 展开：放行被覆盖的真实事件给官方装配器 + records 层把已塑形行搬到覆盖区间之前；
  收起恢复原引用。**不展开时与没有差异功能完全一致**（测试锁引用相等）；
- 缓存：base（正确性基线）与 expanded（仅展示）分变体；历史世代各自缓存，展开/收起命中零装配；
  live 世代两者都不缓存；展开态不写 base 缓存；切世代清空展开态；
- 覆盖区间里若含更早的已塑形：粉色静态标签、不可点；
- 移除悬浮内嵌视图与自动跳转（B 形态下线）。

测试：uitest 85→89，versioncheck 65→67；全套 17 套 574 条。
## 0.14.2

**已塑形展开的上一世代官方视图：自动跳到被覆盖区间（先解决「没裁到对应区间」）。**

- 官方表格是虚拟化 + 异步 `data-scroll-ready`，原来只在 effect 里设一次 `scrollTop`，
  表格还没渲染完就被丢弃 → 展开后停在顶部；
- 现在用 rAF 重试：先按被覆盖区间首个 seq 的行号估算 `scrollTop`，等目标行渲染出来后
  再 `scrollIntoView({block:'center'})` 精确居中；并补 120ms/320ms 两次兜底；
- 行内真插入（A 形态：把上一世代那几行直接插在已塑形下方）仍是下一步 0.15.0 的工作；
  这一版先把「展开后自动定位到对应区间」做对，便于你验收视图内容。

全套 **17 套 568 条**。

## 0.14.1

**修复：展开已塑形时没有拿到官方视图 context，退回了摘要兜底（截图里的错乱面板）；并补上缓存缺失时的按需装配。**

- 原因：0.14.0 只导出了官方 `TrajectoryView`，但忘了让父视图把 view context（hooks/t/sessionId）
  发布给 bridge，于是 `viewContext` 永远为空 → 展开走 `CoveredSummary` 兜底，
  在窄列里被截成截图那样；
- 修复：TrajectoryView 在 `pmEmbedded === false` 时发布 view context；
- 补强：缓存缺失（例如刷新后直接在最新世代展开）时，`prepareSnapshot(gen)` 临时把过滤世代切到
  上一代、读一次官方 target、缓存并恢复 —— 首次展开有一次装配，之后命中缓存；
  装配期间展开区显示「上一世代快照装配中…」占位；面板宽度/最小宽度也修正。
- 测试：uitest 82→85（按需装配一次、之后命中缓存）；versioncheck 64→65（prepareSnapshot 必须在）。

全套 **17 套 568 条**。

## 0.14.0

**已塑形展开 = 内嵌上一世代的官方轨迹视图（B 形态）；官方快照按世代缓存，live 世代不缓存。**

### 装配与缓存

- `trajectorySource` 包一层 `bridge.wrapTargetSource`：历史世代读官方装配产物后**按世代缓存**；
  最新（正在推理的 live）世代永不缓存，始终读官方实时快照；
- 新一代出现时，上一代（此前 live）的快照立即转入缓存 —— 它从此不可变；
- 历史世代快照命中缓存时零装配；切回旧代不再重跑装配。

### 展开区（B 形态）

- patch 导出官方 `TrajectoryView`（`pmTrajectoryView`），并把父视图的 view context
  （hooks / t / sessionId / useProjection）发布给 bridge；
- 点「已塑形」标签：行下方内嵌一个官方 `TrajectoryView` 第二实例，数据源 = 缓存的上一世代快照，
  挂载后自动滚到被覆盖区间；行样式 / 工具卡片 / 点击行看官方轨迹详情全部保留；
- 内嵌实例通过 t 上的 `__pmEmbedded` 标记识别：已塑形标签显示为**不可点击的粉色静态标签**，
  世代选择条隐藏，也不会上报投影/重注册（避免污染主视图）；
- 上一代快照尚未缓存时退回轻量摘要（带「快照装配中」提示）。

### 测试

- `uitest` 74 → 82：缓存命中只装配一次 / live 不缓存 / 内嵌模式标签不可点 / 内嵌隐藏页码 /
  视图 context 接口；
- `versioncheck` 59 → 64：缓存、内嵌视图、视图导出、view context、embedded 标记必须在生成物里。

全套 **17 套 564 条**。

### 已知边界

- 展开块是锚定在该行下方的浮层（官方表格是虚拟化固定行高，无法真插行）；
- 缓存里 live 末期快照若漏掉最后几条 append 事件，展开内容可能少最后一两条（新一代出现时通常已补全）；
  后续可在缓存时校验边界；
- 内嵌视图的 `loadOlder` 关闭（只展示已缓存的上一世代窗口）。

## 0.13.0

**相邻世代差异（已塑形）：官方轨迹行 + 一处粉色折叠类型标签；没有第二套语法解析器。**

### 架构结论（回答「用官方装配还是自制 PM 操作解析器」）

继续使用**官方装配管线**：v0.12.0 的链（日志 → 官方投影 → 事件级过滤 → 官方装配重建）
已经保证世代轨迹 = 官方代码对该世代真实日志的装配。相邻两代的差异不需要解析 PM 操作语法：

- 本代的 replace 事件在官方 surface 上覆盖了哪些 seq —— 由 **上一代的真实上下文**定义，
  host 投影的 `replacements[].shadowed` 已经给出（来自官方 surfaceOp 范围解析）；
- 这些被覆盖节点的正文在 host 投影的 `meta` 里；
- 客户端只按这两份字典给官方行加一层折叠视图，不重写消息/装配。

### UI

- 本代替代消息所在的官方轨迹行：类型标签变成 **已塑形**（字色 `#C64F91`、底色 `#FCE7F3`）；
- **只有类型标签可点击**展开/收起；点击行内其它位置仍是打开官方详情；
- 纯隐藏（替代文本为空）时：该行内容显示浅色 **已隐藏**（复用「仅工具调用」样式）；
- 展开面板列出上一代被覆盖的消息（类型标签 + 一行文本，上一代替代消息标「已塑形」）；
- 只展示当前代 vs 上一代；第 0 代没有已塑形；不嵌套。

### 实现

- `client-glue.js`：`reshapeInfoOf / isReshapedCell / coveredNodesOf / reshapeTagLabel`、
  `ReshapedTag`（折叠按钮）+ `ReshapedPanel`（覆盖列表）、全局样式注入；
- `build-client.mjs` 新增三条补丁：官方行类型标签的 class/子元素替换（只有命中本代
  替代消息才换成按钮）、`RecordListText` 增加空文本分支显示「已隐藏」；
- 无 host 侧改动（数据本来就在 wire 里）。

### 测试

- `uitest` 67 → 74：已塑形识别/覆盖列表/折叠组件元素/普通行不渲染/第 0 代无差异/
  client 补丁标记；
- `versioncheck` 55 → 59：已塑形标签、折叠面板、识别函数、已隐藏文本必须在生成物里。

全套 **17 套 551 条**。

## 0.12.1

**步骤原子性：从「已知边界」升级为不变量；用真实会话日志验证（并区分旧版本遗留）。**

### 用户纠正

「一步 = 一条助手消息（思考 + 正文 + 工具调用） + 它的全部工具结果」是不可拆的：
工具结果必须跟随工具调用（API 强约束），PM 的最小操作单位是一条消息，所以不存在
「只遮工具结果 / 只遮助手消息」的合法投影。之前写的「已知边界」应该不存在。

### 验证与加固

1. `grouping.js` 新增：
   - `stepUnitsOf(view)`：把**连续的**同 (turn,step) 助手消息/工具结果划为一个步骤单元；
     system prompt、user/cookie、developer 等消息各自是独立最小单位（system 虽带 turn/step
     元数据，但不属于某一步的助手输出）；
   - `closureViolations(view, seqs)`：检查隐藏集合是否整步闭合，返回拆步明细。
2. `resolveOps` 在提交边界显式断言：若区间拆步 → 报「内部不变量：投影区间没有整步闭合」；
   工具执行期的预览（selfComplete=false，本步结果还没落地）跳过，flush 重解析时再断言。
3. 新增 `atomicity.mjs`（12 条）：
   - 滑点：多调用并行的一步里，命中任一节点 → 区间覆盖整步（助手消息 + 全部结果）；
   - 真实会话导出（`会话日志原件/*.zip`）：8 份会话、147 条历史投影逐条扫描；
     **除 2 条旧版本遗留外没有拆步**；
   - 旧版本遗留定位：`3b4ce363…` 与 `d7e22544…` 各 1 条，形态都是「助手消息可见、工具结果被遮」，
     正是 balanced.mjs 记录的那次工具对事故（旧版本写的日志，现行引擎不再产生）；
   - 插件真实执行：`this` 投影落地后整步闭合。
4. 顺带修正 livetest 里一段手工历史：它把两条 assistant 消息塞进同一 (turn,step)
   （真实日志里一步只有一条），改成独立的 98 步。

### 文档

- README 的「已知边界」改为「步骤原子性不变量」+ 真实日志审计结果；
- `消息组合-扩展指南.md` 增加步骤原子性一节：单元定义、断言位置、回归套件。

全套 **17 套 540 条**。

## 0.12.0

**架构修正：世代轨迹不再「过滤官方快照」，改为「日志 → 官方投影 → 真实上下文 → 官方装配重建」。**

### 用户指出的问题

上一轮打算用「官方 deriveMessages（影子会话）vs 展示层过滤内容」做差分测试 —— 这等于
要凭空造一个「展示过滤后内容 ↔ 真实请求消息」的纯函数转换，是循环论证。正确做法是把链
串起来：**会话日志 → 官方投影函数 → 真正当前世代上下文 → 还原成当前世代轨迹**，
让展示与推理共享同一个事实源，而不是两套东西再做对照。

### 实现

1. **客户端不再有快照过滤算法**：删掉 `wrapSource / filterSnapshot`。改为把「不属于该
   世代的事件」字典交给**官方装配器**：9 个官方事件定义统一经 `pmDefinitionRegister`
   注册，match 被 `wrapDefinition` 包一层；命中隐藏事件返回 null。
2. **过滤是事件级、非内容级**：
   - 隐藏 seq（被该世代及更早投影遮蔽）与未来 seq（> asOfSeq）直接跳过；
   - 隐藏 `callId`（来自被遮 assistant 消息的 tool-call id、被遮 tool/result 的 toolCallId）
     连带隐藏 `tool/call` 与 `tool/ptc-dispatch*` 等非 surface 事件；
   - 整步被遮（该 (turn,step) 下可见节点全被遮）时连 step/turn 结构事件一起跳过，
     避免官方装配器渲染出空的/中断的 assistant 步。
3. **切世代 = 重注册定义**：client bridge 提供 `installReregister`；页码切换（或投影变化导致
   过滤字典变化）时 dispose + 重新注册全部定义，触发官方装配器按新世代**重建**轨迹快照。
   官方行/折叠/详情面板代码不变。
4. **host meta 补 callId**：`describeEvent` 的 tool-call 摘要带上 `id`，供事件级过滤使用。
5. **新增 `generation-context.js`（事实源链 API）**：`generationRows(store, events, generation)`
   用官方 SessionStore 重放日志前缀，返回官方 `surface.nodes` + 官方 `deriveEventMessage`
   的 rows（附 turn/step）；`liveGenerationRows(session)` 走 live session。零业务逻辑，
   下一步可作为「按世代看真实上下文」面板的数据源。

### 测试

- `uitest` 60 → 67：事件级隐藏（seq / callId / 未来）、定义包装（函数与表两形态）、
  重注册触发与指纹去重、页码按钮；
- 新增 `contexttest`（4 条）：rows 消息序列 == 官方 `deriveMessages()`、
  seq 序列 == 官方 `surface.nodes`、历史世代两次调用完全可重复；
- `versioncheck` 52 → 55：新增事件过滤 / 定义包装 / 重注册标记，且 client.js 必须等于
  重新 build 结果。

全套 **16 套 528 条**。

### 已知边界（继续收）

- 显式操作只遮住某 step 的部分节点时，step 边界仍保留，assistant 步可能显示部分内容；
- 切世代会重装配整个已加载窗口，超长会话可能有一瞬卡顿；
- 「最新世代」按语义也隐藏已被遮蔽的旧内容，因此与官方「原始轨迹」页可能不同。

## 0.11.0

**事实源与一致性：用官方 fold 做裁判，逐世代差分校验 + 运行期自检；如实记录残余风险。**

### 背景（用户提出的风险）

轨迹页「按世代过滤」是展示层算法，担心它和真实提交给推理服务的内容有一丝偏差、
而现在测不出来。之前的说法「放后续可选」并不准确：能做的保证现在就该做。

### 新增

1. **`diffcheck.mjs`（差分校验）**：对每个世代边界，用官方 `SessionStore` 以
   「截断到该边界的日志前缀」重建影子会话（官方 surface fold 重放），比较官方
   `surface.nodes` / `replaceGeneration` 与我们投影快照的 `seqs` / `gen`。
   真实日志 fixture 与插件真实操作产生的日志都必须逐代相等；DSH 若改 fold 语义立即报红。
2. **运行期自检**：每个提交边界后比较我们的投影状态与官方 `session.surface`，
   不一致则 `logger.warn` 一次（诊断用，不降级功能），避免静默漂移。
3. **文档**（README「事实源与一致性」）：解释三层保证，并**如实写明残余差异**：
   官方轨迹快照是分组后的账本节点，按 seq 删节点不等于按块裁剪；
   极少数节点内部仍可能含该世代应被遮蔽的块。下一步可做块级按 callId/seq 裁剪
   + 「官方 `deriveMessages()` 每代消息 vs 展示」的差分测试。

### 测试

新增 `diffcheck`（4 条）：夹具 3 个世代边界全部与官方 fold 一致；
插件真实操作产生的世代同样逐代一致。全套 **15 套 514 条**。

## 0.10.1

**世代选择条：靠右紧贴搜索框；页码改叫「世代」，按钮数字与世代号同步。**

- 布局：`.pm-pgs{margin-left:auto}` + `.pm-pgs + *{margin-left:8px}` ——
  在操作按钮组之后，把「世代选择条 + 搜索框」一起推到工具栏最右侧；
- 语义：去掉「首页/末页/第 n 页」的说法，改为**世代号**（0 = 初始工作面，末代 = 最新）；
  与 UI/文档里「第 N 代」同步，不再有 page 与 generation 差 1 的混淆；
- 交互：首末世代固定显示、中间按当前世代开窗（±2）、当前世代高亮；
  点末代 = 跟随最新（新投影到达自动停在最新）；世代数 < 2 不显示。

### 顺带回答「是不是重写了一遍投影函数」

没有第二套投影语义。分三层：
1. host 用**官方的 `sessionProjections` 扩展机制**注册 `pmGenerations` 单元；
   其 fold 在测试里与 `dsh-session` 官方 `foldSurface` 逐节点对齐（uitest ①）；
2. 客户端只拿 host 给的「可见 seq / 遮蔽 seq / asOfSeq」当字典，对**官方轨迹快照**
   做展示层过滤（删节点，不重新推导消息）；
3. DSH 本身没有「按世代取快照」的官方函数（世代是 PM 自己的概念），
   所以不存在可直接替换的官方投影函数；官方轨迹内部也没有导出可复用的过滤入口。

全套 **14 套 510 条**。

## 0.10.0

**第一层 PM 图层：官方轨迹页工具栏里的世代页码（论坛式：首页 … 5 6 7 8 … 末页）。**

### 行为

- 页码在工具栏（时长 / 轮次 / 调用）**最右侧、搜索框左边**；
- **第 n 页 = 第 n-1 世代**：第 1 页 = 初始工作面，末页 = 最新世代；
- 第 n 页的轨迹 = 把**官方实时轨迹快照**按该世代过滤：
  - 丢掉「该世代之后才出现的节点」（seq > asOfSeq）；
  - 丢掉「被该世代及更早的 PM 操作遮蔽的节点」（replacements.shadowed）；
  - 替代消息（pm-surface）作为普通用户消息留在原位；
  - streaming 状态（partial / runningCalls）清空；
- 行渲染、折叠、详情面板仍是官方代码，只换了数据；
- 默认停在末页并跟随最新；点 **末页** 恢复跟随；页数 < 2 不显示。

### 实现（全部由 build-client.mjs 补丁注入，官方 bundle 仍是逐字节复制）

1. `trajectorySource` 外面包一层 `globalThis.__PM_UI__.wrapSource(binding.sessionId, delegate)`：
   读取时按当前页过滤，并缓存过滤结果（保证 useSyncExternalStore 的引用稳定）；
   订阅同时挂到 bridge，页码变化会触发页面重渲染。
2. `TrajectoryView` 接收 `sessionId` / `useProjection`，把 `pmGenerations` 发布给 bridge。
3. `TrajectoryToolbar` 在搜索框之前渲染 `__PM_UI__.pagination(t)`。
4. glue 从内联字符串改为 `client-glue.js`（bridge + 页码组件 + 过滤逻辑），build 时拼进 `client.js`。

### 测试

- `uitest` 51 → 60：bridge 暴露、最新页引用相等、历史页过滤 future/hidden、
  缓存、页码组件（首页/末页/当前高亮）；
- `versioncheck` 48 → 52：PM 图层标记必须在、`client.js` 必须等于重新 build 结果。

全套 **14 套 510 条**。

### 已知边界（下一轮继续）

- 历史页里个别结构行（turn/step/request 边界）可能仍显示对应实时会话的信息，
  个别 tool 行按 tool/call seq 锚定、在极端情况下可能残留 —— 逐页对照时再收；
- 分页只是展示层过滤，不改 host 日志与请求组装。

## 0.9.0

**世代选项卡改为「官方轨迹 1:1 复刻」：vendor 官方 bundle + 私有化改名 + 生成脚本。**

### 决定

双世代同屏（左右两列差异）试下来不顺手：看详情的面板没地方放、使用习惯跨度大、
自己调视觉成本高。改为：**先把官方轨迹页 1:1 搬进世代选项卡**，之后 PM 的 UI
（差异高亮、页码、折叠等）再一个个截图对齐往上加。`0.8.x` 的自绘差异视图整体移除。

### 实现

- 新增 `trajectory-vendor.js`：`@deepseek-ai/dsh-client-ui-trajectory@0.2.1-rc.2` 的
  loader bundle **逐字节复制**（含来源注释）；
- 新增 `build-client.mjs`：打私有化补丁后拼出 `client.js`：
  - 模块 id `@deepseek-ai/dsh-client-ui-trajectory` → `pm-trajectory-vendor`
  - target / provide hook `trajectory` → `pmTrajectory`
  - 事件定义 kind `trajectory-*` → `pmtrajectory-*`
  - slot `conversation.trajectory.images` → `pmTrajectory.images`
  - locale NS `trajectory` → `pm-trajectory`（tab 标签「世代」）
  - 视图 id/order `trajectory`/10 → `pm-generations`/9000
  - 任何一个补丁不命中 → 直接抛错，不会静默生成半成品；
- `client.js` = 私有化 vendor + 4 行 glue（`require('pm-trajectory-vendor')` 后 `vendor.apply(ctx)`）；
- 官方轨迹页面与我们的复刻可以**同时挂载**、互不抢注册。

### 测试

- `uitest` 51（改写 ⑤）：client.js 注册两个模块、私有化改名齐全、官方身份无残留、
  glue 只调用 `vendor.apply`；
- `versioncheck` 43 → 48：私有化 id 全清单、官方身份不得残留、
  **`client.js` 必须等于 `build-client.mjs` 的重新生成结果**（手改/忘记 build 会报红）。

全套 **14 套 497 条**。

## 0.8.2

**两列之间留出空隙列，并画差异连接带 —— 一眼看出「几行被稳定化成哪一行」「几行藏到哪两行之间」。**

### 改法

- 左右两列之间新增 16px 的**空隙列**（列头同步留空），像文本差异软件那样把两边分开；
- **替代块**（蓝）：空隙列里画一根蓝色连接线，从左边多行的垂直中心连到右边剩余那一行 ——
  「N 行 → 1 行」的对应关系直接可见；
- **隐藏块**（绿）：空隙列里画一条绿色竖线，上下正好夹住前后两行 ——
  「这几行被隐藏在了哪两行之间」直接可见；
- 未变化的行：空隙列留白。

连接线的右端目标按 30px 行高计算（右边那一行的垂直中心），
这样即使左边叠了很多行，线也不会歪。

### 测试

- `uitest` 49 → 51：空隙列数量、替代块连接线、隐藏块竖线与「不画连接线」；
- `versioncheck` 42 → 43：空隙列与连接带必须在。

全套 **14 套 492 条**。

## 0.8.1

**页码条回到「世代」选项卡内部（sticky 贴在输入框上方，只有本选项卡可见）；行渲染照抄官方轨迹视觉。**

### 页码条

上一版把页码条放进 `conversation.composer.dock`，副作用是 Chat / 轨迹 选项卡里也会出现，
位置也落在输入框下方那排；这一版：

- 页码条重新放回**世代视图内部**，用 `position:sticky; bottom:calc(var(--dsh-composer-height) + 10px)`
  固定在滚动容器下沿 —— 正好在输入框上方，滚动轨迹时不会沉下去；
- **只在世代选项卡里出现**：不再注册 composer dock，Chat / 轨迹 都看不到。

### 视觉

行渲染按官方 TrajectoryTable 的常量复制：事件列 84px（中文）、行高 30px、`.5px` 边框、
`--dsw-font-xxs-12` 字号、kind 标签 19px 高并用官方同一组 token 上色
（user=业务蓝、context=绿、assistant=紫、tool=橙、system=中性）；内容列单行 ellipsis；
toolbar / 列头同样 30–32px、sticky、`--dsw-specific-sidebar-fill` 背景。

### 明确不做

- **不做任意两代对比**：左列固定 G-1，右列是当前选中的世代 —— 世代差异只需要看「这一步改了啥」。

### 测试

- `uitest` 50 → 49（页码条移到视图内：不再有 composer dock 注册；渲染断言改为视图内 pager）；
- `versioncheck` 41 → 42（页码条不得注册 composer dock、必须 sticky 在视图内）。

全套 **14 套 489 条**。

## 0.8.0

**世代视图改成「左右两列差异 + 绿线/蓝块」；页码条移进输入框 dock（修复随轨迹滚走）。**

### 两个问题

1. 页码条用了视图内部的 `position:absolute`，视图本身处在滚动层里 → 页码随内容一起沉下去；
2. 遮罩式折叠不直观：长任务可能把绝大部分轨迹折掉，点开一次就看不到别处，靠空间想象理解多层投影。

### 修法

- **页码条**：注册进 `conversation.composer.dock`（输入框上方的 dock，和输入框同一层），
  不随轨迹滚动；页码与视图通过按会话的共享 store 同步；默认最新世代。
- **世代视图**：改为**左右两列差异**（左 = 上一世代 G-1，右 = 当前世代 G），
  对齐**不使用文本 diff 算法**，而是直接用**已兑现的 PM 操作**：
  - 绿块 = 纯隐藏（`new_text` 为空）：左列包住被隐藏的连续行，右列一条竖直绿线；
  - 蓝块 = 有替代文本：左列包住多行，右列只剩一条替代消息；
  - 其余行 = same 块（两侧各一行）；
- 每行是一「条」轨迹：角色 + 内容；工具调用行内 `└ name(args)`；工具结果/思考/系统提示可展开；
  cookie 渲染成虚线胶囊；**点击行** → 右侧抽屉显示本条轨迹的详情（seq / turn / step / JSON）。

### 关于「复制官方轨迹代码私有化」

评估过：`dsh-client-ui-trajectory` 的行数据由**当前会话的 conversation target**（实时窗口）组装，
没有「按世代过滤」的入口；私有化除了复制 loader bundle，还要改名 target / 事件定义 id / locale 命名空间，
并改造它的数据源才能渲染历史世代 —— 复制并不能直接省掉这一步。所以这一版先把手写的差异视图做对；
如果视觉上还要和官方逐像素一致，下一轮可以把官方的**行渲染 + 详情面板**vendor 进来
（保留我们的差异对齐与世代数据）。

### 测试

- `uitest` 46 → 50：composer dock 注册、蓝块/绿块/same 块数量、左右行数、页码条渲染；
- `versioncheck` 39 → 41：页码条必须在 composer dock、旧遮罩方案不得复活。

全套 **14 套 489 条**。

## 0.7.9

**「世代」视图选项卡（选项二落地）：遮罩折叠 + 底部世代页码条；删除侧边栏入口。**

### 为什么不是「嵌进官方轨迹」

`dsh-client-ui-trajectory` 只声明了 `conversation.trajectory.images` 一个 slot —— 行、遮罩、
分页都没有扩展点；想改只能整体替换，DSH 一升级就碎。但轨迹自己也是通过
`conversation.view` slot 注册的（id=trajectory, order=10），所以插件可以**注册自己的视图选项卡**。

### 实现

- 新增视图选项卡 **世代**（id `pm-generations`，`conversation.view`）；
- 排序 `order = 9000`：Chat=0、轨迹=10，未来任何插件选项卡（order < 9000）都落在
  轨迹与世代之间 —— **世代始终是最后一个**（versioncheck ⑨ 守着）；
- 底部（输入框之上，按官方 `--dsh-composer-height` 约定定位）是世代页码条：
  默认最新、`‹ ›`、下拉跳转、「回到最新」；
- 主体：日志顺序的轨迹行（角色 + 文本；工具调用一行、工具结果折一行摘要可展开；
  思考/系统提示可展开；cookie 渲染成虚线胶囊）；
- 被投影遮掉的**连续轨迹折叠成浅色遮罩块**，标题=替代文本、右上角「折叠了 N 条 · 第 M 代」；
  替代文本再被遮 → 遮罩套遮罩（多级折叠）；
- Host 投影 `pmGenerations` 扩展（stateVersion 2）：新增 `raw`（原始 append 节点）与
  `replacements: [{gen, shadowed, repl}]`；客户端按 `gen <= G` 依次叠遮罩，**不重放会话**。

### 删除

- 侧边栏 `sidebarRightTabs` 入口与面板整体删除（用户确认不要这个入口）。

### 测试

- `uitest` 42 → 46：raw/replacements 断言、conversation.view 注册、order=9000、
  遮罩块与行数渲染；
- `versioncheck` 36 → 39：客户端必须注册 conversation.view / pm-generations / order 9000。

全套 **14 套 483 条**。

## 0.7.8

**用户消息前后各夹一条 cookie；时间快照不再与用户消息混在一起。**

### 现场（会话 8210d905）

PM 预设下四项机械测试全过（cookie 区间 (5,7) 稳定落地、set→execute、retrospect 2 条命中），
但日志暴露出 cookie 的排布问题：

    seq 22 system / 23 user(测试1) / 24 user(runtime-context) / 30 assistant
    seq 39 cookie[1] ← 第一条 cookie 出现在**第一个工具结果之后**

原因：`agent/request` 在 `prepareRequest` 里触发 —— 那时**当前请求的
system/user/runtime-context 消息还没落盘**（它们由 `step()` 在 prepareRequest 之后追加）。
所以边界补 cookie 永远补在「上一步产物」后面，用户消息从来没有被 cookie 夹住。

### 修法

新增 `agent/pre-step` 钩子（prepend + 包住 next()）：在 decision.messages 落盘前，
给每条 `source.kind === 'user'` 的消息前后各插一条 cookie：

    [cookie N] 用户消息 [cookie N+1] runtime-context 助手…

- 左端点复用队尾已有 cookie（turn 末补的那条），避免连续两条 cookie；
- `runtime-context`（时间快照）**不夹** —— 于是「被夹住的 = 用户亲口说的」与
  「系统注入的 = 没被夹住的 user 消息」在连续 token 流里直接可分，不需要偏移量；
- 边界补 cookie 的旧规则保留（工具块之后仍需要锚点）。

### 为什么不再需要偏移量

`spans.js` 里端点只剩两种：**cookie 编号**与 **this**；文本关键字与偏移量早已被移除
（关键字被模型自己的推理污染、偏移量模型数不准）。这次把「用户消息」也纳入了
cookie 坐标系，模型不需要知道「第几条消息」。

### 测试

- `cookietest` 51 → 59：bracketUserMessages 的纯函数行为（空工作面 / 队尾复用 /
  runtime-context 不夹 / 连续两条用户消息）；
- `hooks` 33 → 39：`agent/pre-step` 真派发下消息被夹成 cookie/user/cookie、
  编号连续、落盘后通过会话校验、时间快照不被夹。

全套 **14 套 476 条**。

## 0.7.7

**UI：侧边栏「可塑记忆」世代上下文视图；用户侧 slash 命令（与工具同语法）。**

### 侧边栏世代视图

- 入口在右侧边栏 guide（**工作区文件上面**，order 5），样式走官方 guide 胶囊；
- 面板显示**每个世代的真实上下文**：默认最新一代，顶部下拉切世代；
- 数据由 Host 投影 `pmGenerations`（`generations.js`）发布：
 - 与 `dsh-session` 的 surface fold **逐节点一致**（用真实夹具交叉验证，`uitest ①`）；
 - 每次投影多一代快照；每代只存 seq 列表 + 一份正文表，不做「每代复制全部正文」；
 - 节点带角色 / 文本 / 工具调用 / 思考 / `投影` 标记 / 隐藏空洞条数。
- 客户端是**手写 loader bundle**（`client.js`，`window.__ModuleLoader__.load`），
 按 practices 不 require 任何 `@deepseek-ai` client 包，样式只用 `--dsw-alias-*` token。

### 会话模式隔离（新增 bundle 级 UI 宿主行）

web 客户端按「Loader 里出现的包」发现 `dsh.client`；preset 行要等 PM 会话挂载后才出现，
页面首次加载可能还没有。所以 bundle 级 `cordis.patch.yml` 现在有一行
`plastic-memories-ui`（`config.uiHost: true`）：只注册世代投影 + 让浏览器发现 client 半身，
**不注册工具/命令、不改写任何 surface**。完整宿主仍然只在 `presets/pm.patch.yml`。
`versioncheck ⑧` 守住这条边界。

### 用户侧命令

输入框里 `/` 开头，参数与工具**逐字段相同**：

    /plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"set"}
    /plasticize {"ops":[{"spans":["(3,4)"],"new_text":"……"}],"option":"execute"}
    /retrospect {"query":"关键词","limit":10}

- 注册在 PM 会话模式的 agent 作用域（`ctx.commands`），其他模式看不到；
- 与工具共用 `normalizeOp / resolveOps / previewOf` 与同一套写入格式，不维护第二套投影逻辑；
- 命令没有「承载步骤」，所以 spans 不能用 `this`（会明确拒绝并给提示）；
- `recordInput: false`：参数不重复写进日志（命令回执本身已经是记录）。

### 测试

- 新增 `uitest.mjs`（42 条）：世代 fold 与宿主 surface 交叉验证、wire 值、
  节点摘要、client.js 语法与**工厂冒烟**（伪 ctx 上执行 apply + 渲染面板）、
  **投影注册表集成**（真实 host 快照里出现 pmGenerations、投影后 +1、注销后消失）、
  命令解析与错误提示；
- `versioncheck` 26 → 36：新增客户端半身声明与投影键一致性守护。

全套 **14 套 462 条**。

## 0.7.6

**PTC 下 `also_execute_last_set` 会写两条投影；补上「自噬回执」说明；机械测试脚本去歧义。**

### 现场（两份测试会话日志）

两份都跑完 4 项（PM 预设、v0.7.5、真符号链接），**插件零报错、零自动隐藏空洞** ——
上一轮「set 预览被吞」确实修好了（两份日志里 set 的预览都留在上下文里、模型都复述了）。
但暴露了三个问题：

1. **PTC 锚点 bug**：`set` + `execute(also_execute_last_set)` 在 PTC 下写了**两条**投影
   （set 那一步一条、execute 自己那一步再一条），同一段结论出现两次。
   原因：engine 用 `pending.callId`（PTC 的 `subCallId`，形如 `root:ptc:1`）去反查承载消息，
   而 assistant 消息上只有 `rootCallId` → 查不到 → 回退成 execute 自己的零点。
   native 下 `callId == ownerCallId`，所以既有测试都没抓到。
2. **去重会漏记幂等键**：set/execute 解析出同一区间时只写一条事件，但那条事件只带 set 的
   callId；execute 未被记为已落地 → 下个边界又执行一遍。
3. **模型行为**：`this` 会把调用与结果一起吞掉，下一轮看不到 tool result，模型以为没成功，
   反复重发（一份日志连发 5 次）。

### 修法

- 锚点改用 `pending.ownerCallId ?? pending.callId`（PTC 下即 rootCallId）；
- 投影标记新增 `consumed: string[]`：一条事件同时了结 set 与 execute；
  `scanNew` 与 `findLastPendingSet` 都经 `pmSettledCallIds()` 读取；
- PM 协议补一句：**替代文本就是执行回执** —— `this` 会吞掉调用与结果，
  下一轮没有 tool result 是成功，不是失败，不要重发；
- 机械测试脚本去歧义：
  - ② 第 4 步、③ 第 3 步都要求「不要结束回合，同一轮里继续下一步」；
  - ④ 的 query 从 `PM-TEST-A` 改成 `已登记`（前者根本没被隐藏，0 命中反而是对的）；
  - 补充「只调用一次 / 只出现一次 / 只落一条投影」的判据。

### 测试

- `ptctest` 36 → 43，新增 ⑦：PTC set + execute 只写一条、遮蔽 set 那一步、
  execute 自己那一步保留、consumed 记录 execute；
- `zeroanchor` 17 → 21，① 补上去重后不重复执行的断言。

全套 13 套 410 条。

## 0.7.5

**修掉机械测试第三步的死循环：自动隐藏把「待决的 set 预览」吞了。**

### 现场（两份会话日志）

两份日志（一个带思考、一个不带；PM 预设与 ptc 预设各一）都卡在第三次测试
「先 set 看预览，再 execute 落实」：

    set({spans:["this"], option:"set"})
      → 已登记（未执行）。下一代会是第 7 代、37 条消息：…
    边界：developer/message (note=auto-hide:set, refs=[set 的 assistant, set 的 result])
      → 预览结果被自动隐藏
    下一轮模型看不到预览 → 按提示「先 set 看效果」再发一次 set → 循环

实测：不带思考那份会话里 **80 次 set、80 条 auto-hide:set 空洞**，最后被用户中止。

### 根因

`autoHideTargets` 把「成功的 set 步骤组」无条件当作「已兑现的预览」隐藏。
但 set 的意义恰恰是「把预览交给模型看」—— 只要还没有成功的 execute 兑现它，
它就是**当前待决的预览**，必须留在上下文里。

### 修法

**自动隐藏 = execute 成功时的一次性清理**（用户原话：报错的 PM 调用与成功的 set
「只在 execute 时才一起执行」）。实现上引入 **settledBefore** = 已落地的 execute
与本批解析成功的 execute 的**最晚 seq**，并**同时**约束两类目标：

- 成功的 set：`set.seq <= settledBefore` 才清（已兑现）；
- 报错的步骤组：也必须 `seq <= settledBefore`（只在 execute 成功时清）。

于是：没有 execute 时，任何新的 set 预览 / 新的失败调用都不会被隐藏；
下一次成功 execute 才会把它们一起收拾掉。

### 测试

`autohide` 33 → 49，新增两块：

- ⑦ 待决 set 预览：先有成功 execute → 再 set → 边界与后续边界都不隐藏 →
  execute 兑现后才隐藏；
- ⑧ 报错步骤组：先有成功 execute → 再失败调用 → **不隐藏** → 下一次成功 execute
  才把它清掉。

全套 13 套 399 条。

## 0.7.4

**把插件限制在 PM 会话模式内；修掉 preset 里 `{{cwd}}` 导致的启动失败。**

### 现场

选中 PM 模式启动，直接报：

    unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
    registered variables: provider, model

DSH 这条线只注册 `provider` / `model` 两个提示词变量（`dsh-agent-loop` 里两行
`systemPrompt.variable(...)`），`{{cwd}}` 是老版本写法。删掉那行即可 ——
工作目录本来就在 runtime context 里。

所以上一轮能跑，只因为默认落回了 **ptc** 模式：PM 预设根本没加载成功。

### 结构性修正：PM 插件只属于 PM 会话模式

之前插件行挂在 bundle 级 `cordis.patch.yml`，所有会话模式都会加载它。
这有两个问题：

1. 其他模式（ptc 等）带**自动压缩**；压缩插件与 PM 会争用同一个 surface
   （可行性报告 §5.14），必须在结构上隔离，而不是靠约定；
2. 其他模式的会话里也能看到并调用 `plasticize` / `retrospect` —— 不该如此。

改法：

- `cordis.patch.yml` **清空**（保留文件供 bundle 机制引用），不再有 profile 级插件行；
- 插件行移进 `presets/pm.patch.yml` 的 `plugins` 列表。

preset 的 plugins 由 preset registry 挂载在**会话作用域**（`mountPreset` → scoped ctx），
而工具注册按作用域隔离（`dsh-tools: "Register globally or in the calling agent scope"`，
已用探针实测：scoped 注册的工具在全局 view 与其他 scope 的 `wireSchemas` 里都不存在）。
于是 PM 工具**只在该模式的会话里存在**，其他模式连 schema 都不会有。

### 安装

这一版起推荐 **link（符号链接）安装**，迭代时冷启动即加载最新代码，不用反复打包：

    ./install-pm.sh link     # 或直接 ./install-pm.sh（默认就是 link）

pack 模式仍然可用（冻结快照/搬移），但每次改完要重新 `./install-pm.sh pack`。

### 守护

`versioncheck` 新增 3 条（23 → 26）：

1. 插件行必须在 preset 的 plugins 里；
2. bundle 级 patch 里不得出现插件行（否则所有模式都会加载）；
3. 提示词变量只能是 `provider` / `model` —— `{{cwd}}` 之类会直接启动失败。

全套 13 套 383 条。

## 0.7.3

**修掉 PTC 路径下的两个连环 bug —— 一次真实测试里模型连续 4 次「报错但投影仍然生效」。**

现场（会话日志 `session-9e73f20d`，PTC 模式，机械测试第 1 项）：

    bash PM-TEST-A ✅
    bash PM-TEST-B ✅
    plasticize {spans:["this"], option:"execute"}
      → Error: 段落 #0：该区间会在终点之后拆开一次工具调用与它的全部结果
    模型重试 3 次 → 同样报错
    但每次报错之后，下一次边界都**照样把投影写进去了**（replace 39..43 等）
    最终模型以为自己失败了，却看到「已吞掉」的替代文本，于是结束了 turn

### Bug 1：工具执行期解析 `this`，而这时结果还没落地

PM 工具自己的 execute 运行时，承载它的 assistant 消息已经落盘，但**它自己的 tool/result 还没落地**。
于是 `stepGroup()` 得到的组不完整，`this` 的末端只到 assistant 消息 ——
`checkBalanced` 判「终点之后拆开工具对」，工具直接报错。

但这不是错误状态：**这是工具执行期的常态**。结果落地后，边界上的 `this` 一定闭合。

修法：

- `index.js` 把 `stepGroup().complete` 作为 `here.selfComplete` 传下去；
- `resolveOps` 只在 `selfComplete === false` 且区间收尾正好在 `this` 末端时，**跳过**这一条配对平衡校验
  （其它区间仍严格校验）；
- 真正的写入仍在提交边界，由 engine 用**完整**的 this 组重新解析。

顺带补上 `findLastPendingSet` 对 PTC 形态（`tool/ptc-dispatch-start`）的识别 ——
之前只扫 native 的 tool-call 块，PTC 下「最近一条未执行的 set」永远找不到。

### Bug 2：工具报错的声明，仍然在边界上生效

`engine.flush` 只看「是不是 execute 声明、有没有落地」，从不看**这次调用是不是报错了**。
于是失败的调用照样写投影 —— 模型收到错误、重试，而每次失败都改变了上下文。

修法：扫描时记录失败的 callId（native 看 `tool/result.isError`，PTC 看内层 `tool/ptc-dispatch.isError`），
失败的声明视为**已了结**（与已落地同等待遇）：不写入、不在后续边界重试、不算「execute 成功」，
但仍会作为「报错的 PM 步骤组」被下一次成功的 execute 自动隐藏。

### 测试

`ptctest` 19 → 36 条，新增三块直接复刻现场：

1. **工具执行期**：assistant 已落盘、结果未落盘时调用 execute → 不报错、回执「已登记」、
   结果补齐后边界上按完整 this 组落地；
2. **失败声明**：内层 dispatch 与 tool/result 都 isError → 边界不写任何投影，
   第二次边界也不动作，「已了结」不会每个边界重试；
3. **set 预览**：this 组不完整时能算预览（且零写入）；
4. **PTC 待决 set**：`findLastPendingSet` 能认出 `tool/ptc-dispatch-start`。

全套 13 套 380 条（原 363）；`versioncheck` 23 条不变。

## 0.7.2

**改成标准 DSH bundle 安装：一条 `dsh plugin add` 完成依赖 + bundles 注册，配一份幂等安装脚本。**

### 问题：基线一变，手工安装就静默消失

旧做法是在 profile 的 `node_modules` 里手工建符号链接、手改 `dsh.profile.bundles`。
主 profile 基线变化（把 web 重新复制成 web2、升级 bundles、工作区改名）后：

- 依赖 / node_modules / bundles 行一起消失；
- 旧 `link:` 指向不存在的路径时，bundle 被启动流程静默跳过；
- 手改的 bundles 行与 pnpm lock 不同步。

### 标准流程（DSH 0.2 线 rc.2 起）

    dsh plugin --profile web2 add link:/绝对路径/可塑性记忆/pm-h0

`dsh plugin` 会把参数转发给 pnpm，并在安装后由 plugin-manager **自动**读取包的
`dsh.bundle.patch`、把包名写入 `dsh.profile.bundles`。卸载同理。
一条命令即可在任意基线上重放。

新增：

- 工作区根 `install-pm.sh`：install（link/pack）/ verify / status / repair / uninstall / restore
  - 改 profile 前自动备份 `package.json` 与 lock 到 `.work/install-backup/`
  - verify 覆盖：依赖、bundles、node_modules、patch 文件齐全、模块可 import、
    `--dump-config` 含插件行与 `preset-pm`、`--help` 启动冒烟
  - repair：检测 `link:` 目标消失（工作区改名）后自动重装
  - 拒绝直接操作主 profile `web`（除非 `PM_ALLOW_MAIN=1`）
- 工作区根 `安装-web2.md`：基线变化后的处理清单
- `dist/dsh-plugin-plastic-memories-h0-0.7.2.tgz` + `SHA256SUMS`（pack 模式的安装包）

### 包元数据：用 `engines.dsh` 取代 peerDependencies

原来声明的 `@deepseek-ai/*` peerDependencies 有两个副作用：

1. DSH 的兼容性检查在**没有** `engines.dsh` 时拿 peer 当依据；
2. pnpm 对 `link:` / `file:` 依赖**每次都警告**「peer 不会被解析」——
   而本包本来就是零运行时依赖（不 import 任何 `@deepseek-ai` 包）。

现在改成：

    "engines": { "node": ">=22", "dsh": ">=0.2.0-rc.2 <0.3.0-0" }

DSH 在安装时按 `engines.dsh` 检查兼容性（源码：`unmetRequirements` 优先读 `engines.dsh`），
pnpm 也不再警告。`versioncheck` 新增 3 条守护：`engines.dsh` 存在、不再有 peerDependencies、
`dsh.bundle.patch` 指向的文件都存在。

### 断言

13 套 363 条（versioncheck 20 → 23）。

## 0.7.1

**cookie 文本去掉 md5，改成人类可读样式；身份只认元数据。节点 id 去掉随机 UUID。**

### cookie 文本

    [Plastic-Memories][cookie][7]

原来是 `<md5('Plastic-Memories')>[Plastic-Memories]7`。32 位十六进制对推理没有信息量，
只是一段要占用注意力的噪声（用户担心它干扰模型推理），去掉。

### 身份：只认用户消息 + 元数据标记

`isCookie` 仍然只认 `type = user/message` 且 `source.kind = pm-cookie`。
**正文里出现同样的文字不算**：助手回复、工具结果、文档里引用这个样式，都不会被误认成锚点。

这条边界是用户点出来的：在开发 PM 的会话里，这个样式会被反复引用 ——
即便带哈希防碰撞，开发会话本身也会「碰撞」。现在身份来自元数据，文本只是给人看的。

`parseCookieText` 只承担**容错反解**（source.id 丢失时），并且改成**整行锚定**：
夹在其它文本里的同样字样不会被解成编号。

新增测试 ①b：助手消息里引用样式、普通用户消息里写样式、带标记的用户消息 —— 只有第三种算 cookie。

### 节点 id 改成确定性（去掉 randomUUID）

原来每个替换节点 / cookie 节点都用 `randomUUID()` 生成 `message.id`。
那不是 cookie 编号（编号是另一套自增），而是宿主要求的 message id ——
宿主只校验它是非空字符串（`assertMessageEventShape`），不要求 UUID。

既然它不参与定位，就没有理由用随机值。现在改成：

    cookie 节点:   pm-cookie-<n>
    替换节点:      pm-surface-<callId>-<序号>
    自动隐藏节点:  pm-auto-hide-<callId>-<起始 seq>

日志因此可对账、可重放，也少一个 `node:crypto` 依赖。

### 断言

全套 360 条（cookietest 43 → 51；selftest +1 验证确定性替换节点 id，hooks +2 验证 cookie 正文样式与确定性 cookie id）。

## 0.7.0

**把上一轮只做了一半的重构做完，并补上「自动隐藏」。** 全套 349 条断言回绿。

### 上一轮遗留：套件是半绿的

cookie 定位换掉之后接线完成、旧测试没改：selftest / hooks / zeroanchor 崩溃，
livetest / ptctest / balanced / persist 挂。半绿状态下判断不了新代码有没有回归，
所以这一轮第一件事是把基线拿回来 —— 七套旧测试全部改写为 cookie/spans 新 API。

### 顺带查出三个真 bug

#### ① `index.js` 用了 `randomUUID` 却没 import

    id: randomUUID(),          // ← 没有从 node:crypto 导入

它在一个 `try/catch` 里，于是**自动插 cookie 在真实会话里 100% 静默失败**：
每次边界都走 catch，只留一条 warn。界面看不出来，模型也看不出来 ——
cookie 一条都不会有，而所有定位语法都依赖它。
（旧 cookietest 只测 cookie.js 的纯函数，所以没抓到。）

#### ② `cookieIndex` 按「第几个可见 cookie」数，而不是按 ID

模型看到的是正文里的**编号**；一旦某个 cookie 被投影遮蔽，可见序号整体前移，
后续所有编号全部错位 —— 比找不到更糟。

改为按 `source.id` 解析（缺失时从正文反解）。`nextCookieId` 同步改成 **max+1**，
`listCookies` 读 source.id。并新增一条测试钉住语义：遮蔽 ck1 之后，ck5 仍解析到 ck5。

#### ③ 一条声明解析失败会**拖死同批其它声明**

旧实现把整批声明放在一个 try 里：只要有一条写错（例如引用了不存在的 cookie），
整批拒绝，而那条声明**永远 pending** —— 于是这个会话后面的 plasticize 全部失效。
现在每条声明**独立解析**：失败的只算自己跳过，其它照常落地（自动隐藏也因此能清掉失败那一步）。

### 新功能：execute 成功时自动隐藏（用户要求）

> 「execute 成功时为新世代隐藏所有报错的 PM 工具消息、所有成功的 plasticize(set) 消息，
>   防止模型忘记操作，给下个世代带去污染。」

实现要点：

- 两类目标：**报错的 PM 步骤组**、**成功的 set 步骤组**
- **只动纯 PM 步骤组** —— 那一步里若还有 bash / write 之类的工作成果，
  连带隐藏会毁掉模型的工作，所以宁可留着噪音
- 与本批显式区间重叠的跳过（已经遮了）
- 没有打开的 step 时推迟（空洞必须落在已打开的 turn/step 内），下一个边界补做
- 被遮的节点已不在工作面 → 天然幂等，不需要额外记账
- 配置键 `autoHide`（默认 true）

### 其它

- `this` 端点的开括号语义：排除**整个 this 组**（组是原子，不能只排除一半）
- 工具描述与 PM 协议正文重写：删掉 cookie 工具、`cookie_start`/`cookie_end`、
  `text_start`/`text_end`、`msg_start`/`msg_end` 这些已废除的写法
- testkit 新增 `cookieSeed()`：在夹具的**单元边界**后插 cookie 并重排 seq，
  让测试能用模型真会写的区间
- `session/title` 用 messageSeqs **按下标**引用更早的 user 消息，中间插 cookie 会让它指错
  （宿主校验器实测），所以 cookieSeed 去掉标题事件 —— 生产里 cookie 只追加在队尾，不重排

### 断言数

    套件        旧    新
    selftest    45    60
    livetest    33    36
    hooks       24    31
    ptctest     17    19
    balanced    17    19
    persist     15    16
    zeroanchor  13    17
    cookietest  35    43
    autohide    —     33   （新增）
    ─────────────────────
    合计       236   349   13 套全绿

## 0.20.x / 0.18.0 / 0.16.2 / 0.16.0 / 0.6.1

（这几个标题在某次编辑里被折叠成一行，正文已丢失；需要考古请看 git 历史。）

## 0.50.85

**修复：私有事件缺 ignorable 标记导致宿主拒绝加载整份日志。**

- 起因：commit / commit-checkpoint / logical / locks / reject / damaged 之前用 session.append 写入，envelope 没有 ignorable:true；
- 宿主遇到不认识的 plugin: 类型且未标记 ignorable 时，会拒绝解释整份日志（历史加载失败）；
- 现在所有私有事件都走 appendPluginRecord（index 注入宿主实现），envelope 带 ignorable:true；
- 新增 repair-ignorable.mjs：给历史日志补标记（自动留 .bak）；
- spectest 新增回归：flush 写出的私有事件必须全部带 ignorable。

全套 **12 套 / 256 条**（uitest 103 另计）。

## 0.50.84

**三个工具都拒绝未知字段；retrospect 补截断提醒。**

- retrospect / letter 的 schema 也加 additionalProperties:false；
- retrospect 描述补一句：结果过大可能被宿主截断（约 6000 字符），请用 messages_position / head / tail 控制大小。

全套 **12 套 / 254 条**（uitest 103 另计）。

## 0.50.83

**四个测试会话审计后修的两处问题。**

- PTC 下 retrospect(self) 多算了当前 assistant 消息：callId 形如 root:ptc:N，而承载消息里记的是 rootCallId；cutoffForCall 现在两种都认（实测 units 31 vs 30 的偏差消失）；
- plasticize 增加 additionalProperties:false：模型按旧 API 传 option:"set" 时会被拒绝，而不是被静默忽略后真的写入；
- 选择器允许裸数字区间（0 to 20），对齐模型自然写法；
- 审计结论：native 下 retrospect 与捕获逐行一致；每次 replace 后的下一个捕获都能看到新文本、旧节点消失。

全套 **12 套 / 254 条**（uitest 103 另计）。

## 0.50.82

**文案按现状重写（三篇工具描述 + 参数 + README + 求助文档）。**

- plasticize：删掉 set 相关表述，补 this 的语义、提交边界失败会留说明、隐藏单元不可再选；
- retrospect：返回结构改成 { logical, units, messages?, letters? }，补 role/calls/locked/letters/head/tail 说明；
- letter：改成「成功调用后会被自动隐藏」；
- README 重写：单模式 API、WAL 写入协议、测试数字、已知限制；
- 文案打磨-求助.md 重写：理念/术语/三篇现文案/不能改的事实/待决问题。

全套 **12 套 / 252 条**（uitest 103 另计）。

## 0.50.81

**retrospect 裁剪参数拆成 head / tail。**

- clip 的语义与词义不符（clip 是剪掉，不是两头保留），改为 head: N / tail: M；
- 超长才裁：长度 ≤ head+tail 时原样返回；head 或 tail 为 0 时该侧不保留；
- 文档与工具描述同步。

全套 **12 套 / 252 条**（uitest 103 另计）。

## 0.50.80

**retrospect 用 clip:N 取代 preview 布尔；删除内部旧行视图。**

- clip: N = 每条 text 前后各留 N 个字符（超长才裁，中间用 …… 省略）；
- 删除 preview 参数与 messages.retrospectMessages（unitest 改用 retrospect 的 JSON 输出）；
- CONTRACT.md 与工具描述同步。

全套 **12 套 / 252 条**（uitest 103 另计）。

## 0.50.79

**清理 set 遗留：规格、审计、测试、死文件。**

- pmspec 删除宏规则（isMacro / 展开 / no-pending / macro-twice）；
- verify.js 不再看 option：所有声明都按 execute 校验「有显式替换」；
- spectest 删除宏重放分节，随机场景改为「两条不相交 op」；
- 删除 preview.js（渲染已随 set 预览一起消失）；index 去掉未用的 retrospectMessages 导入。

全套 **12 套 / 251 条**（uitest 103 另计）。

## 0.50.78

**units 改为总单元数；null 明确拒绝。**

- 之前误解为「单元号列表」，现改为 Number：当前世代一共有多少个单元；
- messages_position / letters_position 只接受选择器或 none；null 在 schema 层就被拒绝（normalizePosition 里也保留了防御）；
- 文档与工具描述同步。

全套 **12 套 / 254 条**（uitest 103 另计）。

## 0.50.77

**retrospect 收敛：none 唯一、units 常回、tool 并入 assistant。**

- messages_position / letters_position 只接受 none（不再接受 null）；
- units 任何情况下都返回（当前世代全部单元号），不再只在过滤时给；
- tool 结果行标注为 assistant（与它的 assistant 同单元，按 tool 过滤和按 assistant 过滤等价）；role 只剩 system/user/assistant/developer；
- 工具描述与 CONTRACT.md 同步。

全套 **12 套 / 253 条**（uitest 103 另计）。

## 0.50.76

**retrospect 输出瘦身：role 取代 type，去掉 n/seq，窗口参数拆分。**

- messages 行 = { unit, role, text, calls?, locked? }：role 用模型熟悉的 system/user/assistant/tool/developer；
- 删除 n 与 seq（行号=数组下标，seq 是内部字段）；preview 标志不再出现在返回里；
- 删除 count / total；只有给了 messages_position 时才回 units；
- result_positions 拆成 messages_position / letters_position，都支持 none / null；
- 修复 letters 的世代归属：无 execute 的会话里当前世代的 letter 会被判成第 0 代而丢掉；
- 文档与工具描述同步。

全套 **12 套 / 253 条**（uitest 103 另计）。

## 0.50.75

**删除 set：plasticize 只剩一种模式。**

- 工具参数只剩 { ops }：每元素 = 一个选择器 + 一条替代文本，直译成一条 surfaceOp；
- 删除选项 option / preview_positions / 宏 { the last plasticize(set) } / 待决 set 判定（pending.js 整个文件）；
- 删除 set 预览（plasticize.js、preview.js 的 projectNext / renderRowsPreview）；preview.js 只剩 renderPreview 给 retrospect 用；
- 自动隐藏不再有 set 分支；扫描、去重、consumed 相关逻辑一并简化；
- 工具先校验 ops 形状，再找承载消息（参数错误优先报参数错误）；
- 测试：契约/集成/global/ptc/oracle 里的 set 用例删除或改写；gentest 删除（预览≡结果的命题随 set 消失）。

全套 **12 套 / 250 条**（uitest 103 另计）。

## 0.50.74

**一条 op 直译成一条 surfaceOp；删掉归并与旧的多段规则。**

- resolveUnitOps 不再走「多段里只有最后一段拿到 new_text」的旧逻辑（positions 早已是单值）；
- 自动隐藏不再做相邻归并：空文本本身就是空洞，多写一条事件没有语义代价；
- 删除未再使用的 unitRanges。

全套 **13 套 / 284 条**（uitest 103 另计）。

## 0.50.73

**重叠检测返回全部交集；自动隐藏改为「扣减 + 合并」而非整条丢弃。**

- findOverlap 增加 seqs 字段（两区间的全部重叠 seq）；新增 intersectionOf / subtractSeqs；
- 自动隐藏：合成候选区间 → 扣掉显式 op 覆盖的 seq（只丢自动隐藏这一侧）→ 连续段拆分 → 相邻合并 → 解析写入；
- 相邻区间合并成一条 op，避免写出一串连续 developer 消息；
- spectest 新增 ③e：交集、无交集、扣减拆分、全扣减。

全套 **13 套 / 284 条**（uitest 103 另计）。

## 0.50.72

**set 查找去掉两处全量扫描。**

- failedCallIds 只在「最老可见节点」之后扫描（更早的 set 不可能是待决）；
- ownerEventOf 从调用位置往回找承载消息，不再从头遍历；
- 宏展开仍然只是把 set 的 ops 原样拼进 op 列表，没有第二条管线。

全套 **13 套 / 280 条**（uitest 103 另计）。

## 0.50.71

**自动隐藏改成合成 ops，走和模型 ops 同一条解析路径。**

- autoHideTargets 的结果先折成 { positions: "unit a to b", new_text: "" }，再交给 resolveUnitOps；
- 单元边界 / 重叠 / 锁 / 系统提示的判定从此只有一份（此前 auto-hide 自己算 seq 区间）；
- 写入仍在同一个 WAL commit 批次内，哈希覆盖不变；
- 实测：set 单元仍被隐藏，commit 覆盖 3 条（投影 + 自动隐藏 + 世代边界）。

全套 **13 套 / 280 条**（uitest 103 另计）。

## 0.50.70

**删除 pending.js 里对「含宏 set」的兜底过滤。**

- 该形态已被工具层直接拒绝（结果 isError），failed 过滤已覆盖；
- 项目未发正式版，不做前向兼容，不为历史日志保留多余分支。

全套 **13 套 / 280 条**（uitest 103 另计）。

## 0.50.69

**记录改名：checkpoint → commit-checkpoint。**

- 避免与理论文档里的「压缩 checkpoint」混淆：它只表示「这批 WAL 已完整写入」；
- 文档统一用「WAL commit」指 plugin:plastic-memories/commit，与 git commit 无关；
- CONTRACT.md 增加「写入协议（WAL）」一节，写明三步顺序与哈希范围。

全套 **13 套 / 280 条**（uitest 103 另计）。

## 0.50.68

**checkpoint 封住校验成本；set 改为工作面上的反向扫描。**

- 每批写完后追加 plugin:plastic-memories/checkpoint { upTo }；它之后的 commit 不再校验；
- 回溯最后一条标记有上限（2000 条事件），扫不到按「太旧、不查」处理；
- findLastPendingSet 重写：从日志尾部往前扫，跨过最老可见节点即停；只认仍在工作面上的 set；
- 兑现过的 set 会随单元被自动隐藏，「可见性 = 未兑现」，不再需要扫全部日志；
- spectest 新增 ③d：checkpoint 落点、覆盖范围、后续 flush 不误报。

全套 **13 套 / 280 条**（uitest 103 另计）。

## 0.50.67

**commit 覆盖的哈希范围确认：整批真实落盘事件（替换 + 私有事件）。**

- 一批 = developer/message(replace) + plugin locks(lock_this) + 自动隐藏 + plugin logical(世代边界)；
- 字段集 { seq, type, data, surfaceOp, sourceEventSeqs }；唯一排除 time（DSH 在 append 时赋值）；
- 校验读取的是 snapshotEvents 的真实事件，与预计算共用 hashEventRange；
- spectest ③c 增加「条数一致但哈希不符」用例。

全套 **13 套 / 277 条**（uitest 103 另计）。

## 0.50.66

**预写提交记录（WAL）：commit 先落盘，数据后落盘；每次 flush 校验最后一条 commit。**

- 写入路径改为「先算整批计划事件，再写 commit，再写数据」；commit 带 { from, to, count, hash }；
- hash = sha256(规范化事件序列)，只取稳定字段（seq/type/data/surfaceOp/sourceEventSeqs，排除 time）；
- flush 每次回溯最后一条 commit 或 checkpoint；checkpoint 之前不再校验（长会话护栏，尚未写入）；
- 发现损坏：logger.error + plugin:plastic-memories/damaged + 一条可见提示（建议 retrospect(self - 1) 核对）；同一段只报一次；
- spectest 新增 ③c：伪造 commit 只写一半，验证损坏被发现。

全套 **13 套 / 276 条**（uitest 103 另计）。

## 0.50.65

**边界拒绝分成两类：safety-zone（预期）与 internal（bug）。**

- reject 记录增加 kind 字段；internal 用 logger.error 而不是 warn；
- 可见提示也分措辞：INTERNAL ERROR 与 NOT applied；
- 说明：工具层检查针对调用时刻的表面；安全区可能在调用之后、边界之前被用户改动，这是唯一预期内的拒绝路径。

全套 **13 套 / 274 条**（uitest 103 另计）。

## 0.50.64

**被拒绝的 execute 现在会告诉模型。**

- 工具调用时只能回「已登记」，真正写入在提交边界；此前边界失败只留一行日志，模型以为自己生效了；
- 现在边界失败会追加一条可见 developer 提示：[plasticize] NOT applied: <原因>；
- Registered 回执补一句：若表面在边界前变化，则什么都不写、改为留下提示；
- spectest 安全区用例新增两条断言（可见提示 + reject 记录）。

全套 **13 套 / 274 条**（uitest 103 另计）。

## 0.50.63

**被拒绝的 execute 现在会写一条私有事件。**

- 之前失败只在 logger 里留一行 warn，日志里「被拒绝」和「漏写」完全同形，审计器无法区分；
- 现在写 plugin:plastic-memories/reject { callId, message }；
- verify.js 识别该事件：被拒绝的声明不再要求显式 replace，同时禁止它被应用；
- spectest 恢复对全部 40 个用例跑审计（此前对拒绝场景只能跳过）。

全套 **13 套 / 272 条**（uitest 103 另计）。

## 0.50.62

**随机差分扩到四类场景：普通 / this / 宏重放 / 安全区。**

- 用例数 30 → 40，按 index %% 4 轮转场景，覆盖此前只有固定用例的路径；
- runCase 支持 setOps（宏重放）与 lockUnit（先加锁再执行）；spec 侧对应传入 pendingOps / locks；
- 新增断言：规格报错 ⇒ 实际 applied 0 且不写事件；被拒绝的用例跳过 verify 审计（audit 会误报 successful execute has no explicit replacement）。

全套 **13 套 / 272 条**（uitest 103 另计）。

## 0.50.61

**执行规格覆盖宏重放；清掉一批死代码。**

- pmspec 增加规则 8：宏 { "the last plasticize(set)": true } 在原位置展开成待决 set 的 ops（只能一次；无待决 → no-pending）；
- spectest 增加 ⑤：重放场景下规格展开与真实事件逐条一致；
- 删除 messages 里已无调用方的 messagesAt / currentCutoff / currentInputMessages；
- 顺手修掉残留的停止点注释。

全套 **13 套 / 272 条**（uitest 103 另计）。

## 0.50.60

**清掉失效的重放锚点；世代视图回归接入测试链。**

- set 不能再写 this 之后，重放不需要另找零点：删除 engine 里的 opsAnchorCallId 分支（约 15 行）；
- gentest 重写为跨实现比对：P1 预览行 == 提交后 self 的开头若干行；P2 self-1 == 提交前前缀；
- 删除 genview.mjs（被 rowsAt 取代的 WIP 期望模型）；
- gentest 接入 npm test。

全套 **13 套 / 269 条**（uitest 103 另计）。

## 0.50.59

**set 不再支持 this。**

- set 会被宏原样重放；重放时的 this 指向重放者（execute）而不是当初的 set，语义会飘；
- 工具层直接拒绝：option:"set" does not support this ... name the unit explicitly；
- execute 仍然支持 this；工具描述与 CONTRACT.md 同步；
- ptctest 里三处 set+this 用例改为具体单元，并重写 ⑦ 的断言（显式 replace 数、遮蔽区间、consumed）。

全套 **12 套 / 263 条**（uitest 103 另计）。

## 0.50.58

**retrospect 与 set 预览统一成「一个 fold，三个切点」。**

- 新增 messages.rowsAt(session, cut)：self / 历史 / 预览共用同一条取行管线；
- self 切点 = 承载本次调用的 assistant 消息；历史切点 = 冻结事件；预览切点同上再叠加假想 surfaceOp；
- 预览不再把本次调用自己画进去（旧实现多一条空 assistant 行：25 条 vs 实际 24 条）；
- 实测：预览正文 == 提交后 self 去掉调用单元后的内容，逐行一致；
- index 去掉 self 特判，retrospect 只剩一个入口。

全套 **12 套 / 261 条**（uitest 103 另计）。

## 0.50.57

**retrospect 统一成「前缀折叠 + 切点」：self 的切点 = 本次调用的 assistant 消息。**

- 旧做法按 toolCallId 剔除「本次调用的结果」，同一步多条调用时会留下**没有对应调用的孤儿 tool 行**（实测：self 末尾出现孤立 `Preview only`）；
- 新做法与历史世代同一条规则，只换切点：self 切在承载本次调用的 assistant 消息之前，历史切在冻结事件之前；
- 三条读取路径现在都是 fold(前缀)：self / 历史 / 预览（真事件+假想）；
- 副作用：self 不再包含本步其余工具结果（它们不属于「本次请求的输入」）。

全套 **12 套 / 261 条**（uitest 103 另计）。

## 0.50.56

**retrospect(self) 改为「全量折叠 − 本次调用自身」，不再用 seq 截止。**

- 旧做法：取最后一条 assistant 的 seq 做前缀截止；等价但隐含「最后一条 assistant 一定晚于所有已写节点」这个前提；
- 新做法：折叠当前工作面，只剔除承载本次调用的 assistant 消息与它的工具结果（按 callId，不按 seq）；实测两种写法在真实流程里等价，属于简化而非修 bug；
- 历史世代仍走日志前缀折叠（探针会话），边界改为承载 execute 的那条事件；
- 三条路径现在只差「折叠哪段日志」：预览=真事件+假想、self=全量、历史=前缀。

全套 **12 套 / 261 条**（uitest 103 另计）；gentest 仍为 WIP。

## 0.50.55

**世代视图性质测试（WIP）抓到的两个真 bug，已修。**

- set 预览把替代文本渲染成 user，真正提交后是 developer —— 预览骗了模型；现在两边同形（developer/message + 信封 turn/step/message）；
- 历史世代边界取「再往前一条 assistant」，会漏掉上一条 assistant 的 tool result（实测少 2 条）；现在直接用边界事件 seq 做前缀截止；
- retrospect(self) 增加 callId 锚点（cutoffForCall），不再用「最后一条 assistant」误裁提交后写入的替代节点；
- 新增 genview.mjs（世代视图规格）与 gentest.mjs（P1 预览 / P2 self / P3 self-1 三条性质），**尚未接入 npm test**：P2、P3 仍在红；
- 现有 12 套 / 261 条全绿。

## 0.50.54

**新增 PM 执行规格 pmspec.mjs（execute → surfaceOp，不依赖 DSH 消息推导）。**

- 规格是纯函数：工作面节点 + ops + 安全区锁 → 应写出的 replace 事件（区间 / sourceEventSeqs / 文本）；
- spectest.mjs 逐条比真实 flush 写出的事件，并带 30 例随机差分与 verify.js 审计；
- 系统提示拒绝独立成错误码 system-prompt，与 safety-zone 互不调用；
- CONTRACT.md 增加「执行规格」与「两种拒绝」两节。

全套 **12 套 / 261 条**（uitest 103 另计）。

## 0.50.53

**新增独立规格 oracle 与差分测试（oracle.mjs / oracletest.mjs）。**

- oracle.mjs 不 import engine/units：只从消息列表按规格推算 execute 之后应得的消息；
- oracletest.mjs 随机生成 40 个互不重叠的操作，比对「真实管线结果 = oracle 预测」，并校验事件不变量（每段 replace 必须是执行前工作面上的连续片段、互不重叠、显式事件数 = 操作数）；
- 差分测试立刻抓到真问题：unit 0（系统提示）无法被替换，但插件之前只在提交边界静默跳过；现在单元解析阶段直接报错；
- contract.mjs 补回错误矩阵（缺 option、越界、系统提示、旧区间写法、未知字段、窗口单值）。

全套 **11 套 / 239 条**（uitest 103 另计）。

## 0.50.52

**删除系统提示总纲，工具描述改中文并去重。**

- 移除 plastic-memories:guide 段落：定义只留在工具描述里；
- 三篇描述重写：统一「单元 / 选择器 / 操作 / 替代文本 / 会话日志 / 逻辑世代」等术语，删掉重复与开发者缩写；
- 修正过期说法（ops 不再支持多段、宏不再要求「单独成段」）；
- letter 描述改为「成功后会被自动隐藏、只能用 retrospect 读回」；
- 参数描述改中文并压缩到一行，不再复述工具描述里的语义；
- 新增 文案打磨-求助.md（理念 / 术语 / 待打磨文案 / 约束 / 待决问题）。

全套 **10 套 / 232 条**（uitest 103 另计）。

## 0.50.51

**positions / preview_positions / result_positions 全部改为单值。**

- op.positions：一个 op 只选一段、只产出一条替代文本；多段写多条 op；
- preview_positions / result_positions：单值选择器，要多段就多次调用；
- 删除 selectUnits 的多选择器路径与 normalizeSelectors，改为 normalizeSelector；
- 命令与工具继续共用同一套语法（命令 = 单值选择器 + 冒号 + 文本）。

全套 **10 套 / 232 条**（uitest 103 另计）。

## 0.50.50

**删除死字段 `types`。**

- spans 通道移除后 types 没有任何实现（只被归一化、从不被读取）；
- opshape 去掉字段与默认值，工具 schema 去掉枚举分支，契约文档同步；
- 现在只剩一个多值字段：`ops`（按设计如此）。

全套 **10 套 / 231 条**（uitest 103 另计）。

## 0.50.49

**重放改成 ops 数组里的宏元素，可在任意位置拼接。**

- 宏写作 `{ "the last plasticize(set)": true }`（也接受同名字符串），在所在位置原地展开成待决 set 的 ops；
- 宏只能出现一次，不能带其它字段，set 不能用；
- ops 的 JSON Schema 改成 oneOf：普通 op / 宏对象 / 宏字符串；
- unitops 先展开宏再做 op 校验，程序侧不必再拼两条 plasticize。

全套 **10 套 / 231 条**（uitest 103 另计）。

## 0.50.48

**统一成「ops 必填」，新增重放元素 `"the last plasticize(set)"`。**

- ops 在 set / execute 下都必填且非空；不再有「execute 可以空 ops」的特例；
- 兑现待决 set 改为显式重放：`ops:[{positions:["the last plasticize(set)"]}]`；
- 重放元素必须单独成段、且不能带 new_text / lock_this / types；
- 删除 `also_execute_last_set`（execute 不再隐式消费待决 set）；
- 新增 pending.js（unitops 与 index 共用），避免 unitops → plasticize 的循环依赖；
- 待决扫描跳过「ops 为空」与「ops 含重放元素」的非法 set。

全套 **10 套 / 230 条**（uitest 103 另计）。

## 0.50.47

**空 set 显式非法。**

- `option:"set"` 没有任何 op 时报 `option:"set" requires at least one op`；
- set 的全部意义是「给出可预览的下一代」，没有预览就没有 set；兑现待决 set 请用 execute（可省略 ops）；
- findLastPendingSet 的跳过规则改为防御性注释（旧日志残留的空 set 仍不会被当成待决）；
- contract.mjs 增加空 set / 空 ops set 两条断言。

全套 **10 套 / 233 条**（uitest 103 另计）。

## 0.50.46

**新增 contract.mjs：契约测试三层（语法 / 工具 / 行为）。**

- A 纯语法：选择器、命令文本、op 归一化、命令≡单元素 positions；
- B 工具层：JSON 参数直调 execute，覆盖 retrospect / plasticize / letter 的正常与错误路径；
- C 行为层：set→execute（省略 ops）、空 ops、无待决 set、安全区、重放一致性、世代计数；
- 修复 findLastPendingSet：ops 为空的 set 不再被当成待决（否则会挡住后面的 execute）；
- CONTRACT.md 补充世代计数与待决 set 的语义。

全套 **10 套 / 232 条**（uitest 103 另计）。

## 0.50.45

**ops 改为选填（默认 []）；删除 spans 旧语法；删除 retrospect 的 units 视图。**

- ops 不再是必填参数：execute 省略/传 [] 只兑现上一条 set，是否合法由「execute + 待决 set」合并后的塑形规则决定；
- 彻底移除 spans（cookie 区间）通道：opshape / index / engine / plasticize 全部只认 positions；spans.js 不再随包发布；
- 删除 unitretro.js 与 retrospect({units:true})；unit 号本来就在每行的 unit 字段里；
- compactMessages 改用 seq 对齐（deriveMessages 不带 seq，之前用 id 反查，测试夹具没有 id 就漏标 locked）；
- 移除只测 spans 的测试套（selftest / balanced / cookietest / autohide / persist / diffcheck / atomicity / livetest / zeroanchor），行为覆盖将由 contract.mjs 重建。

全套 **9 套 / 157 条**（uitest 103 另计）。

## 0.50.44

**execute 接受空 ops：只兑现上一条 set。**

- 实测（d013）：模型先 set 再发 `{option:"execute", ops:[]}`，被 “ops must be a non-empty array” 打回；
- 工具层现在按 engine 的语义过滤空批次：空 ops 不再送进解析器；
- 完全没有可执行批次（既无 ops 也无待决 set）时给出明确报错；
- globaltest 增加回归断言。

全套 **14 套 / 280 条**（uitest 103、livetest 97 另计）。

## 0.50.43

**去掉 PTC 门控，三个工具全局无条件注册。**

- 删除 tools.register 的 when 选项（standard/任意 preset 都能看到工具）；
- 删除 sessionOf 里的 preset 判定与 /plasticize 的预设检查；
- 结果窗口（preview_positions / result_positions）已经把“结果太大”这件事交给调用方控制；
- globaltest 改为断言三个工具都没有 when。

全套 **14 套 / 278 条**（uitest 103、livetest 97 另计）。

## 0.50.42

**结果窗口参数改名，避免和 ops[].positions 混淆。**

- plasticize 顶层 `positions` → `preview_positions`（只作用于 set 预览）；
- retrospect `positions` → `result_positions`；
- 内部 previewOf 选项同步改成 selectors，语义与 messages.windowRows 一致；
- 两者仍是同一套单元语法（unit 17 / unit 17 to 28）。

全套 **14 套 / 280 条**（uitest 103、livetest 97 另计）。

## 0.50.41

**retrospect 与 set 预览支持同一套 positions 结果窗口，非 PTC 也能限制结果大小。**

- 两个工具都新增顶层 positions（与 ops[].positions 同一套单元语法）；
- retrospect 只返回选中单元的行，附 total 与命中 units；行保持真实 n/unit；
- plasticize(set) 预览只列选中单元，并显示 “showing units ... of N”；
- 两者都拒绝 this（读取/命令路径没有调用锚点）；
- messages.js 拆出 groupRows / windowRows，预览与 retrospect 复用同一套单元裁剪；
- 修复 coords.clip 的空白正则写成 /s+/ 导致预览文本吃掉所有字母 s 的老 bug。

全套 **14 套 / 280 条**（uitest 103、livetest 97 另计）。

## 0.50.40

**命令里的 this 提前拒绝，并给出可执行的替代写法。**

- parseOpText 增加 allowThis（默认 true）；命令传 false；
- lock/hide/unlock 分支同样拒绝 this；
- 报错不再落到运行期的 "op #0: this is not resolvable"，而是一句话说明 this 的含义并提示写 unit 17；
- uitest 增加命令拒绝 this、工具仍允许 this 的断言。

全套 **14 套 / 275 条**（uitest 103、livetest 97 另计）。

## 0.50.39

**命令文本严格等价于「单元素 positions 的 op」。**

- UNIT_SELECTOR_SOURCE 收录 `this`，命令与工具的选择器词法完全一致；
- parseOpText 明确按 normalizeOp({positions:[冒号前那段], new_text:冒号后那段}) 实现；
- parseUnitRange 对 `this` 给出“需由调用方解析”的明确错误；
- uitest 增加不变式断言：四种写法下 parseOpText 与 normalizeOp 结果逐字节相同。

全套 **14 套 / 275 条**（uitest 101、livetest 97 另计）。

## 0.50.38

**命令与工具真正共用一套 op 语法，不再只是同一个文件。**

- normalizeOp 从 plasticize.js 移到新模块 opshape.js（plasticize 继续再导出）；
- opshape.js 新增 parseOpText：文本形式 `<selector>: <new_text>`，命令专用；
- commands.js 不再自带选择器正则，只做 kind 前缀 + parseOpText；
- unitops.js 的 op 校验改为调用同一个 normalizeOp，删掉重复规则；
- uitest 增加“命令 op 与工具 op 同源”断言。

全套 **14 套 / 275 条**（uitest 97、livetest 97 另计）。

## 0.50.37

**选择器语法收敛到唯一一处定义。**

- units.js 导出 `UNIT_SELECTOR_SOURCE`（非捕获），parseUnitRange 与 commands.js 都从它派生；
- commands.js 不再自带一份选择器正则；
- `this` 判定抽成 isThisSelector，unitops 不再写死字符串比较；
- 语法错误统一由 parseUnitRange 抛出。

全套 **14 套 / 275 条**（uitest 95、livetest 97 另计）。

## 0.50.36

**命令里的选择器用冒号终结，替代文本可以以 to 开头。**

- `/plasticize unit 17: 文本`：冒号是必须的终结符，`unit 17 to ...` 不再被误读成区间；
- `positions` 里的选择器可带尾随冒号（`"unit 17:"`）；
- 缺冒号时直接报错并给出正确写法；
- static 命令路径不再写 `interval: undefined`。

全套 **14 套 / 275 条**（uitest 95 条另计）。

## 0.50.35

**安全区只属于当前世代；positions 改成自然语言；preset 门控用官方读面。**

- retrospect 历史世代不再返回 locked（那时的锁还不存在）；self 才带 locked；
- unitView 去掉与 locked 重复的 safety；
- positions 改写为 `unit 17` / `unit 17 to 28`；`[17,28]` 这种数学写法直接拒绝并给出正确写法；
- /plasticize 命令同步支持带空格的选择器；
- preset 判定改用 agentPresets.presetForSession()，standard 会话不再出现 PM 工具。

全套 **14 套 / 275 条**。

## 0.50.34

**PTC 工具门控 + 会话投影安全。**

- 工具注册加 when：标准/非 PTC 会话不再列出 plasticize/retrospect/letter；
- 旧会话无 preset 记录时保持兼容；
- pmGenerations wire.summary:false；stateVersion 9；view 对任意 state 安全；
- 55e 捕获 22/22 一致；历史 g0 的 locked 单元可见。

全套 **14 套 / 275 条**。

## 0.50.33

**修复 pmGenerations 投影导致重启后会话不可用。**

- wire.summary:false，不再把整份世代 wire 塞进会话列表/打开基线；
- stateVersion 8→9；
- stateSchema 归一化缺字段；viewSchema 兜底；
- view() 对任何 state 都不抛，且同 state 返回同一引用；
- positions 文档明确：[3,7] 是两个单元，闭区间必须写字符串 '[3,7]'。

全套 **14 套 / 271 条**。

## 0.50.32

**compact messages 把 reasoning 计入 text。**

- assistant 只有 reasoning + tool-call 时，text 不再为空；
- textOf 接受任意 content block 的 text 字段；
- 50ca 的 7 号单元现在能看到思考正文。

全套 **14 套 / 271 条**。

## 0.50.31

**retrospect 收敛为模型可过滤的紧凑消息。**

- 去掉 role / boundary / safety / id / source；
- 每条 {n,unit,type,text,calls?,locked?}；
- type 按旧规则：system/user/developer/assistant/tool/agent/skill/other；
- locked 与 safety 合并；
- self 与历史都走 capture/DSH 消息前缀 + compact；
- preview=true 返回裁剪 text 的 messages。

全套 **14 套 / 271 条**。

## 0.50.30

**self retrospect 不再包含当前 assistant 输出。**

- 工具执行时当前 assistant/tool-call 已在 surface，但它不是本次请求输入；
- self cutoff = 最新 assistant/message 的 seq；
- 修复 self 12→14→16→18 的自增长；
- 878a 的 6 次 self 边界与 capture 逐字节一致（11/13/15/17/19/21）。

全套 **14 套 / 271 条**。

## 0.50.29

**retrospect 基线：DSH 消息管线 + Message[]。**

- 新增 messagesAt(session, cutoff)：日志前缀交给 DSH Session，deriveMessages()；
- self 返回当前 Message[]；
- 历史世代 cutoff = 产生该 execute 的请求，取边界前最后一条 assistant 的 seq；
- 返回 {logical,count,messages,letter}，不再返回手搓 {role,text,time}；
- 6d 会话 g0 与 capture 17/17 逐字节一致；
- units:true 保留旧单元迁移视图。

全套 **14 套 / 271 条**。

## 0.50.29

**retrospect 切到 DSH 消息管线，并以 capture 为基线。**

- messagesAt：日志前缀 → DSH Session → deriveMessages()；
- self 返回当前 Message[]；
- 历史世代取边界前最后一条 assistant 的 seq 作为输入 cutoff；
- 返回 {logical,count,messages,letter}，不再手搓 text 视图；
- units:true 保留旧单元视图；
- 基线：6d/5c/10bf 各 g0 与 capture 逐字节一致；76e5 的 11 个世代 11/11 一致。

全套 **14 套 / 271 条**。

## 0.50.28

**单元号对 tool/subtool 行做最近单元兜底。**

- 直接 unitOfSeq 查不到 sourceSeq 时，找 seq 距离最近的单元；
- 避免 tool 行没有编号、与 retrospect 编号错位；
- UI 排序仍保持旧实现。

全套 **14 套 / 269 条**。

## 0.50.27

**UI 回退到旧实现，仅加单元号。**

- client-glue.js / client-patches.js 恢复 old 分支的排序、分组、徽标逻辑；
- 去掉后来加的 firstCellIndex / toTurnModel / virtual row / page filter 等补丁；
- 只在正文前缀加 #n；
- 保留旧版物理/逻辑页签。

全套 **14 套 / 269 条**。

## 0.50.26

**虚拟行优先按 callId 归属单元。**

- tool/subtool cell 的 sourceSeq 可能缺失或不在 page.seqs；
- 现在用 meta.calls 建 callId→unit 映射，再按根 callId（:ptc: 前缀前）定位；
- 仍以 sourceSeq/最近 surface 作为兜底；
- 修复 #8 完成语被排到 #7 工具行之前。

全套 **14 套 / 269 条**。

## 0.50.25

**虚拟行按单元号重排，工具行跟随所属 assistant。**

- applyReshapeVirtualRows 不再原样返回；
- row 内 cell.sourceSeq 映射到当前页 unitOfSeq，取最小单元号；
- tool/subtool 行按最近 surface 单元归属；
- 修复完成语 #8 插在 #7 工具行之前。

全套 **14 套 / 269 条**。

## 0.50.24

**tool/subtool 行映射到所属 assistant 单元的 surface 位置。**

- tool/call、ptc-dispatch 的 sourceSeq 不在 page.seqs 时，按不大于 sourceSeq 的最近 surface seq 定位；
- 不再回退旧 cell.index；
- 修复完成语 #8 被插到 #7 与其工具调用之间。

全套 **14 套 / 269 条**。

## 0.50.23

**unlock all 恢复；只删除开区间语法。**

- 回退 0.50.22 的整段区间删除；
- unlock all 走 mode:all，不再把 all 当 selector；
- lock all 仍取消；
- 保留闭区间 [start,end]；
- 删除 (start,end)、[start,end)、(start,end] 等开/半开区间。

全套 **14 套 / 269 条**。

## 0.50.21

**turn 内 cell 按 surface pos 重排，并拆分交错的 step group。**

- 同一 turn 里 replacement developer 和后续 assistant 同属 step3 时，旧 group 会把 assistant 提前；
- 现在先把所有 cells 按 page.seqs 排序，再按原 group title 合并连续段；
- firstCellIndex 同步用 surface pos；
- L1 与 seq74 捕获 17/17 完全一致。

全套 **14 套 / 269 条**。

## 0.50.20

**回退展示层过度排序与重复徽标，恢复旧版 UI。**

- 移除 firstCellIndex / toTurnModel / cell.index 的额外重排，只保留旧版 records + layoutEntryOrder；
- 移除类型列重复的 diffTypeTag；差异徽标回到正文前缀，只显示一次；
- 移除历史页按 page.seqs 过滤节点，避免把 #7 等节点过滤掉；
- 只过滤 compaction 日志节点；
- 保留单元 #n 与逻辑世代。

全套 **14 套 / 269 条**。

## 0.50.19

**类型列重新显示被塑形/已塑形徽标。**

- 官方类型文字保留；
- 差异徽标同时注入类型列；
- 替换消息在后续世代页仍显示已塑形；
- 页面最终 turns/groups/cells 都由 __PM_SEQ_ORDER__ 排序。

全套 **14 套 / 269 条**。

## 0.50.18

**turn 内 step/cell 也按 surface 排序；已塑形跨页保留徽标。**

- toTurnModel 在渲染前按 __PM_SEQ_ORDER__ 重排 groups/cells；
- firstCellIndex 与 cell.index 都已 surface 化；
- 替换消息在后续世代页仍显示已塑形；
- 被塑形目标由 next replacement 的 shadowed 标记。

全套 **14 套 / 269 条**。

## 0.50.17

**修复展示层最后一次 cell.index 排序。**

- applyReshapeRecords 重排 records 后，把新的 surface 顺序写回 cell.index；
- 官方表格 firstCellIndex 不再按旧索引把 #8 排到 #6/#7 前面；
- 页面行顺序、单元号、retrospect 顺序一致。

全套 **14 套 / 269 条**。

## 0.50.16

**auto-hide 只在本次边界包含 execute 时运行。**

- 删除 autoOnly 路径；没有 plasticize 声明的请求边界不再 auto-hide；
- set/error/letter/retrospect 的 tool result 不会在模型消费前被吞；
- 这修复了“没调用 plasticize 却 auto-hide，导致 retrospect 无限循环”。

全套 **14 套 / 269 条**。

## 0.50.15

**auto-hide 不再吞掉最新 assistant 单元的结果。**

- auto-hide 跳过包含最新 assistant/message 的单元；
- retrospect / set / error 的 tool result 至少保留到模型消费一次；
- 修复模型看不到 retrospect 结果、无限重试的问题；
- 旧单元仍会在后续边界隐藏。

全套 **14 套 / 269 条**。

## 0.50.14

**世代页只渲染该页 surface 节点，单元号严格按页面顺序。**

- 历史世代页过滤掉不在 page.seqs 的 eventNodes；
- 单元号只从当前所选页的 unitOfSeq 取，不再回退到 live 页；
- 修复 #5/#8/#6/#7 这类非单调编号；
- 页面顺序 = API messages 顺序 = retrospect 单元顺序。

全套 **14 套 / 269 条**。

## 0.50.13

**空 developer 黑洞不再计入单元。**

- 自动隐藏/纯 hide 写出的空 developer 是 surface 空洞，不是模型消息；
- units 与 generations 的单元编号跳过这些空洞；
- retrospect(self).count 不再被 auto-hide 空洞逐步撑大；
- e2a3f045 当前单元数 12，与捕获的 API messages 数一致。

全套 **14 套 / 269 条**。

## 0.50.12

**修复 positions 在 tool set 预览阶段的解析。**

- tool handler 的 set/execute 预览分支原先直接调用 resolveOps，positions 会触发 op.spans is not iterable；
- 现在与 engine 一致，positions 走 resolveUnitOps，spans 走旧 resolveOps。

全套 **14 套 / 269 条**。

## 0.50.11

**世代页只显示模型消息。**

- 历史世代页过滤掉 compaction 等非消息节点；
- 不再合成/替换官方 compaction 行；
- 压缩只以 checkpoint 摘要消息的形式出现；
- 官方轨迹页保持自己的事件视图。

全套 **14 套 / 269 条**。

## 0.50.10

**物理页随 append 增长到下一个 replacement。**

- 当前物理页快照在 append 时更新，不再冻结在 replacement 那一刻；
- 因此 L2 页包含 C2 之后直到 C3 之前的全部消息；
- 官方 compaction 节点替换为下一条完整压缩，显示 C3 的 77 轮摘要；
- stateVersion 仍为 8（此前的 8 已包含 compactions 元数据）。

全套 **14 套 / 269 条**。

## 0.50.9

**官方压缩节点跟随正确的下一边界。**

- 保存 compaction start/summary/end/checkpoint 元数据；
- 每个世代页把官方 running compaction 节点替换为“下一条完整压缩”；
- L2 页显示 77 轮压缩摘要，而不是 40 轮 running 文案；
- stateVersion 升到 8。

全套 **14 套 / 269 条**。

## 0.50.8

**物理世代改为 replacement 之后的快照，压缩事件交给官方装配器。**

- page 0 是第一次 replacement 之前的初始 surface；
- page g 是完成 g 次 replacement 之后的 surface；
- compaction/start、summary、end 不再被 hiddenSteps/替代区间过滤；
- 页面 cutoff 包含 checkpoint；官方 trajectory-compaction 节点自行渲染“已压缩”；
- 移除自定义压缩边界 badge。

全套 **14 套 / 269 条**。

## 0.50.7

**恢复官方样式的压缩边界标记。**

- 旧页末尾在下一个 compaction 边界前显示“已压缩”；
- 使用官方 compacted 配色与 type tag 尺寸；
- 保留单行物理/逻辑 pager；
- 物理轴仍是唯一 surface 轴。

全套 **14 套 / 269 条**。

## 0.50.6

**pager 恢复旧版单行布局。**

- 物理页和逻辑页在同一行；
- 逻辑组用左侧分隔线隔开，不再上下两排；
- 顶栏高度回到旧实现；
- 保留物理轴 + 逻辑标签映射。

全套 **14 套 / 269 条**。

## 0.50.5

**恢复物理/逻辑两排页签。**

- 物理页仍为唯一 surface 轴；
- 物理页按钮只显示物理号；
- 逻辑页单独一排，L0..Ln 直接跳对应物理页；
- 移除物理按钮内联的 L 标签；
- 保留 #n 单元序号。

全套 **14 套 / 269 条**。

## 0.50.4

**回退到物理世代唯一轴；逻辑世代只是物理页标签。**

- G0 固定对应 physical 0；
- 每次边界只把逻辑标签挂到某个物理页；不再生成合成逻辑页；
- 最新物理页承载最新逻辑世代；
- pager 只显示物理页，逻辑号作为按钮内小标签；
- 移除双 pager、自定义“已压缩”徽标；压缩事件交回官方轨迹行。

全套 **14 套 / 269 条**。

## 0.50.3

**修复传统会话初始世代、压缩事件样式与双 pager。**

- 纯压缩会话显式加入 G0 初始页，压缩后依次为 G1..Gn；
- acb02be6 不再出现逻辑 2/3 指向同一物理页；
- 旧页末尾的“已压缩”改为官方 compacted 配色，并放回类型列；
- 世代栏同时显示物理页组和逻辑页组；
- 类型列显示 #n 单元序号。

全套 **14 套 / 269 条**。

## 0.50.2

**修复逻辑页重复、恢复物理/逻辑双 pager、序列号显示。**

- 压缩后无新物理页时，不再多造一个重复的“下一逻辑页”（acb 的 2/3 重复修复）；
- 世代栏同时显示物理页和逻辑页；
- 类型列显示 #n 单元序号；
- 移除 pm 兼容 preset；profile 的 selectedDefault 需改为 ptc；
- 保持 stateVersion 7 的 boundaries 持久化修复。

全套 **14 套 / 269 条**。

## 0.50.1

**修复世代边界丢失与 pm preset 兼容。**

- `generations.js` 的 surface append/replace 状态不再丢掉 `boundaries`；
- compaction checkpoint 先记边界再执行 surface replace，物理页和逻辑页一致；
- `GENERATIONS_STATE_VERSION` 升到 7，旧投影缓存失效；
- 重新生成 `pm` 兼容 preset：等价 PTC（保留 compaction），不重复挂 PM 插件，修复 `Unknown agent preset: pm`；
- 新增压缩边界跨后续 append 的回归测试。

全套 **14 套 / 269 条**。

## 0.50.0

**通用 PTC-only 重构（WIP）：取消 PM preset/cookie，改为世代单元序号。**

- `retrospect(self)` 返回当前世代单元数组，0 起；系统提示词 = 0；assistant + 工具结果 = 一个单元；
- `plasticize` 使用 `positions` 单元序号；`this` 自噬替换生成 execute 的单元；
- retrospect 默认 `preview:true`；单元含 type / autoInjected / safety / locked；
- 自动隐藏：所有 set、报错 PM 工具、letter、retrospect；execute 不自动隐藏；
- 安全区改为单元序号，最多 64 单元；自动补充类型不可锁；压缩后重放锁定原文；
- 逻辑边界合并 PM private events 与成功 compaction checkpoint；
- bundle 全局注册，不再依赖 PM preset；生产 cookie 注入移除；
- 世代选项卡显示当前世代 `#n`，逻辑 pager 优先；

当前全套 **14 套 268 条**。

## 0.49.14

**新增独立 PM 语义审计器 verify.js + verifytest。**

- 不 import engine，直接回放事件检查：sourceEventSeqs/refs 是否精确等于 shadowed surface、替代内容与 op 形状、declaration/failed 对应、逻辑事件编号与物理页、锁记录是否在 surface/已锁/prelock 目标；
- 在最新真实会话 76e53f1c 上审计 0 错误；
- verifytest 覆盖正常通过 + sourceEventSeqs 缺节点/替代内容错误/锁定非 surface seq 三类变异均能抓出；
- 这是“翻译结果事件级一致性”审计；ops→区间的独立参考解释器仍可作为下一层 differential 校验。

全套 **18 套 670 条**。

## 0.49.13
