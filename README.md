# Plastic Memories

> A context-management plugin for DeepSeek Harness (DSH): the model-visible context is a re-shapable projection of an immutable session log.

**English** · [中文](README.zh.md)

---

## What it does

Plastic Memories lets a model edit how its own past appears in the current context — without deleting anything.

- **Plasticize** — replace or hide a range of units (an assistant message plus its tool results). The session log keeps every original message; only the visible projection changes.
- **Generations** — every successful write freezes the current context and starts a new logical generation. Any past generation can be read back by number.
- **Safety zone** — users can lock units so the model cannot reshape them; touching one fails loudly.
- **Auto-hide** — after a successful write, earlier noise units (failed calls, successful `letter` / `retrospect`) are collapsed automatically.

## Status

- Version **0.50.85**, experimental; no stable release yet.
- Works with any preset (the tools are registered globally).
- Written in plain JavaScript, no runtime dependencies.

## Install

```bash
# from a built tarball
dsh plugin --profile <profile> add file:/path/to/dist/dsh-plugin-plastic-memories-h0-0.50.85.tgz

# or from a staged checkout
./install-pm.sh stage
dsh plugin --profile <profile> add link:/path/to/staged/dsh-plugin-plastic-memories-h0
```

Restart the profile and hard-refresh the Web UI.

## The three tools

| Tool | Purpose | Shape |
|---|---|---|
| `plasticize` | reshape the current context | `{ ops: [{ positions, new_text, lock_this? }] }` |
| `retrospect` | read a generation (read-only) | `{ generation, messages_position?, letters_position?, head?, tail? }` |
| `letter` | leave a note for future generations | `{ text }` |

```js
// replace unit 6, hide units 7–9, in one write
plasticize({
  ops: [
    { positions: "unit 6", new_text: "condensed summary" },
    { positions: "unit 7 to 9" }
  ]
})
```

A write lands at the next submission boundary, not at call time; a rejected write leaves a notice instead of failing silently.

## Repository layout

```text
pm-h0/            runtime source (index, engine, units, unitops, retrospect, …)
dist/             built tarballs
docs/             supporting documents and figures
THEORY.md         design theory (English)
THEORY.zh.md      design theory (Chinese)
```

## Documentation

**Theory**

- [Design theory (English)](THEORY.md)
- [设计理论（中文）](THEORY.zh.md)

**Engineering**

- [Plugin README](pm-h0/README.md) — install, tools, write protocol, limits
- [CONTRACT.md](pm-h0/CONTRACT.md) — selector grammar, tool/command contracts, invariants
- [Changelog](pm-h0/CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
