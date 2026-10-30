# Plastic Memories — 工程说明（中文）

DeepSeek Harness（DSH）的实验性插件。可塑记忆研究“可塑上下文”：会话对模型可见的上下文，是不可变轨迹日志的可塑投影。

## 核心理念

- Trajectory 是不可变的历史（只追加的会话日志）。
- Surface 是历史的可塑投影（surfaceOp: append | replace）。
- Context 是 Surface 在模型请求中的具体存在形态。

插件在官方 surface 之上加了一层投影：会话可以把历史塑形（压缩/隐藏/替代）成一个世代，并在世代间切换而日志不丢。

## 能力

- plasticize / retrospect 工具，以及 /plasticize /retrospect 命令：只追加的 surfaceOp。
- 会话模式隔离预设（PM · 可塑记忆），其他 DSH 模式不加载插件。
- Cookie 夹逼：主动发送的用户消息两侧必有 cookie；运行时上下文快照不夹逼。
- 世代选项卡：官方轨迹页面的私有化 1:1 复刻，任意世代由官方装配器重建；最新（live）世代永不缓存。
- 相邻世代差异：第 k 代替代消息标 已塑形（跳到 k-1）；第 k-1 代里即将被覆盖的消息标 被塑形（跳到 k）；行本身仍是官方行。
- 事实源与一致性：投影 fold 与官方 foldSurface 做影子会话逐代差分校验；运行期自检告警；展示层从不写回日志或请求。

## 安装

    ./install-pm.sh stage
    dsh plugin --profile web2 add link:/path/to/staged/dsh-plugin-plastic-memories-h0

重启 dsh 并强制刷新；选择 PM · 可塑记忆 会话模式。

## 目录

- pm-h0/ 宿主插件、命令、投影 fold、测试
- pm-h0/client-glue.js 客户端 bridge、世代选择、差异徽标
- pm-h0/build-client.mjs + client-patches.js 私有化并修补官方轨迹 bundle
- pm-h0/trajectory-vendor.js 官方 bundle 副本（见下）
- docs/images 截图

## 测试

    cd pm-h0 && npm test

17 套 / 602 条断言：cookie 夹逼、组合平衡、步骤原子性、官方 fold 差分、官方上下文链、UI 桥接、版本与打包守护。

## 官方 bundle 副本

pm-h0/trajectory-vendor.js 是 DSH @deepseek-ai/dsh-client-ui-trajectory 客户端 bundle 的逐字节副本，由 build-client.mjs 私有化。仅用于实验自包含；再分发前请确认上游许可证。升级时从 DSH 安装目录复制 node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js 后执行 node build-client.mjs。

## 许可证

见 LICENSE。

## 未包含的内容

内部交接/过程文档，以及测试套件使用的真实会话日志夹具，均有意不公开。
如需在本地跑测试，请把自己的会话导出放到 pm-h0/fixtures/ 下，并使用同名文件。

## 预构建安装包

可直接安装的 tgz 已提交在 dist/ 下（link/staged 安装方式属于本地开发，不发布）。
    dsh plugin --profile <profile> add file:$PWD/dist/dsh-plugin-plastic-memories-h0-0.28.4.tgz
## 与 DSH 原生机制的关系：系统提示词更新也是 surfaceOp replace

自动压缩与系统提示词更新同样会通过 `surfaceOp: replace` 改写 surface。因此在世代视图中，它们产生的替代行也会显示「已塑形」，被它们覆盖的消息会显示「被塑形」——和 PM 的 plasticize 完全同一套视觉语义。

PM 的世代投影把**每一条 surfaceOp replace 都视为一个物理世代**。这不是缺陷，也不应特判：

- DSH 的原生 surface 机制以 `surfaceOp: replace` 作为统一改写原语；自动压缩、系统提示词更新、PM 的 plasticize 都只是它的不同调用者；
- PM 的工具、安全区、逻辑世代，都是建立在该原语之上的**真子集扩展**；
- 我们的物理世代号与 DSH 的 `replaceGeneration` 一一对应，不维护第二套编号；
- 当 DSH 增加新的 surface 改写来源时，PM 会自动把它呈现为新的“世代”，无需枚举或过滤来源——这是可预见的优雅回退；
- 展示层沿用 PM 语义（已塑形 / 被塑形），体现语义包容度：任何一次 surface 重写，本质上都是一次“塑形”。

如果未来需要在 UI 上区分 PM 与官方操作，只需在展示层读取替代节点的 `source.kind`（PM 为 `"pm-surface"`）；数据层仍以 `surfaceOp` 为唯一事实。