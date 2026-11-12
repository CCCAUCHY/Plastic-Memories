# dsh-plugin-plastic-memories-h0

> **v0.50.49 通用版（任何 preset）**
>
> Plastic Memories 把 DSH 的 surfaceOp 从“压缩插件专用”变成模型可主动使用的可塑投影。
> 底层 trajectory 不删除；插件只改当前模型上下文里的 surface。

## 版本边界

- v0.50.49 起是**通用工具**，不要求 PM preset；
- 只支持 **PTC**：`retrospect(self)` 的单元定位依赖 `run_code` 代码过滤；
- 生产 cookie 注入已移除；
- 旧 PM preset / cookie 语义在 git 分支 `old`（fe676aa）中保留。

## 三层

```text
Trajectory  不可变历史事实（session log）
Surface     历史的可塑投影（surface.nodes）
Context     Surface 在模型输入里的具体形态（deriveMessages）
```

## 世代与单元

- 逻辑世代 0 起；
- 每个成功 execute / 用户投影 = 一个边界；
- 每个成功的压缩 checkpoint = 一个边界（自动、手动都算）；
- 0 是系统提示词；
- 一个单元 = assistant 消息 + 它的一条工具结果（可含多个工具结果）；
- 工具结果不单独编号；
- 世代选项卡显示 `#n`，与 retrospect 单元序号一致。

压缩后逻辑边界：

```text
N = L + 1 + M
L = 上一个私有事件逻辑号（没有则 -1）
M = L 与 N 之间成功压缩 checkpoint 数
```

## 工具

### `retrospect`

```js
retrospect({ generation: "self" })
```

返回当前世代单元数组：

```json
{
  "logical": 3,
  "count": 42,
  "preview": true,
  "units": [
    { "n": 0, "type": "system", "safety": false, "text": "..." },
    { "n": 1, "type": "user", "safety": false, "text": "..." }
  ]
}
```

- 默认 `preview:true`，只裁剪文本；
- `type`：`system` / `user` / `assistant` / `agent` / `skill` / `other`；
- `agent` = AGENTS.md 自动注入；
- `skill` = 技能目录或技能工具；
- `other` = 其他低频自动注入；
- 单元带 `locked`（仅当前世代；历史世代不返回安全区）。

### `plasticize`

```js
plasticize({
  ops: [{ positions: ["unit 3", "unit 4"], new_text: "..." }],
  option: "execute"
})
```

- `positions`：当前世代单元序号，写 `"unit 3"` 或区间 `"unit 3 to 7"`，`"this"` 指本次调用所在单元；
  每个元素只选一个单元（`["unit 3", "unit 4"]` 是两个单元，不是区间）；
- 每个选中单元整体命中（assistant + tool result）；
- 前面的段隐藏，`new_text` 落在最后一段；
- `this` 自噬：替换生成这次 execute 的单元，可用于隐藏自身；
- `option:"set"` 只预览，`execute` 在提交边界落地；
- 自动隐藏：所有 set、报错 PM 工具、letter、retrospect；execute 不自动隐藏。
- 结果窗口：`option:"set"` 时可以再传 `preview_positions`（同一套单元语法，但与 `ops[].positions` 是两个东西），预览只列这些单元；结果显示 “showing units ... of N”。execute 忽略该参数。
- `retrospect` 对应的是 `result_positions`；
- 目的：非 PTC 模式拿不到 run_code 过滤，只能靠参数主动把工具结果压小；工具本身是全局注册的，任何 preset 都能用。

### `letter`

给未来世代的便签；自动隐藏该调用单元。

## 安全区

- 单位是单元序号；命令里选择器与替代文本用冒号分隔（`unit 17: 文本`），否则替代文本以 `to` 开头会被当成区间；
- 最多 64 单元；
- 用户命令：

```text
/plasticize unit 17: 新的替代文本
/plasticize unit 17 to 28: 折叠成一段摘要
/plasticize lock unit 3 to 7
/plasticize unlock all
```

- `lock all` 已取消；`unlock all` 可解除当前世代全部安全锁；
- autoRefresh 类型（runtime-context、agent-instructions、skill-catalog）不可锁；
- plasticize 命中安全区报错；自动隐藏遇到锁定单元跳过；
- 压缩后只重放被压缩的锁定消息，按原顺序；
- DSH surfaceOp 没有 insert，重放追加在 surface 末尾；
- 引言使用位置无关措辞：

```text
A condensed summary appears earlier in this context. Below is verbatim content from a subset of the messages it covers:
```

```text
End of verbatim content from the summarized messages.
```

## 压缩兼容

- 自动、手动压缩都产生逻辑世代；
- 旧页末尾的压缩事件是 UI 展示，不是模型消息；
- 新页第一条非 system 消息是 checkpoint 摘要；
- AGENTS / skill catalog / runtime-context 依赖 DSH 自身刷新，不设隐式安全区。

## 安装

标准 bundle 安装：

```bash
dsh plugin --profile web2 add file:/绝对路径/可塑性记忆/dist/dsh-plugin-plastic-memories-h0-0.50.49.tgz
```

开发 stage：

```bash
./install-pm.sh stage
dsh plugin --profile web2 add link:/var/data/dsh-workspace-Flatpak/可塑性记忆/staged/dsh-plugin-plastic-memories-h0
```

冷启动 profile 后生效。

## 测试

```bash
npm test
```

当前 **14 套 / 269 条**：

- selftest 61
- integration 25
- unitest 17
- globaltest 5
- ptctest 43
- multicall 20
- balanced 19
- persist 16
- zeroanchor 21
- groupingtest 13
- diffcheck 4
- contexttest 4
- verifytest 5
- versioncheck 15

## 已知限制

1. 安全区重放无法严格插在摘要和 retained tail 之间（DSH 无 insert）；
2. 旧世代页末尾“已压缩”事件行仍未单独渲染；
3. 旧 cookie / hooks / atomicity 测试属于 old 分支语义，不在新测试链；
4. 实际 web2 冷启动后的运行时工具挂载尚未验证（bundle config 已确认）。
