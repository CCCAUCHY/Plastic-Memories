# Plastic Memories — Engineering README

Experimental plugin for DeepSeek Harness (DSH). Plastic Memories explores plastic context: the model-visible context of a session is a re-shapable projection of an immutable trajectory log.

## Core idea

- Trajectory is immutable history (append-only session log).
- Surface is a shapeable projection of that history (surfaceOp: append | replace).
- Context is how a Surface exists inside the model request.

The plugin adds a projection layer on top of the official surface: a conversation can plasticize (compress / hide / replace) parts of its own history into a generation, and switch between generations without losing the log.

## Features

- Plasticize / Retrospect tools and /plasticize /retrospect commands — append-only surfaceOps.
- Session-mode isolated preset (PM · 可塑记忆); other DSH modes do not load the plugin.
- Cookie bracketing: every actively sent user message is bracketed by cookie markers; runtime-context snapshots are never bracketed.
- Generation tab: privatized 1:1 copy of the official Trajectory view, rebuilt by the official assembler for any generation; latest (live) generation is never cached.
- Adjacent-generation diff: in generation k the replacement message is badged Reshaped (jump to k-1); in generation k-1 messages to be covered are badged Being reshaped (jump to k). Rows themselves stay official.
- Fact source and consistency: projection fold is differential-tested against the official foldSurface (shadow sessions replaying log prefixes); a runtime self-check warns on divergence; display never writes back to log or request.

## Install

    ./install-pm.sh stage
    dsh plugin --profile web2 add link:/path/to/staged/dsh-plugin-plastic-memories-h0

Restart dsh and hard-refresh. Select the PM · 可塑记忆 session mode.

## Layout

- pm-h0/ host plugin, commands, projection fold, tests
- pm-h0/client-glue.js client bridge, generation pagination, diff badges
- pm-h0/build-client.mjs + client-patches.js privatize and patch the official Trajectory bundle
- pm-h0/trajectory-vendor.js vendored official bundle (see note below)
- docs/images screenshots

## Tests

    cd pm-h0 && npm test

17 suites / 572 assertions: cookie bracketing, group balance, step atomicity, official-fold differential checks, official context chain, UI bridge, version/package guards.

## Vendored official bundle

pm-h0/trajectory-vendor.js is a byte-for-byte copy of DSH's @deepseek-ai/dsh-client-ui-trajectory client bundle, privatized by build-client.mjs. Included only for self-contained experimentation; review upstream licensing before redistribution. To refresh: copy node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js from a DSH install and run node build-client.mjs.

## License

See LICENSE.

## Not included

Internal handover/process documents and the real session-log fixtures used by the test-suite are intentionally not published.
To run the tests locally, provide your own session exports under pm-h0/fixtures/ with the same file names.

## Prebuilt package

The installable tarball is committed under dist/ (link/staged installs are local-only and not published).
    dsh plugin --profile <profile> add file:$PWD/dist/dsh-plugin-plastic-memories-h0-0.28.4.tgz
## Relationship to DSH's native mechanism: system-prompt updates are also surfaceOp replace

In session 26aaea8e this is directly observable: the initial `system/message` (seq 8) is later replaced by a new `system/message` (seq 279):

    surfaceOp: { op: "replace", startSeq: 8, endSeq: 8 }
    source.kind: "system-prompt"

PM's generation projection treats **every surfaceOp replace as one physical generation**, so this official system-prompt update also appears in the generation list and is shown as "Reshaped" in the UI. This is not a defect and must not be special-cased:

- DSH's native surface mechanism uses `surfaceOp: replace` as the single rewriting primitive; auto-compaction, system-prompt updates and PM's plasticize are merely different callers;
- PM's tools, safety zones and logical generations are a **proper-subset extension** built on that primitive;
- our physical generation number corresponds one-to-one with DSH's `replaceGeneration`; there is no second numbering system;
- when DSH adds another surface-rewriting source, PM automatically presents it as another generation without enumerating or filtering sources — a foreseeable graceful fallback;
- the presentation layer keeps PM terminology (Reshaped / Being reshaped), expressing semantic inclusiveness: every surface rewrite is, in essence, a reshaping.

If PM and official operations ever need to be distinguished in the UI, the presentation layer can simply read the replacement node's `source.kind` (PM uses `"pm-surface"`); the data layer still treats `surfaceOp` as the single source of truth.
