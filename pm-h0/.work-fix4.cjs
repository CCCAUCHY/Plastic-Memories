const fs = require('node:fs');
let e = fs.readFileSync('engine.js', 'utf8');
const marker = '  const claimed = new Set();';
const insert = [
  "  // 工具路径与 /plasticize 命令共用同一套区间重叠检测（overlap.js）。",
  "  {",
  "    const ranges = planned.filter((entry) => entry.duplicateOf === undefined)",
  "      .flatMap((entry) => entry.resolved.map((span) => ({ seqs: span.shadowed })));",
  "    const overlap = findOverlap(ranges);",
  "    if (overlap !== undefined) throw new Error('本批声明之间区间重叠：有两条声明想遮蔽同一段历史；请分别换算各自的偏移，或合并成一条声明。');",
  "  }",
  "",
  "  const claimed = new Set();",
].join("
");
if (!e.includes('findOverlap(ranges)')) e = e.replace(marker, insert);
fs.writeFileSync('engine.js', e);