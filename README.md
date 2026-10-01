# Plastic Memories

> A DSH plugin for maintaining a clean, reversible, model-facing context surface over a persistent session trace.

**Plastic Memories** is an experimental context-management plugin for DeepSeek Harness (DSH).

It does not implement a traditional memory system.

It does not ask the model to maintain a `MEMORY.md`, and it does not create a second, long-lived source of truth.

Instead, it treats the persistent session trace as the source of truth and the model-visible conversation as a mutable projection of that trace.

The past is never forgotten. Only the present representation of the past is plastic.

---

# 可塑性记忆

> 一个建立在持久会话轨迹之上的 DSH 上下文管理插件，用于维护干净、可逆、面向模型的当前上下文视图。

**Plastic Memories** 是一个面向 DeepSeek Harness (DSH) 的实验性上下文管理插件。

它不是传统意义上的 Memory 系统。

它不会要求模型维护一个 `MEMORY.md`，也不会建立一个独立的、长期存在的“AI 记忆库”。

它采用一个更简单的原则：

> **持久化 Session Trace 是事实源，模型当前看到的 Conversation 只是这个 Trace 的一个可塑投影。**

过去不会被遗忘。

只是过去在当前上下文中的呈现方式可以不断改变。

## Motivation / 动机

Long-running agents accumulate a large amount of historical material:

tool output, failed attempts, temporary observations, repetitive reasoning, superseded conclusions, control chatter, stale environment state, and other information that was useful once but should no longer occupy the model's active context.

长时间运行的 Agent 会不断积累历史材料：

工具输出、失败尝试、临时观察、重复推理、已经被后续结论取代的判断、控制性聊天内容、过时的环境状态，以及其他曾经有用、但现在已经不应该继续占据模型当前上下文的信息。

任务本身可能很困难，甚至可能具有很强的路径依赖性，因此无法被安全地压缩成一个短摘要。

但：

> **任务不可压缩，不意味着整个历史轨迹都必须永远处于 active context。**

Plastic Memories 的目标不是把所有历史压得更短，而是把**当前工作状态保持得更干净**。

```text
Persistent History
        │
        ▼
Current Active Surface
        │
        ▼
      Model
```

完整历史始终保留，可以随时检查与恢复。

当前 Active Surface 则持续针对当前任务进行维护。

---

## Design Principles / 设计原则

### Trace is the source of truth / Trace 是事实源

The complete session trajectory remains persistent and recoverable.

完整的 Session trajectory 永久保存，并且可以恢复。

从 active context 中移除某段内容，不意味着这段历史被删除。

DSH 已经提供了 append-only 的 Session Event Log，并通过 `session.deriveMessages()` 从事件日志动态导出模型可见的消息历史。其 surface replacement 通过追加新的事件来表达，而不是修改底层历史记录。

```text
Historical Truth
       │
       ├── remains immutable
       │
       └── can be inspected or reused
```

因此：

> **历史是不可破坏的，当前视图是可以改变的。**

### Context is a view / Context 是一种视图

The model should not be forced to carry every historical event simply because the event happened.

模型没有必要仅仅因为某件事情发生过，就永远携带它。

Active conversation 是历史轨迹的一种 projection。

```text
Trace
  ├── A
  ├── B
  ├── C
  ├── D
  ├── E
  └── F

Active Surface
  ├── A
  ├── C
  └── F
```

此时 `B`、`D`、`E` 并没有消失。

它们只是暂时不在模型的 active working set 中。

### Reversible instead of destructive / 可逆，而不是破坏式删除

Context management should be safe precisely because it is reversible.

上下文管理之所以可以大胆进行，是因为它应该具备可逆性。

如果模型后来发现某个已经隐藏的历史信息仍然重要，它可以重新检查 Trace 并恢复所需状态。

如果当前 reasoning trajectory 本身出现问题，则可以从更早的 checkpoint fork 出一条新的未来，而不是试图篡改过去。

```text
Old Branch
0 ───── 20 ───── 50 ───── 100
            │
            └── New Branch
                20 ───── 35 ───── 60
```

Fork 的含义不是：

> “修改历史。”

而是：

> **“从这个过去重新选择未来。”**

### No autonomous global memory / 不提供自主全局记忆

Plastic Memories intentionally does not provide an AI-managed global memory database.

Plastic Memories 不提供由 AI 自主维护的全局 Memory 数据库。

原因很简单：

一份长期存在的 Memory 文档本身就是一个新的事实源，而它是否仍然有效、属于哪个时间阶段、是否已经被后续事件推翻，往往无法可靠判断。

因此：

> **Session-specific knowledge 应保留在 Session Trace 中。**

> **长期用户偏好应当由用户明确维护为 bootstrap 配置。**

模型可以帮助用户拟稿，但不应该拥有“偷偷修改所有未来 Session 默认行为”的能力。

---

# Core Operations / 核心操作

Plastic Memories exposes a small set of semantic operations.

Plastic Memories 只需要提供少量基础语义操作。

### `STABILIZE`

When a reasoning segment has finished its useful work, the model may stabilize it into a concise state representation and replace the verbose historical material on the active surface.

当一段推理已经完成它的主要认知工作时，模型可以把它稳定化为一个简洁的状态表示，并用新的状态替换当前 surface 上的冗长过程。

原始历史仍然存在。

```pseudo
function STABILIZE(range):
    state = summarize_for_continuation(trace, range)

    append_event(
        type = "message",
        content = state,
        surfaceOp = REPLACE(range)
    )

    return state
```

这里的 summary 不是历史的替代品。

它只是：

> **当前工作状态的新的物化表示。**

### `HIDE`

Remove information that is no longer useful to the current working state without claiming that the information never existed.

隐藏已经不再影响当前工作的历史材料，但不声称这些材料从未存在。

典型对象：

```text
temporary tool output
failed commands
control chatter
duplicate reasoning
obsolete observations
stale intermediate state
```

```pseudo
function HIDE(range):
    append_surface_replacement(
        range = range,
        content = null
    )
```

底层可以利用 DSH 现有的 surface projection / replacement 机制实现，而无需删除历史事件。

### `INSPECT_TRACE`

Recover historical information when the active surface is insufficient.

当当前 active state 不足以继续可靠推理时，模型可以主动检查原始轨迹。

```pseudo
function INSPECT_TRACE(query):
    candidates = search_persistent_trace(query)

    return rank_by(
        relevance_to_current_state,
        causal_relation,
        recency,
        provenance
    )
```

当事实的精确出处很重要时，应尽可能重新读取原始历史，而不是盲目信任旧摘要。

### `FORK_BACK`

When the current trajectory is suspected to be off-track, create a new branch from an earlier checkpoint.

当当前路线疑似已经出轨时，从更早的 checkpoint 创建新的 trajectory。

```pseudo
function FORK_BACK(checkpoint):
    new_session = fork(trace, checkpoint)

    restore_world(checkpoint.world_state)

    return new_session
```

旧 branch 不删除。

新的 branch 只是：

> **从过去重新寻找另一条未来。**

### `CHECKPOINT_WORLD`

Keep execution state approximately aligned with reasoning checkpoints.

第一版不需要复杂的容器快照或者进程级 checkpoint。

可以直接使用简单的工作目录复制。

```pseudo
function CHECKPOINT_WORLD(name):
    cp(name, working_directory, checkpoint_directory)
```

```pseudo
function RESTORE_WORLD(name):
    replace_working_directory(
        checkpoint_directory[name]
    )
```

未来可以使用 reflink、Git、OSTree、容器 snapshot、进程 checkpoint/restore 等更高级机制。

但它们不是 Plastic Memories 的核心。

---

# Agent Policy / Agent 使用策略

Plastic Memories is deliberately not a deterministic context-cleaning daemon.

它不应该变成：

> 每 N 个 token 自动压缩一次。

真正关键的是让模型自己判断：

什么时候已经完成。

什么时候应该整理。

什么时候某段历史已经不再重要。

什么时候需要重新读取过去。

什么时候应该从旧路线 fork。

一个最小的模型侧策略可以类似：

```pseudo
while task_not_finished:

    observe_current_state()

    if completed_reasoning_segment():
        STABILIZE(relevant_segment)

    if historical_material_is_now_irrelevant():
        HIDE(relevant_material)

    if current_state_is_insufficient():
        INSPECT_TRACE(missing_information)

    if current_trajectory_looks_off_track():
        FORK_BACK(best_known_checkpoint)

    if world_state_should_be_reversible():
        CHECKPOINT_WORLD(checkpoint_id)

    CONTINUE()
```

Runtime 提供能力。

Model 提供判断。

这意味着 Plastic Memories 依赖一定程度的 trajectory-management intuition。

弱模型可能不知道什么时候应该整理，于是退化成普通的上下文堆积。

强模型则可能逐渐学会持续维护自己的 active state。

---

# What Plastic Memories is not / Plastic Memories 不是什么

Plastic Memories is not:

```text
MEMORY.md
```

它不是：

传统长期记忆库。

不是向量数据库。

不是简单的 Context Compression。

不是让模型把所有过去总结成一份新的永久真相。

也不是试图解决所有任务的不可压缩性。

它解决的是一个更窄的问题：

> **当完整历史必须保留时，如何让当前工作上下文尽可能接近继续推理所真正需要的状态。**

---

# Why "Plastic Memories" / 为什么叫“可塑性记忆”

The name refers to the idea that memory can be persistent while its present representation remains malleable.

这个名字表达的核心是：

> **记忆可以永久存在，但记忆在当前意识中的形态不必永久固定。**

过去不需要被反复重写。

也不需要被复制成一份越来越腐烂的 Memory 文件。

只需要不断改变：

> **现在究竟应该让模型看到过去的哪一部分。**

```text
Permanent Trace
       │
       ├── historical branch A
       ├── historical branch B
       └── historical branch C
               │
               ▼
       Current Active Surface
               │
               ▼
             Model
```

因此：

> **过去不会消失。**

> **现在可以改变。**

这就是 Plastic Memories。

---

# Expected Property / 预期性质

The long-term hypothesis is that accumulated work should increase the size of persistent history without necessarily increasing the cognitive burden of the current context.

长期假设是：

> **工作的增加应该主要增加历史轨迹的长度，而不应该必然增加模型当前的认知负担。**

普通 Agent：

```text
work ↑
  → history ↑
  → context debris ↑
  → active context quality ↓
  → reasoning quality ↓
```

Plastic Memories：

```text
work ↑
  → persistent trace ↑
  → continuous state maintenance
  → inactive debris stays outside the active surface
  → current reasoning remains relatively clean
```

因此希望得到的状态是：

> **More work should produce more history, not necessarily more cognitive clutter.**

也就是：

> **工作越多，历史可以越来越长，但当前的认知工作台不必越来越乱。**

如果模型的 trajectory-management 能力超过某个临界水平，那么理想情况下，累计工作量本身不再成为 Agent 长程退化的主要原因。

模型仍然可能因为任务过难、缺乏必要知识、世界状态复杂、或者任务本身真正不可压缩而失败。

但它不应该仅仅因为：

> **“自己过去做过很多工作。”**

而逐渐失去完成任务的能力。

---

# Initial Prototype / 第一版原型

The first prototype intentionally keeps the implementation small.

第一版原型刻意保持极简。

需要：

```text
DSH Session
+ derived surface manipulation
+ model-facing skills
+ fork
+ simple filesystem checkpoints
```

暂时不需要：

```text
global memory database
complex retrieval infrastructure
container checkpointing
multi-agent orchestration
special training pipeline
custom model architecture
```

最初只需要回答一个问题：

> **当一个能力足够强的模型可以持续整理自己的 active trajectory，并且完整历史始终可以回溯时，它是否能够在长程任务中更加稳定地向成功收敛？**

如果可以，再逐渐增加更复杂的机制。

如果插件被卸载，系统应该自然退化回普通 DSH Agent：

```text
Plastic Memories enabled
        ↓
clean active trajectory

Plastic Memories disabled
        ↓
ordinary accumulating context
```

插件应该提高 trajectory 的质量，而不是成为 trajectory 能够存在的前提。

---

# Core Idea / 核心思想

```text
                Persistent Trace
                       │
             ┌─────────┴─────────┐
             │                   │
       Historical View      Active Surface
             │                   │
       inspect / fork      stabilize / hide
             │                   │
             └─────────┬─────────┘
                       │
                  Current State
                       │
                    Continue
```

**Trace 是过去。**

**Surface 是现在。**

**Fork 是时间旅行。**

**Stabilize 是认知状态收敛。**

**Inspect 是重新面对过去。**

**Checkpoint 是让世界状态与时间线同步。**

Plastic Memories does not try to make the model remember everything.

It gives the model a way to **not carry everything**.

> **The past is never forgotten.
> It simply does not have to remain in the present.**
