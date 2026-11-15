# Plastic Memories（可塑性记忆）

> 面向 DeepSeek Harness（DSH）的上下文管理插件：模型看到的上下文，是会话日志的可塑投影。

[English](README.md) · **中文**

---

## 它做什么

让模型编辑自己「过去」在当前上下文里的呈现，而不删除任何东西。

- **塑形（plasticize）**——替换或隐藏一段单元（一条 assistant 消息连同它的全部工具结果）。会话日志保留每一条原文，只有可见投影改变。
- **世代**——每次成功写入都会冻结当前上下文并开启一个新的逻辑世代；任意历史世代都能按编号读回。
- **安全区**——用户可以锁定单元，模型改不动；命中即报错。
- **自动隐藏**——成功写入后，早先的噪音单元（失败的调用、成功的 `letter` / `retrospect`）会被自动收起。

## 状态

- 版本 **0.50.85**，实验阶段，尚无正式版。
- 任何 preset 都可用（工具全局注册）。
- 纯 JavaScript，无运行时依赖。

## 安装

```bash
# 从构建好的 tarball
dsh plugin --profile <profile> add file:/路径/dsh-plugin-plastic-memories-h0-0.50.85.tgz

# 或从 stage 目录链接
./install-pm.sh stage
dsh plugin --profile <profile> add link:/路径/staged/dsh-plugin-plastic-memories-h0
```

重启 profile 并硬刷新 Web UI。

## 三个工具

| 工具 | 作用 | 形状 |
|---|---|---|
| `plasticize` | 改写当前上下文 | `{ ops: [{ positions, new_text, lock_this? }] }` |
| `retrospect` | 读取某个世代（只读） | `{ generation, messages_position?, letters_position?, head?, tail? }` |
| `letter` | 给未来世代留便条 | `{ text }` |

```js
// 一次写入：替换 unit 6，隐藏 unit 7–9
plasticize({
  ops: [
    { positions: "unit 6", new_text: "压缩后的摘要" },
    { positions: "unit 7 to 9" }
  ]
})
```

写入发生在下一个提交边界，不是调用当下；被拒绝的写入会留下一条说明，而不是静默失败。

## 仓库结构

```text
pm-h0/            插件源码（index、engine、units、unitops、retrospect …）
dist/             构建产物
docs/             辅助文档与图片
THEORY.md         设计理论（英文）
THEORY.zh.md      设计理论（中文）
```

## 文档

**理论**

- [设计理论（中文）](THEORY.zh.md)
- [Design theory (English)](THEORY.md)

**工程**

- [插件说明](pm-h0/README.md)——安装、工具、写入协议、已知限制
- [CONTRACT.md](pm-h0/CONTRACT.md)——选择器语法、工具/命令契约、不变式
- [文案打磨请求](文案打磨-求助.md)——待打磨的工具描述
- [机械测试脚本](docs/PM-机械测试脚本.zh.md)

## 测试

```bash
cd pm-h0
npm test          # 12 套 / 256 条
node uitest.mjs   # 103 条 UI 断言
```

## 许可

MIT，见 [LICENSE](LICENSE)。
