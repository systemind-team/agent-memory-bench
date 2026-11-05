// Both runs together: the same built memories answered twice (run 1 through
// whichever providers OpenRouter picked, the replicate pinned to Azure). A
// question's score is its mean over the runs that answered it; differences
// against production's rewrite are bootstrapped over questions.
//   node pooled.mjs <run1 dir> <run2 dir>  → <run2 dir>/pooled.json
// (a run dir is what OUT points at: chat/, spec/, audit/, ans/, judge/, judge2/)
import { readdirSync } from "node:fs";
import { readJ, writeJ } from "./lib.mjs";
import { KINDS } from "./spec.mjs";

const RUNS = process.argv.slice(2).map((d) => d.replace(/\/$/, "") + "/");
const ARMS = ["none", "full", "rewrite", "tiered", "notes", "facts", "ledger", "notes_recall", "rewrite_facts"];
const ids = readdirSync(RUNS[0] + "spec").filter((f) => /^[a-z]+\.json$/.test(f)).map((f) => f.slice(0, -5));
const score = (p, j) => p.kind === "ask" && j.rule != null ? +j.rule : p.kind === "abstain" ? +(j.verdict === "correct" || j.verdict === "dont_know") : j.verdict === "correct" ? 1 : j.verdict === "partial" ? 0.5 : 0;
const Q = []; // {id, p, s: {arm: mean}}
for (const id of ids) {
  const S = readJ(RUNS[0] + `spec/${id}.json`), audit = readJ(RUNS[0] + `audit/${id}.json`, {});
  for (const p of S.probes) {
    if ((audit[p.id] || {}).exclude) continue;
    const s = {};
    for (const a of ARMS) {
      const xs = RUNS.map((R) => { const j1 = readJ(R + `judge/${a}/${id}/${p.id}.json`), j2 = readJ(R + `judge2/${a}/${id}/${p.id}.json`); return j1 ? score(p, j2 ? { ...j1, ...j2 } : j1) : null; }).filter((x) => x !== null);
      s[a] = xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
    }
    Q.push({ id, kind: p.kind, s });
  }
}
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
function boot(a, b, rows = Q, n = 5000) {
  const d = rows.filter((q) => q.s[a] != null && q.s[b] != null).map((q) => q.s[a] - q.s[b]);
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ds = Array.from({ length: n }, () => mean(Array.from({ length: d.length }, () => d[Math.floor(rnd() * d.length)]))).sort((x, y) => x - y);
  return { diff: +mean(d).toFixed(4), lo: +ds[Math.floor(n * 0.025)].toFixed(4), hi: +ds[Math.floor(n * 0.975)].toFixed(4), n: d.length };
}
const out = { n: Q.length, arms: {} };
for (const a of ARMS) {
  const ok = Q.filter((q) => q.s[a] != null);
  out.arms[a] = {
    score: +mean(ok.map((q) => q.s[a])).toFixed(4),
    by: Object.fromEntries(Object.keys(KINDS).map((k) => [k, +mean(ok.filter((q) => q.kind === k).map((q) => q.s[a])).toFixed(3)])),
    person: Object.fromEntries(ids.map((id) => [id, +mean(ok.filter((q) => q.id === id).map((q) => q.s[a])).toFixed(3)])),
    vs_rewrite: a === "rewrite" ? null : boot(a, "rewrite"),
    vs_rewrite_kai: a === "rewrite" ? null : boot(a, "rewrite", Q.filter((q) => q.id === "kai")),
  };
}
writeJ(RUNS.at(-1) + "pooled.json", out);
for (const [a, r] of Object.entries(out.arms)) console.log(a.padEnd(14), (r.score * 100).toFixed(1), r.vs_rewrite ? `${(r.vs_rewrite.diff * 100).toFixed(1)} [${(r.vs_rewrite.lo * 100).toFixed(1)}, ${(r.vs_rewrite.hi * 100).toFixed(1)}]` : "", " kai", (r.person.kai * 100).toFixed(0), r.vs_rewrite_kai ? `${(r.vs_rewrite_kai.diff * 100).toFixed(0)} [${(r.vs_rewrite_kai.lo * 100).toFixed(0)}, ${(r.vs_rewrite_kai.hi * 100).toFixed(0)}]` : "");
