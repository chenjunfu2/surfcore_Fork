import fs from 'node:fs';
const f = 'D:/chenj/Documents/deepseek-harness/default-workspace/surfcore/src/bridge.js';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const start = 8101 - 1;
let depth = 0, started = false, end = -1;
for (let i = start; i < lines.length; i++) {
  for (const ch of lines[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
  if (started && depth === 0) { end = i; break; }
}
console.log(`sendBiliCard: ${start+1} .. ${end+1} (${end-start+1} 行)`);
console.log(`末行: ${lines[end].trim()}`);
console.log(`下一行: ${lines[end+1]?.trim()}`);
