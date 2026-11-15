# dsh-plugin-plastic-memories-h0

> **v0.50.85 通用版（任何 preset）**
>
> 让模型主动编辑自己「过去」的呈现：改写当前上下文里的一段，但会话日志一条不删。

## 它做什么

- **只改呈现，不删记录。** 被隐藏的消息仍在会话日志里，之后可以用 `retrospect` 读回；
- **每次成功写入推进一个逻辑世代**，历史世代可按编号读回；
- **安全区**：用户可以锁定某些单元，模型改不动，命中即报错；
- **自动隐藏**：成功写入后，早先的噪音单元（失败的调用、成功的 letter / retrospect）自动收起。

## 三层

```text
Trajectory  不可变历史事实（session log）
Surface     历史的可塑投影（surface.nodes）
Context     Surface 在模型输入里的具体形态（deriveMessages）
```

## 世代与单元

- 逻辑世代从 0 起，每次成功写入加一；每次成功的压缩 checkpoint 也算一个边界；
- unit 0 是系统提示词；
- 一个单元 = 一条 assistant 消息 + 它的全部工具结果；工具结果不单独编号；
- 世代页签上的 `#n` 与 `retrospect` 返回的 `unit` 一致。

## 工具

### plasticize

```js
plasticize({
  ops: [
    { positions: "unit 3", new_text: "..." },
    { positions: "unit 5 to 7" }              // 空文本 = 隐藏
  ]
})
```

- `positions` 是**单值**：`unit 3` / `unit 3 to 7`（闭区间）/ `this`（承载本次调用的单元）/ 数字；
- 一条 op = 一个选择器 + 一条替代文本，对应一次替换；要改多段就写多条 op，且不得重叠；
- 写入发生在**下一个提交边界**，不是调用当下；边界上失败会留下说明，不会静默失败；
- 一次程序（或一条消息）只能调用一次 plasticize；
- `lock_this: true` 把替代文本本身放进安全区；
- `unit 0`（系统提示）只读。

### retrospect

```js
retrospect({ generation: "self" })
retrospect({ generation: "self - 1", messages_position: "unit 5", head: 200, tail: 80 })
```

返回：

```json
{
  "logical": 3,
  "units": 42,                                  // 这一代的总单元数
  "messages": [{ "unit": 5, "role": "user", "text": "..." }],
  "letters": [{ "index": 7, "text": "...", "time": 0 }]    // 有便条时才有
}
```

- 行字段：`unit` / `role`（system、user、assistant、developer；工具结果与它的 assistant 同角色）/ `text`；assistant 行可能带 `calls`，当前世代被锁定的行带 `locked`；
- `messages_position` / `letters_position`：只取命中单元的部分，写 `none` 表示不要这一部分；
- `head` / `tail`：每条 `text` 保留开头 N 与结尾 M 个字符（超长才裁）；
- `self` 读的是**本次调用之前**的上下文；历史世代读的是它冻结前模型最后一次收到的输入。

### letter

```js
letter({ text: "给未来世代的一句话" })
```

- 便条不留在当前上下文：成功调用后，该单元会在下一次成功写入时被自动隐藏，之后只能用 `retrospect` 的 `letters` 读回；
- 不写上下文、不产生世代。

## 用户命令

```text
/plasticize unit 17: 新的替代文本
/plasticize unit 17 to 28: 折叠成一段摘要
/plasticize hide unit 3
/plasticize lock unit 3 to 7
/plasticize unlock all
/plasticize prelock
/plasticize clear
```

- 选择器与替代文本用冒号分隔；命令里不能用 `this`（它指模型本次调用所在的单元）；
- 最多锁定 64 个单元；自动注入的消息（runtime-context / agent-instructions / skill-catalog）不可锁定；
- 命令产生的操作与工具走同一套解析，同样在提交边界落盘。

## 写入协议（WAL）

```text
1. plugin:plastic-memories/commit { callId, from, to, count, hash }   ← 先落盘
2. 数据事件（替换、安全区锁、自动隐藏、世代边界）
3. plugin:plastic-memories/commit-checkpoint { upTo }                 ← 整批写完才落盘
```

- 每次 flush 回溯最后一条标记：遇到 commit 就重算哈希比对，遇到 commit-checkpoint 就跳过；
- 哈希不符或事件缺失 → 记录 `damaged` 并给模型一条提示（不阻止后续写入）；
- 回溯上限 2000 条事件，扫不到标记按「太旧、不查」处理。

## 安装

```bash
dsh plugin --profile web2 add file:/绝对路径/可塑性记忆/dist/dsh-plugin-plastic-memories-h0-0.50.85.tgz
```

开发用 stage：

```bash
./install-pm.sh stage
dsh plugin --profile web2 add link:/var/data/dsh-workspace-Flatpak/可塑性记忆/staged/dsh-plugin-plastic-memories-h0
```

冷启动 profile 后生效。

## 测试

```bash
npm test        # 12 套 / 252 条
node uitest.mjs # UI 103 条
```

## 已知限制

1. DSH 的 surfaceOp 没有 delete：隐藏只能表示为一个「推导为空」的 developer 节点，节点本身仍占 seq；
2. 安全区重放无法插在摘要与保留段之间（DSH 无 insert），只能追加在末尾；
3. 批量写入不是原子的：崩溃可能留下半批，靠 WAL commit 校验发现，无法自动修复（DSH 无截断 API）；
4. 旧 PM preset / cookie 语义仅保留在 git 分支 old（fe676aa）。
