# English Version

# Plastic Memories

> **A context-management plugin for DeepSeek Harness (DSH) maintaining a reversible, model-facing surface over an immutable execution trajectory.**

Plastic Memories is an experimental context-management plugin for DeepSeek Harness (DSH). It is not a traditional memory system: it requires no autonomous `MEMORY.md`, no vector memory database, and no ungrounded secondary source of truth.

It operates on a singular architectural premise:

> **The Trajectory is immutable truth; the Surface is its plastic projection; Context is the runtime realization of that Surface inside the model's input.**
> *The past is never deleted; only its active representation in the prompt changes.*

---

## 1. Motivation: Clean Working State vs. Compression

Long-running agents inevitably accumulate execution debris: verbose tool outputs, failed attempts, superseded reasoning, control chatter, and stale environment states. While useful when generated, retaining them indefinitely degrades model reasoning fidelity.

Standard approaches treat this strictly as a **context compression** problem. Plastic Memories is built on a different observation:

> **Task incompressibility does not imply trajectory incompressibility.**

A complex task may be path-dependent and state-coupled, making lossy summarization unsafe. However, that does not mean every intermediate operational artifact must stay in the model's active window forever.

The goal is not to shrink the historical record, but to maintain a high-signal, clean **working state**.

```text
Persistent Trajectory (Immutable History)
             │
             ▼
      Active Surface (Plastic Projection)
             │
             ▼
    Model Context (Prompt Realization)
             │
             ▼
           Model

```

---

## 2. Core Taxonomy

| Term | Definition |
| --- | --- |
| **Trajectory** | The append-only, immutable event history of a session (messages, tool calls, runtime events). Answers: *"What happened?"* |
| **Surface** | The mutable historical projection derived from the Trajectory. It dictates which historical elements remain active or hidden. |
| **Context** | The concrete prompt payload submitted to the model on an inference turn—realizing the active Surface alongside system prompts, tools, and immediate inputs. |
| **Branch / Fork** | A **Branch** is an alternate path diverging from a point on the Trajectory. A **Fork** creates this branch—altering future execution without rewriting the past. |
| **State** | The minimal semantic information required to continue reasoning reliably (active goals, key facts, causal dependencies, constraints). |
| **World State** | The external mutable execution environment (filesystem, git tree, running processes), synchronized with the Trajectory via Checkpoints. |
| **Checkpoint** | A recoverable state marker binding a specific reasoning point on the Trajectory to a corresponding World State snapshot. |

---

## 3. Core Operations

Plastic Memories provides a minimal set of orthogonal primitives:

### Surface & Context Management

* `STABILIZE(range)`
Consolidates a completed reasoning or tool-execution segment into a dense, reusable state on the Surface:

$$\text{Completed Work} \longrightarrow \text{Reusable State}$$


* `HIDE(range)`
Omits historical sections (e.g., bulky outputs, failed attempts, intermediate chatter) from the active Surface without altering the persistent Trajectory.
* `INSPECT(query)`
Searches the underlying Trajectory beyond the active Surface, retrieving past evidence ranked by causal dependency, provenance, and recency.
* `REHYDRATE(range)`
Restores previously hidden Trajectory segments back into the active Surface when they regain relevance.

### Trajectory & World State Control

* `CHECKPOINT_WORLD(id)`
Captures an external execution snapshot (working directory, filesystem, or container state).
* `FORK_BACK(checkpoint)`
Reverts the World State and initializes a new branch from an earlier checkpoint. The abandoned path remains preserved in the Trajectory.

---

## 4. Architectural Principles

### Eliminating Autonomous "Memory"

Conventional pipelines distill interactions into autonomous files (e.g., `MEMORY.md`), creating an ungrounded second source of truth prone to hallucination, temporal ambiguity, and semantic drift.

Plastic Memories replaces stored memory with **on-demand Trajectory inspection**:

> *The past does not need to be artificially remembered if it can be reliably revisited.*

Cross-session configurations (user preferences, project constraints) belong in an explicit, user-owned **Bootstrap** configuration, not in autonomous agent memory.

### Reversible Failure over Destructive Deletion

Context management is fallible. Irreversible pruning risks dropping critical dependencies. Decoupling the active Surface from the persistent Trajectory ensures that all GC operations (`HIDE`, `STABILIZE`) remain safe and reversible via `INSPECT` and `REHYDRATE`.

### Trajectory Criticality

Agent stability exhibits a distinct phase transition:

* **Sub-critical:** Inadequate GC $\rightarrow$ context pollution $\rightarrow$ degraded reasoning $\rightarrow$ poor trajectory control $\rightarrow$ compounding failure.
* **Super-critical:** Competent GC $\rightarrow$ lean working surface $\rightarrow$ high reasoning fidelity $\rightarrow$ sound management decisions $\rightarrow$ sustained stability.

Beyond this threshold, execution length ceases to be the dominant driver of degradation. Agents fail only when intrinsic task complexity exceeds capability, not from accumulated cognitive debris.

### Graceful Degradation

Plastic Memories is a context hygiene layer, not an execution prerequisite. Disabling the plugin gracefully falls back to vanilla append-only context accumulation without breaking session continuity.

---

## 5. Lifecycle & Invariants

```text
Session Start ──► Execute ──► STABILIZE (Consolidate state)
                    │     │
                    │     ├──► HIDE (Prune operational debris)
                    │     ├──► INSPECT / REHYDRATE (Retrieve history)
                    │     └──► FORK_BACK (Recover from wrong paths)
                    ▼
           Convergence / Completion

```

* **Trajectory** is the immutable historical truth.
* **Surface** is the plastic, mutable historical projection.
* **Context** is the realized input fed to the model.

> **Plastic Memories does not make the model remember everything; it frees the model from having to carry everything.**

---

---

# 中文版

# Plastic Memories（可塑性记忆）

> **一个面向 DeepSeek Harness (DSH) 的上下文管理插件：在不可变的执行轨迹（Trajectory）之上，维护一个可塑、可逆的模型工作表面（Surface）。**

Plastic Memories 是一个面向 DeepSeek Harness（DSH）的实验性上下文管理插件。它并非传统意义上的 Memory 系统：不要求模型自主维护 `MEMORY.md`，不依赖独立的向量记忆库，更不建立脱离上下文的第二事实源。

它基于一个清晰的架构原则：

> **Trajectory 是不可变的历史事实；Surface 是历史的可塑投影；Context 是 Surface 在模型输入中的具体存在形态。**
> *过去从未被删除，改变的只是它在当前上下文中的呈现方式。*

---

## 一、 核心动机：保持工作区整洁 vs. 上下文压缩

长期运行的 Agent 会不可避免地积累大量运行噪音：冗长工具输出、失败尝试、临时观察、重复推理及过时的环境状态。这些材料在产生时有其价值，但随着任务推进，持续留在工作区中只会挤占注意力并劣化推理质量。

业界通常将此简化为**上下文压缩**问题。Plastic Memories 基于不同的洞察：

> **任务本身的不可压缩性，并不意味着全部轨迹上下文都要持续留在当前工作区。**

复杂任务可能高度依赖路径和状态，导致损失性摘要极易损坏关键信息；但这并不意味着每一个中间过程都必须永远对模型可见。

治理的目标不是压缩历史，而是让当前工作状态（Working State）保持干净与聚焦。

```text
持久化 Trajectory（不可变历史轨迹）
             │
             ▼
      活动 Surface（可塑性投影）
             │
             ▼
    模型 Context（实际输入形态）
             │
             ▼
           模型

```

---

## 二、 核心概念体系

| 概念 | 英文 | 定义 |
| --- | --- | --- |
| **轨迹** | Trajectory | 完整、持久、仅追加（Append-only）的会话事件总集。回答：*“过去究竟发生了什么？”* |
| **工作面** | Surface | 从 Trajectory 中动态派生出的可塑历史投影，决定哪些历史内容保持激活、哪些被隐藏。 |
| **上下文** | Context | Surface 在实际推理输入中的具体承载形态，即 Surface 叠加系统指令、工具定义与当前输入后的完整 Prompt。 |
| **分支 / 分叉** | Branch / Fork | **Branch** 是从 Trajectory 某一节点延伸出的新路径；**Fork** 是创建新路径的动作，*“改变未来，而非篡改历史”*。 |
| **语义状态** | State | 模型继续可靠推理所必需的最小信息集合（目标、关键事实、已确认结论、因果约束）。 |
| **世界状态** | World State | 伴随轨迹运行的外部可变执行环境（工作目录、源码、Git 状态、外部资源）。 |
| **检查点** | Checkpoint | 绑定义轨迹推理进度与对应 World State 的可恢复节点，用于回滚分叉。 |

---

## 三、 核心操作原语

Plastic Memories 仅暴露一组精简的正交操作：

### Surface 视图与上下文操作

* `STABILIZE(range)`（稳定化）
将已完成认知阶段的推理或工具输出，提炼并转化为继续工作所需的高密度语义状态：

$$\text{已完成工作} \longrightarrow \text{可复用当前状态}$$


* `HIDE(range)`（隐藏）
将冗余输出、调试杂音、报错重试等内容从当前 Surface 剔除，底层 Trajectory 完整保留。
* `INSPECT(query)`（回溯检索）
主动查阅当前 Surface 之外的底层 Trajectory，按因果关系、时效性与来源检索历史细节。
* `REHYDRATE(range)`（重新物化）
当已隐藏的轨迹材料重新变得关键时，按需将其恢复至当前 Surface。

### 轨迹与世界状态操作

* `CHECKPOINT_WORLD(id)`（环境快照）
捕获当前外部环境快照（初版支持工作目录文件备份，后续支持 Reflink、Git 或容器级快照）。
* `FORK_BACK(checkpoint)`（回退分叉）
将外部环境恢复至指定检查点，并在 Trajectory 上开启一条新的未来分支；原偏离路径作为历史事实完整保留。

---

## 四、 核心设计原则

### 1. 消除自治“记忆”（No Autonomous Memory）

传统方案将长程经验提炼至独立文件（如 `MEMORY.md`），极易引入脱离上下文、缺乏时间标识、逐渐漂移的“第二事实源”。
Plastic Memories 的原则是**以可靠回溯替代记忆存储**：

> *只要过去可以被可靠地重新审视，就没有必要强迫系统在上下文之外“记住过去”。*

跨会话配置（用户偏好、项目固定约束）属于用户显式声明的 **Bootstrap** 配置，不应交由模型自主维护成黑盒记忆。

### 2. 可逆失败优于破坏式删除（Reversible Failure）

长程上下文管理不应假设模型拥有“永不犯错”的判断力。破坏性物理删除一旦误删关键线索将导致执行崩溃。通过解耦 Trajectory 与 Surface，所有上下文垃圾回收（`HIDE`、`STABILIZE`）均天然可逆，随时可通过 `INSPECT` 与 `REHYDRATE` 纠偏。

### 3. 轨迹管理临界阈值假说（Trajectory Criticality）

Agent 的轨迹管理能力存在明显的相变临界点：

* **亚临界状态**：GC 能力不足 $\rightarrow$ 上下文噪音累积 $\rightarrow$ 推理与判断劣化 $\rightarrow$ 轨迹失控 $\rightarrow$ 恶性循环。
* **超临界状态**：具备基础 GC 能力 $\rightarrow$ 维持低熵工作面 $\rightarrow$ 保持高置信推理 $\rightarrow$ 决策合理 $\rightarrow$ 维持健康循环。

跨越阈值后，工作量的累加不再是长程 Agent 退化的主要诱因。系统只因任务本身的固有复杂度而受限，不再因自产生的历史噪音而自溃。

### 4. 优雅退化（Graceful Degradation）

Plastic Memories 是一个**轨迹质量控制层**，而非底层执行的前提。移除该插件后，系统仅退化回基础的上下文全量累加模式，底层的执行与交互不受任何阻断。

---

## 五、 全生命周期状态图与核心不变量

```text
会话启动 ──► 任务执行 ──► STABILIZE（沉淀当前关键状态）
               │     │
               │     ├──► HIDE（剪枝非关键噪音）
               │     ├──► INSPECT / REHYDRATE（回溯与物化旧知）
               │     └──► FORK_BACK（探测偏离时回退分叉）
               ▼
         任务收敛与交付

```

* **Trajectory**：持久、不可篡改的历史事实。
* **Surface**：可塑、受控的模型感知投影面。
* **Context**：Surface 在单次推理中装配落地的输入形态。

> **Plastic Memories 并不强求模型记住一切，而是让模型不必时刻背负一切。**
