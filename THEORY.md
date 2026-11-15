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
