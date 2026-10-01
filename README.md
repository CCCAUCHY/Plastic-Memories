# Plastic Memories

> A DSH plugin for maintaining a clean, reversible, model-facing context surface over a persistent session trace.
>
> 一个基于持久轨迹、可塑表面与可逆分叉的 DSH 上下文管理插件。

**Plastic Memories** is an experimental context-management plugin for DeepSeek Harness (DSH).

**Plastic Memories（可塑性记忆）** 是一个面向 DeepSeek Harness（DSH）的实验性上下文管理插件。

It is not a traditional memory system.

它不是传统意义上的 Memory 系统。

It does not ask the model to maintain a `MEMORY.md`, does not require an autonomous global memory database, and does not create a second long-lived source of truth.

它不会要求模型维护 `MEMORY.md`，不会要求模型自主维护全局记忆数据库，也不会建立一个独立的长期事实源。

Instead, Plastic Memories treats the persistent trace as the source of historical truth, while the model-facing conversation is treated as a mutable projection of that history.

相反，Plastic Memories 采用一个更简单的原则：

> **Persistent Trace 是历史事实的来源，模型当前看到的 Surface 是 Trace 的一种可塑投影。**

The past is never forgotten.

**过去不会被遗忘。**

Only its representation in the present can change.

**只是过去在当前上下文中的呈现方式可以不断改变。**

---

# 1. Motivation / 动机

Long-running agents accumulate large amounts of historical material:

长期运行的 Agent 会不断积累大量历史材料：

```text
tool output
failed attempts
temporary observations
repetitive reasoning
superseded conclusions
control chatter
stale environment state
```

```text
工具输出
失败尝试
临时观察
重复推理
已经被后续结论取代的判断
控制性聊天内容
过时的环境状态
```

Some of these things were useful when they were produced, but no longer need to remain in the model's active working context.

其中相当一部分在产生时有价值，但随着任务推进，已经不再需要继续占据模型的主动工作空间。

The common response is to treat this as a context compression problem.

通常人们会把这理解成一个“上下文压缩”问题。

Plastic Memories starts from a different observation:

但 Plastic Memories 从另一个观察出发：

> **Task incompressibility does not imply context incompressibility.**
>
> **任务本身不可压缩，不意味着全部历史上下文都必须持续存在于当前工作区。**

A task may be highly path-dependent, strongly state-coupled, and difficult to summarize safely. That does not mean every intermediate operation must remain visible forever.

一个任务可能高度路径依赖、状态耦合很强、无法安全摘要。但这并不意味着每一个中间操作都必须永远保持可见。

Therefore, the goal is not to make the entire history smaller.

因此，目标不是把整个历史变小。

The goal is to keep the **current working state** clean.

真正的目标是让**当前工作状态**保持干净。

```text
Persistent History
        │
        ▼
Current Active Surface
        │
        ▼
      Model
```

```text
持久化历史
        │
        ▼
当前活动表面
        │
        ▼
      模型
```

---

# 2. Core Principles / 核心原则

## Trace is the source of truth / Trace 是历史事实源

**Trace** is the complete persistent event history of a session.

**Trace（轨迹记录）** 是一个 Session 中完整、持久化的事件历史。

It may contain model-visible and runtime-only information alike.

其中既可以包含模型可见的信息，也可以包含只供运行时使用的信息。

For example:

```text
user messages
assistant messages
tool calls
tool results
reasoning
runtime events
control events
lifecycle events
checkpoint information
other internal events
```

例如：

```text
用户消息
助手消息
工具调用
工具结果
推理过程
运行时事件
控制事件
生命周期事件
检查点信息
其他内部事件
```

Therefore:

> **Trace is not the model context.**
>
> **Trace 不是模型上下文。**

Trace answers:

> **What happened?**

Trace 回答的是：

> **过去究竟发生了什么？**

The historical Trace remains persistent and recoverable.

完整的 Trace 永久保留，并且可以恢复。

---

## Trajectory is a path through time / Trajectory 是时间上的执行路径

**Trajectory** is a temporally ordered execution path through a Trace.

**Trajectory（轨迹）** 是沿时间推进的一条 Agent 执行路径。

A single Trace may contain multiple trajectories after branching.

一份完整历史可以因为分叉而包含多条不同的未来轨迹。

```text
                Trajectory A
             ────────────────►

Trace ───────●
              \
               └──────────────► Trajectory B
```

Therefore:

> **Trace describes what was recorded.**
>
> **Trajectory describes which path was taken.**

因此：

> **Trace 强调记录了什么。**
>
> **Trajectory 强调沿哪条时间路径走。**

DSH itself uses “Trajectory” as a user-facing concept. Plastic Memories keeps this terminology, but does not use it as a synonym for the entire event log or model context.

DSH 本身也使用 “Trajectory” 作为面向用户的轨迹概念。Plastic Memories 保留这一术语，但不会把它与完整事件日志或模型上下文混为一谈。

---

## Branch / 分支

A **Branch** is a new future trajectory created from a historical point.

**Branch（分支）** 是从历史某一点产生的一条新的未来轨迹。

```text
Past ─────●────────────────► Branch A

          │
          └────────────────► Branch B
```

A branch does not rewrite the parent branch.

分支不会修改父分支。

It only chooses a different future from the same past.

它只是从同一个过去选择不同的未来。

---

## Fork / 分叉

**Fork** creates a new Branch from an existing historical point.

**Fork（分叉）** 从已有轨迹的历史位置创建新的分支。

```text
Old Trajectory
0 ───── 20 ───── 50 ───── 100
            │
            └── New Trajectory
                20 ───── 35 ───── 60
```

Conceptually:

> **Fork changes the future, not the past.**
>
> **分叉改变未来，而不是过去。**

This is the basis of the system's “time travel” behavior.

这就是系统所谓“时间旅行”的基础。

---

# 3. Surface / 表面

**Surface** is the current model-facing projection of a trajectory's historical content.

**Surface（表面）** 是当前从轨迹历史中投影出来、供模型使用的历史工作面。

For example:

例如，完整历史为：

```text
Trace:
A B C D E F G H
```

当前 Surface 可以是：

```text
Surface:
A C F H
```

`B`, `D`, `E`, and `G` have not been deleted.

`B`、`D`、`E`、`G` 并没有被删除。

They simply do not belong to the current active working surface.

它们只是暂时不属于当前活动工作面。

Therefore:

> **The Trace is persistent. The Surface is plastic.**
>
> **Trace 是持久的，Surface 是可塑的。**

This is the central abstraction of Plastic Memories.

这是 Plastic Memories 最核心的抽象。

---

# 4. Projection / 投影

A **Projection** is the process of deriving the current Surface from the persistent Trace and the current trajectory state.

**Projection（投影）** 是从持久化 Trace 和当前轨迹状态生成 Surface 的过程。

Conceptually:

```pseudo
function project(trace, trajectory, surface_state):
    return derive_surface(
        trace,
        trajectory,
        surface_state
    )
```

Projection is the process.

投影是过程。

Surface is the resulting view.

Surface 是结果。

The important distinction is:

> **The history remains intact; only its current projection changes.**
>
> **历史保持完整，只有当前投影发生变化。**

---

# 5. Context / 上下文

**Context** is the complete input actually submitted to the model for an inference.

**Context（上下文）** 是一次推理请求中最终实际提交给模型的完整输入。

It may contain more than the Surface:

它可能包含比 Surface 更多的东西：

```text
Context
├── system instructions
├── tool definitions
├── runtime-provided information
├── user input
├── Surface
└── other model-facing inputs
```

```text
Context
├── 系统指令
├── 工具定义
├── 运行时提供的信息
├── 用户输入
├── Surface
└── 其他模型可见输入
```

Therefore:

> **Surface is the active historical working area.**
>
> **Context is the complete model input.**

因此：

> **Surface 是当前历史工作面。**
>
> **Context 是最终提交给模型的完整输入。**

The two should not be treated as synonyms.

两者不应被视为同义词。

---

# 6. State / 状态

**State** is the semantic information required for the model to continue reasoning reliably from its current position.

**State（状态）** 是模型为了从当前节点继续可靠推理所必须保留的语义信息。

It is not simply a token count or a particular message list.

它不是简单的 token 数量，也不一定对应某一组具体消息。

A long reasoning process may eventually stabilize into something like:

一段冗长的推理过程最终可能被稳定成：

```text
current objective
key facts
confirmed conclusions
causal dependencies
constraints
open questions
current direction
```

```text
当前目标
关键事实
已经确认的结论
因果依赖
约束
未解决问题
当前路线
```

The important question is not:

> “How much text remains?”

而不是：

> “还剩多少文字？”

The important question is:

> **“What must still be known to continue?”**

真正的问题是：

> **“继续工作究竟还必须知道什么？”**

---

# 7. World State / 世界状态

**World State** is the mutable external execution environment associated with a trajectory.

**World State（世界状态）** 是与某条轨迹对应的外部可变执行环境。

Examples include:

例如：

```text
working directory
source files
generated files
repository state
configuration
other mutable execution resources
```

```text
工作目录
源代码
生成文件
仓库状态
配置
其他可变执行资源
```

Reasoning State and World State are distinct.

推理状态与世界状态是两个不同的对象。

They may nevertheless be synchronized through checkpoints.

它们可以通过检查点进行同步。

---

# 8. Checkpoint / 检查点

A **Checkpoint** is a recoverable position in a trajectory.

**Checkpoint（检查点）** 是轨迹上的一个可恢复位置。

It may associate:

它可以对应：

```text
reasoning position
+
world state
```

```text
推理位置
+
世界状态
```

Checkpoints are used for rollback and fork-back.

检查点用于回退和回退分叉。

---

# 9. Core Operations / 核心操作

Plastic Memories intentionally exposes only a small set of semantic operations.

Plastic Memories 刻意只提供少量基础语义操作。

## `STABILIZE` / 稳定化

When a reasoning segment has completed its useful work, the model may convert it into a compact representation of the current state needed for continuation.

当一段推理已经完成了它的主要认知工作时，模型可以把它转化成适合继续工作的高密度当前状态。

The original Trace remains intact.

原始 Trace 继续保留。

```pseudo
function STABILIZE(range):
    state = summarize_for_continuation(
        trace,
        range
    )

    append_event(
        type = "message",
        content = state,
        surfaceOp = REPLACE(range)
    )

    return state
```

This is not merely token compression.

这不只是 token 压缩。

It is a semantic transformation:

它是一种语义层面的状态转换：

> **completed work becomes reusable current state.**
>
> **已经完成的工作被转化为可继续使用的当前状态。**

---

## `HIDE` / 隐藏

`HIDE` removes historical material from the current Surface without deleting it from the Trace.

`HIDE` 让历史内容离开当前 Surface，但不会把它从 Trace 中删除。

Typical candidates include:

典型对象包括：

```text
temporary tool output
failed commands
control chatter
duplicate reasoning
obsolete observations
stale intermediate state
```

```text
临时工具输出
失败命令
控制性聊天内容
重复推理
已经失效的观察
过时的中间状态
```

Conceptually:

```pseudo
function HIDE(range):
    append_surface_replacement(
        range = range,
        content = null
    )
```

Hide changes the current view, not historical truth.

隐藏改变的是当前视图，而不是历史事实。

---

## `INSPECT_TRACE` / 检查历史

When the current Surface is insufficient, the model may inspect the persistent Trace.

当当前 Surface 不足以继续可靠工作时，模型可以主动检查持久化 Trace。

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

This answers:

它回答的是：

> **“What part of the past do I need now?”**
>
> **“我现在需要重新面对过去的哪一部分？”**

The system therefore does not require the model to keep everything visible merely to preserve recoverability.

因此，系统不需要模型为了保证可恢复性而一直把所有历史保持在眼前。

Recoverability comes from the Trace.

可恢复性来自 Trace。

---

## `REHYDRATE` / 重新物化

`REHYDRATE` brings previously hidden information back into the active Surface when it becomes relevant again.

`REHYDRATE` 在此前隐藏的信息重新变得重要时，将其重新加入当前 Surface。

```pseudo
function REHYDRATE(history_range):
    material = read_trace(history_range)

    append_surface_replacement(
        range = appropriate_surface_position,
        content = material
    )
```

Conceptually:

```text
Trace
  ↓
historical information
  ↓
REHYDRATE
  ↓
Surface
```

```text
Trace
  ↓
历史信息
  ↓
重新物化
  ↓
Surface
```

---

## `FORK_BACK` / 回退分叉

If the current trajectory appears to be off-track, the model may create a new branch from an earlier checkpoint.

如果当前轨迹似乎已经出轨，模型可以从更早的检查点创建新的分支。

```pseudo
function FORK_BACK(checkpoint):
    new_trajectory = fork(
        trajectory,
        checkpoint
    )

    restore_world(
        checkpoint.world_state
    )

    return new_trajectory
```

The old trajectory remains preserved.

旧轨迹继续保留。

The operation means:

这个动作表达的是：

> **“I choose a different future from this past.”**
>
> **“我从这个过去重新选择未来。”**

It does not mean rewriting history.

它不意味着修改历史。

This is the core “time travel” operation of the system.

这是系统“时间旅行”能力的核心操作。

---

## `CHECKPOINT_WORLD` / 世界状态检查点

The first implementation may simply snapshot the working directory.

第一版只需要对工作目录做简单快照即可。

```pseudo
function CHECKPOINT_WORLD(name):
    cp(
        working_directory,
        checkpoint_directory[name]
    )
```

Restore:

恢复：

```pseudo
function RESTORE_WORLD(name):
    replace_working_directory(
        checkpoint_directory[name]
    )
```

More sophisticated mechanisms may be added later:

未来可以加入更高级的机制：

```text
reflink
Git
OSTree
container snapshots
process checkpoint / restore
```

They are implementation details, not the core abstraction.

这些都是实现细节，而不是核心抽象。

---

# 10. Agent Policy / Agent 使用策略

Plastic Memories is deliberately not a deterministic timer-based context cleaner.

Plastic Memories 刻意不设计成一个按时间或 token 数量机械工作的上下文清理器。

It should not simply do:

它不应该简单执行：

```text
every 10,000 tokens:
    compress()
```

Instead, the model should decide when the current surface needs to change.

相反，应由模型自行判断当前 Surface 什么时候需要发生变化。

A minimal policy might be:

一个最小的策略可以是：

```pseudo
while task_not_finished:

    observe_current_state()

    if completed_reasoning_segment():
        STABILIZE(relevant_segment)

    if historical_material_is_now_irrelevant():
        HIDE(relevant_material)

    if current_state_is_insufficient():
        INSPECT_TRACE(missing_information)

    if hidden_information_becomes_relevant():
        REHYDRATE(relevant_history)

    if current_trajectory_looks_off_track():
        FORK_BACK(best_known_checkpoint)

    if world_state_should_be_reversible():
        CHECKPOINT_WORLD(checkpoint_id)

    CONTINUE()
```

The runtime provides the operations.

Runtime 提供操作。

The model provides the judgment.

模型提供判断。

Plastic Memories therefore requires some degree of trajectory-management intuition.

因此 Plastic Memories 确实需要模型具备一定程度的轨迹管理直觉。

A weak model may simply fail to use the operations well and degrade toward ordinary context accumulation.

弱模型可能根本不会正确使用这些操作，最终退化为普通的上下文堆积。

A stronger model may gradually learn when to stabilize, hide, inspect, rehydrate, or fork.

更强的模型则可能逐渐学会什么时候应该稳定化、隐藏、检查、重新物化或分叉。

The plugin does not make the model intrinsically smarter.

插件不会凭空让模型变聪明。

It gives the model a better state-management action space.

它提供的是一个更好的认知状态管理操作空间。

---

# 11. Memory / 记忆

**Memory is intentionally not a core Plastic Memories primitive.**

**Memory 刻意不是 Plastic Memories 的核心原语。**

The system does not maintain an autonomous global memory database.

系统不维护由 AI 自主管理的全局记忆数据库。

A typical memory pipeline looks like:

传统 Memory 的典型流程是：

```text
past
 ↓
model summary
 ↓
MEMORY.md
 ↓
future session
 ↓
future model trusts MEMORY.md
```

```text
过去
 ↓
模型总结
 ↓
MEMORY.md
 ↓
未来会话
 ↓
未来模型继续相信 MEMORY.md
```

This introduces a second source of truth.

这会制造一个第二事实源。

That source may become:

这个事实源可能逐渐变得：

```text
outdated
incorrect
context-free
temporally ambiguous
superseded by later events
```

```text
过时
错误
脱离上下文
时间范围不明确
已被后续事件取代
```

Plastic Memories instead uses:

而 Plastic Memories 使用：

```text
Past
 ↓
Persistent Trace
 ↓
Inspect when necessary
 ↓
Current State
 ↓
Current Surface
```

```text
过去
 ↓
持久化 Trace
 ↓
需要时重新检查
 ↓
当前 State
 ↓
当前 Surface
```

Therefore:

> **The past does not need to be remembered if it can be reliably revisited.**
>
> **只要过去可以被可靠地重新抵达，就没有必要强迫系统“记住过去”。**

---

# 12. Bootstrap / 启动配置

**Bootstrap** is explicit, user-owned configuration loaded when a new session starts.

**Bootstrap（启动配置）** 是由用户明确拥有，并在新 Session 开始时加载的跨会话配置。

It may contain:

它可以包含：

```text
long-term user preferences
stable project constraints
fixed working conventions
explicit behavioral instructions
```

```text
长期用户偏好
稳定项目约束
固定工作方式
用户主动指定的行为要求
```

Bootstrap is not autonomous AI memory.

Bootstrap 不是 AI 自己维护的长期记忆。

The model may draft an update, but the persistent configuration remains under explicit user control.

模型可以帮助用户起草更新，但持久化配置本身由用户明确控制。

Therefore:

> **A new session can remain cognitively fresh without losing access to the user's deliberate configuration.**
>
> **新会话可以保持认知上的全新，同时继续使用用户明确指定的配置。**

---

# 13. World Model / 世界与推理状态

Plastic Memories treats the reasoning trajectory and the external world as related but distinct state spaces.

Plastic Memories 将推理轨迹和外部世界视为相关但不同的两个状态空间。

```text
Trajectory
    │
    ├── Reasoning State
    │
    └── World State
            │
            ▼
        Checkpoint
```

```text
Trajectory
    │
    ├── 推理状态
    │
    └── 世界状态
            │
            ▼
         检查点
```

This allows reasoning to travel backward without pretending that the external world magically changed with it.

这使推理可以回到过去，同时要求外部世界在需要时通过检查点恢复到对应状态。

---

# 14. Context GC / 上下文垃圾回收

**Context GC** is the continuous reduction of irrelevant, obsolete, or redundant material from the active Surface.

**Context GC（上下文垃圾回收）** 是持续减少当前 Surface 中无关、过时和冗余内容的策略。

It does not delete the persistent Trace.

它不负责删除持久化 Trace。

```text
Complete Trace
      │
      ▼
Context GC
      │
      ▼
Cleaner Surface
```

```text
完整 Trace
      │
      ▼
上下文 GC
      │
      ▼
更干净的 Surface
```

This is why Plastic Memories favors **reversible GC** over destructive deletion.

因此 Plastic Memories 更强调：

> **可逆 GC，而不是破坏式删除。**

If a supposedly irrelevant historical segment becomes useful later, it can be recovered.

如果某段被认为无关的历史以后又重新变得重要，它仍然可以被恢复。

---

# 15. Expected Property / 预期性质

The long-term hypothesis is:

> **More work should produce more history, not necessarily more cognitive clutter.**

长期假设是：

> **更多工作应该主要产生更多历史，而不必然产生更多认知垃圾。**

Ordinary long-running agents may behave like:

普通长程 Agent 可能表现为：

```text
work ↑
  ↓
history ↑
  ↓
context debris ↑
  ↓
active context quality ↓
  ↓
reasoning quality ↓
```

Plastic Memories aims for:

Plastic Memories 希望变成：

```text
work ↑
  ↓
persistent trace ↑
  ↓
continuous state maintenance
  ↓
inactive debris stays outside the active surface
  ↓
current reasoning remains comparatively clean
```

The model may therefore be able to perform much more work without carrying the full burden of its own accumulated history.

因此，模型可以在不持续背负全部历史负担的情况下完成更多工作。

The goal is not infinite context.

目标不是制造无限上下文。

The goal is to keep the active context close to the **minimum sufficient state for continuation**.

目标是让 Active Context 尽可能接近：

> **继续完成任务所需要的最小充分状态。**

---

# 16. Trajectory Criticality / 轨迹管理临界能力

Plastic Memories proposes a further hypothesis:

Plastic Memories 还提出一个更进一步的假设：

> **Trajectory-management ability may exhibit a critical threshold.**
>
> **Agent 的轨迹管理能力可能存在某种临界阈值。**

Below the threshold:

低于这个阈值：

```text
insufficient GC ability
        ↓
context debris accumulates
        ↓
active context becomes polluted
        ↓
reasoning becomes less reliable
        ↓
trajectory management becomes harder
        ↓
more debris accumulates
```

```text
GC 能力不足
        ↓
垃圾持续积累
        ↓
Active Context 被污染
        ↓
推理可靠性下降
        ↓
更难管理轨迹
        ↓
进一步积累垃圾
```

Above the threshold:

超过这个阈值：

```text
sufficient GC ability
        ↓
cleaner active state
        ↓
better local decisions
        ↓
better STABILIZE / HIDE / INSPECT / FORK decisions
        ↓
healthier active state
```

```text
GC 能力足够
        ↓
更干净的 Active State
        ↓
更好的局部决策
        ↓
更好的 STABILIZE / HIDE / INSPECT / FORK
        ↓
更健康的 Active State
```

This suggests a possible phase transition:

这意味着系统可能存在一种类似“相变”的现象：

> **Once trajectory management becomes good enough, accumulated work itself may cease to be the dominant cause of long-horizon degradation.**
>
> **当轨迹管理能力足够强以后，累计工作量本身可能不再是长程退化的主要原因。**

The agent may still fail because the task is genuinely difficult, necessary knowledge is missing, or the task's irreducible state is itself too large.

Agent 当然仍然可能因为任务本身过难、缺乏必要知识，或者任务的不可压缩状态本身过大而失败。

The hypothesis is narrower:

> **The agent should not fail merely because it has done a lot of work.**
>
> **Agent 不应该仅仅因为自己已经做了很多工作，就逐渐失去完成任务的能力。**

---

# 17. Reversible Failure / 可恢复失败

Plastic Memories does not require perfect context management.

Plastic Memories 不要求模型拥有完美的上下文管理能力。

Instead, it aims to make mistakes recoverable.

它追求的是让管理错误变得可恢复。

For example:

例如：

```text
HIDE
 ↓
later becomes relevant
 ↓
INSPECT_TRACE
 ↓
REHYDRATE
```

```text
隐藏
 ↓
后来重新变得重要
 ↓
检查历史
 ↓
重新物化
```

Or:

```text
current trajectory
        ↓
suspected to be wrong
        ↓
FORK_BACK
        ↓
new future
```

```text
当前轨迹
        ↓
怀疑路线错误
        ↓
回退分叉
        ↓
新的未来
```

Thus the goal is not:

> **Perfect GC**

而是：

> **Reversible GC**

即：

> **即使状态管理判断错了，也能够回到过去重新修复。**

---

# 18. Initial Prototype / 第一版原型

The first prototype intentionally keeps the implementation small.

第一版原型刻意保持极简。

Required:

需要：

```text
DSH Session
+
derived Surface manipulation
+
model-facing skills
+
Fork
+
simple filesystem checkpoints
```

```text
DSH Session
+
Surface 投影操作
+
模型侧 Skill
+
Fork
+
简单工作目录检查点
```

Not required initially:

第一版暂时不需要：

```text
global memory database
complex vector memory
container-level checkpointing
process checkpoint / restore
large multi-agent orchestration
specialized training pipeline
custom model architecture
```

```text
全局 Memory 数据库
复杂向量记忆系统
容器级检查点
进程级 checkpoint / restore
复杂 Multi-Agent 编排
专门训练流水线
自定义模型架构
```

The first prototype only needs to answer one question:

第一版只需要回答一个问题：

> **Can a capable model maintain a long-running task more reliably when it can continuously reshape its active trajectory while preserving the full historical trace?**
>
> **一个能力足够强的模型，在能够持续整理自己的 Active Trajectory、同时完整保留历史 Trace 的情况下，是否能够更加可靠地完成长程任务？**

The initial world-state implementation can be as simple as copying the working directory.

第一版世界状态实现甚至可以简单到复制工作目录。

The sophisticated infrastructure can come later.

复杂基础设施以后再做。

---

# 19. Graceful Degradation / 优雅退化

Plastic Memories should never become a prerequisite for the existence of the underlying trajectory.

Plastic Memories 不应该成为 Agent 能够正常运行的必要条件。

With the plugin:

启用插件：

```text
ordinary DSH
      ↓
Plastic Memories
      ↓
maintained active surface
```

Without the plugin:

卸载插件：

```text
ordinary DSH
      ↓
ordinary accumulating context
```

The system should continue to work, only with less trajectory hygiene.

系统仍然能够继续运行，只是退化回普通的上下文累积。

Therefore:

> **Plastic Memories is a trajectory-quality layer, not a mandatory execution substrate.**
>
> **Plastic Memories 是轨迹质量层，而不是 Agent 能够运行的前提。**

---

# 20. Canonical Terminology / 规范术语

The project uses the following distinctions:

本项目正式使用以下术语区分：

```text
Session
    = persistent container of one interaction

Trace
    = complete persistent historical event record

Trajectory
    = one temporally ordered execution path

Branch
    = a trajectory created by forking from the past

Surface
    = current model-facing historical projection

Projection
    = the process that derives the Surface

Context
    = complete input actually submitted to the model

State
    = semantic information required to continue reasoning

World State
    = mutable external execution environment

Checkpoint
    = recoverable reasoning + world position

Stabilize
    = turn completed historical work into reusable current state

Hide
    = remove historical material from the current Surface

Inspect Trace
    = examine historical material outside the current Surface

Rehydrate
    = bring previously hidden history back to the Surface

Fork Back
    = create a new future from an earlier point

Context GC
    = continuously remove irrelevant material from the Surface

Bootstrap
    = explicit user-owned cross-session configuration

Memory
    = intentionally not a core primitive
```

中文对应：

```text
Session（会话）
    = 一次交互的持久化容器

Trace（轨迹记录）
    = 完整、持久的历史事件记录

Trajectory（轨迹）
    = 一条沿时间推进的执行路径

Branch（分支）
    = 从过去分叉出来的新轨迹

Surface（表面）
    = 当前模型可见的历史投影

Projection（投影）
    = 从 Trace 派生 Surface 的过程

Context（上下文）
    = 最终提交给模型的完整输入

State（状态）
    = 继续推理所需的语义信息

World State（世界状态）
    = 外部可变执行环境

Checkpoint（检查点）
    = 可恢复的推理与世界位置

Stabilize（稳定化）
    = 将完成的历史工作转化为当前可复用状态

Hide（隐藏）
    = 让历史离开当前 Surface

Inspect Trace（检查历史）
    = 查询当前 Surface 之外的历史

Rehydrate（重新物化）
    = 将历史重新加入当前 Surface

Fork Back（回退分叉）
    = 从过去重新选择未来

Context GC（上下文垃圾回收）
    = 持续清除 Surface 中无关内容

Bootstrap（启动配置）
    = 用户明确拥有的跨会话配置

Memory（记忆）
    = 刻意不设为核心原语
```

---

# 21. Final Model / 最终模型

The complete lifecycle can be summarized as:

完整生命周期可以概括为：

```text
Fresh Session
      │
      ▼
Explore
      │
      ▼
Work
      │
      ├───────────────┐
      ▼               │
 STABILIZE            │
      │               │
      ▼               │
Clean Current State   │
      │               │
      ▼               │
Continue              │
      │               │
      ├── HIDE ───────┘
      │
      ├── INSPECT_TRACE
      │
      ├── REHYDRATE
      │
      ├── CHECKPOINT
      │
      └── FORK_BACK
              │
              ▼
          New Future
              │
              ▼
          Convergence
```

```text
新的 Session
      │
      ▼
探索
      │
      ▼
工作
      │
      ├───────────────┐
      ▼               │
  稳定化              │
      │               │
      ▼               │
干净的当前状态         │
      │               │
      ▼               │
继续工作              │
      │               │
      ├── 隐藏 ───────┘
      │
      ├── 检查历史
      │
      ├── 重新物化
      │
      ├── 创建检查点
      │
      └── 回退分叉
              │
              ▼
            新未来
              │
              ▼
            最终收敛
```

The fundamental invariants are:

核心不变量是：

```text
Trace       = persistent historical truth
Trajectory  = temporal execution lineage
Surface     = mutable model-facing view
Context     = transient model input
State       = semantic continuation state
Checkpoint  = recoverable position
```

```text
Trace       = 持久的历史事实
Trajectory  = 时间上的执行路径
Surface     = 可塑的模型可见历史视图
Context     = 瞬时的模型输入
State       = 面向继续推理的语义状态
Checkpoint  = 可恢复的位置
```

And the central principle is:

核心原则是：

> **History is immutable. The current view is plastic.**
>
> **历史不可篡改，当前视图可以改变。**

Or:

或者更简洁地：

> **The past remains real. The present remains plastic.**
>
> **过去保持真实，现在保持可塑。**

And finally:

最后：

> **Plastic Memories does not make the model remember everything. It makes the model not have to carry everything.**
>
> **Plastic Memories 不是让模型记住一切，而是让模型不必携带一切。**
