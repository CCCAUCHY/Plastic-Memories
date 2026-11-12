# PM 契约（工具 / 命令）

这份文件是**语法与语义的唯一清单**。contract.mjs 用两种输入测它：

- 工具：构造 JSON 参数，直接调 `execute(args, { agent: { session } })`；
- 命令：构造纯文本，直接调 `parsePlasticizeCommand(text)`。

---

## 1. 选择器语法（units.js 唯一权威）

| 写法 | 含义 |
|---|---|
| `unit 17` | 单元素 |
| `unit 17 to 28` | 闭区间，含两端 |
| `unit 17 through 28` / `til` / `-` / `–` | 同上 |
| `17`（数字或数字字符串） | 单元素 |
| `unit 17:` | 同上（尾随冒号可选） |
| `this` | 仅工具路径：承载本次调用的单元 |

被拒绝：`[17,28]`、`(17,20)`、`unit 20 to 17`（起点大于终点）、空字符串。

---

## 2. `plasticize`（工具）

### 参数

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `option` | `"set"` \| `"execute"` | 是 | set 只预览；execute 在提交边界落地 |
| `ops` | array（非空） | 是 | 段落列表；兑现待决 set 用重放元素，见下 |
| `preview_positions` | 单个选择器 | 否 | **仅 set 有用**：预览只列这个选择器命中的单元；execute 忽略 |

### 一个 op

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `positions` | 单个选择器 | — | 必需；**单值**（`"unit 5"` / `"unit 5 to 9"` / `"this"` / 数字）。一个 op 只选一段、只产出一条替代文本；多段请写多条 op |
| `new_text` | string | `""` | 这条 op 的替代文本；空串 = 纯隐藏 |
| `lock_this` | boolean | `false` | 把替代消息本身锁进安全区 |

未知字段直接报错；`positions` 不是合法选择器（含数组）直接报错。

> `types` 已删除：spans 通道移除后它没有任何实现，属于死字段。

### 语义

- 每个选中单元整体命中（assistant + 它的全部 tool result）；
- 选择器命中的整段被 `new_text` 取代（空串即纯隐藏）；要拆成多段就写多条 op；
- 一次 run_code 程序（或一条 assistant 消息）只允许一次 plasticize 调用（set/execute 同计）；
- 命中安全区报错；
- 成功 execute 后，早于它、含失败 PM 调用 / set 预览 / 成功 letter / 成功 retrospect 的整个单元会被自动隐藏；execute 回执本身保留。

### 世代计数

- **物理世代**：每次 surface replacement 加一，包括自动隐藏写出的空替代；
- **逻辑世代**：每次成功的 execute 加一（自动隐藏不另计）；
- 因此「一次 set+execute」通常产生 2 个物理页、1 个逻辑世代。

### 重放待决 set（ops 宏）

`ops` 的每个元素要么是一条 op，要么是这个宏：

```json
{ "option": "execute", "ops": [
  { "the last plasticize(set)": true },
  { "positions": ["unit 5"], "new_text": "X" }
] }
```

- 宏在**所在位置原地展开**成待决 set 的 ops 数组（顺序保持），等价于把那份 ops 抄过来；
- 宏**只能出现一次**；
- 宏不能带其它字段（`new_text` 等）；
- `option:"set"` 不能用宏（set 必须自己带 ops 才有预览）；
- 没有待决 set 时报 `there is no pending plasticize(set) to replay`。

不写宏时，`execute` **不会**消费待决 set。

### set 的合法性

`ops` 在两种模式下都必填且非空：`option:"set"` 没有 op 就没有可预览的下一代。

### 返回（`{ text }`）

- `Preview only (not committed). The next generation would contain N messages[ (showing units a, b of T)]:` + 逐行预览；
- `Registered K segment(s); they will be written at the next submission boundary.` + `Logical generation L (pm-logical-generation=L).` + 每个批次的段数。

### 错误（消息要可断言）

`option must be "set" or "execute"`、`ops is required (an array of ops)`、`ops must be a non-empty array`、
`option:"set" requires at least one op`、`option:"set" cannot replay the last set`、
`there is no pending plasticize(set) to replay`、`"the last plasticize(set)" must be the only position in its op`、
`op #N: ...`（来自 opshape / unitops）、`operation touches the safety zone ...`。

---

## 3. `retrospect`（工具）

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `generation` | integer \| string | 必需 | 绝对世代号、`"self"`、`"self - N"` |
| `preview` | boolean | false | true 时裁剪每条 text |
| `result_positions` | 单个选择器 | — | 结果窗口；`this` 被拒绝。要多段就多调一次 retrospect |
| `units` | boolean | false | 内部迁移用：返回旧单元视图 |

### 返回（JSON 字符串）

```json
{
  "logical": 1,
  "count": 9,
  "total": 22,          // 仅当给了 result_positions
  "units": [5, 6],      // 仅当给了 result_positions
  "messages": [{ "n": 5, "unit": 5, "type": "user", "text": "..." }],
  "letter": [{ "index": 7, "text": "...", "time": 0 }]   // 仅当该世代有 letter
}
```

- 行内字段：`n`（顺序，从 0）、`unit`（plasticize 的位置）、`type`（system/user/developer/assistant/tool/agent/skill/other）、`text`、`calls?`、`locked?`（**仅当前世代**）；
- `self` 用的是「本次请求的输入」：截到最新 assistant 之前；
- 历史世代用的是产生该世代 execute 的那次请求的输入；
- `preview: true` 只裁 text，结构不变。

### 错误

`generation is in the future...`、`generation is out of range...`、
`result_positions 不能用 this...`、`result_positions entries must be ...`、`unit 999 is out of range ...`。

---

## 4. `letter`（工具）

| 字段 | 类型 | 必需 |
|---|---|---|
| `text` | string | 是 |

返回 `{ text: "Registered." }`。无副作用：不写 surface、不产生世代。

---

## 5. `/plasticize`（命令，纯文本）

| 输入 | 结果 |
|---|---|
| `clear` | 清空待落盘操作 |
| `prelock` | 下一条用户消息纳入安全区（同时只能有一条） |
| `lock <selector>` | 纳入安全区 |
| `unlock <selector>` | 移出安全区 |
| `unlock all` | 解除当前世代全部锁（要求当前无待落盘操作） |
| `hide <selector>` | 纯隐藏 |
| `<selector>: <text>` | 替换（冒号是终结符，text 可含任意字符与换行） |
| `<selector>` | 纯隐藏（等价 `new_text: ""`） |

- 选择器使用第 1 节语法；**`this` 被拒绝**（命令没有调用锚点）；
- 命令不写日志：放进内存待办，**发送下一条用户消息时**才约化写入；
- 待办之间不得重叠；`unlock all` 与其它待办互斥；
- 安全区上限 64 个单元；autoRefresh 单元（runtime-context / agent-instructions / skill-catalog）不可锁。

### 返回（命令 handler）

`{ kind: "success" | "error", text }`。

---

## 6. 命令 ↔ 工具的等价关系（不变式）

```
parsePlasticizeCommand("<selector>: <text>")
  ≡ normalizeOp({ positions: ["<selector>"], new_text: "<text>" })
```

即：**命令文本 = 单元素 positions 的 op，外加冒号终结符**。
两种入口最终都进 `unitops.resolveUnitOps` 解析成 seq。

---

## 7. 待测矩阵（contract.mjs）

| 组 | 输入 | 期望 |
|---|---|---|
| A 选择器 | `unit 17` / `unit 17 to 28` / `17` / `unit 17:` | 解析出正确单元集合 |
| A 选择器 | `[17,28]` / `(17,20)` / `unit 20 to 17` | 报错 |
| B plasticize | set + `preview_positions` | 预览只含选中单元，带 of N |
| B plasticize | execute + `ops: []` + 待决 set | 成功登记 |
| B plasticize | execute + `ops: []` + 无待决 set | 明确报错 |
| B plasticize | set + `also_execute_last_set` | 报错 |
| B plasticize | op 带 spans、未知字段、空 positions | 报错 |
| B plasticize | `types` 非法枚举 | 报错 |
| B plasticize | 命中安全区 | 报错 |
| C retrospect | `self` / `"self - 1"` / `0` | 结构与计数正确 |
| C retrospect | 未来世代 / 越界 | 报错 |
| C retrospect | `result_positions: ["this"]` | 报错 |
| C retrospect | `result_positions` 越界 | 报错 |
| C retrospect | 历史世代 | 不含 `locked` |
| D letter | `{text}` | `Registered.` |
| E 命令 | 上表每种写法 | 返回正确的 kind/mode/positions/newText |
| E 命令 | `this: x` / `lock this` | 报错并提示写具体单元号 |
| E 命令 | `unit 17 文本`（缺冒号） | 报错并提示加冒号 |
| F 状态机 | set → execute（同批） | 只写一条 replace |
| F 状态机 | 重叠待办 / 重复 prelock | 报错 |
| G 不变式 | 四个样本文本 vs 等价 op | 逐字节相同 |
