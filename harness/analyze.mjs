// Scores, costs and paired differences per arm; writes out/summary.json and
// out/examples.json, prints a compact table.   node analyze.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { readJ, writeJ, OUT } from "./lib.mjs";
import { KINDS } from "./spec.mjs";

// The published designs in their usual order, then any you added.
const KNOWN = ["none", "full", "rewrite", "tiered", "notes", "facts", "ledger", "notes_recall", "rewrite_facts"], judged = existsSync(OUT + "judge") ? readdirSync(OUT + "judge") : [];
const ARMS = [...KNOWN.filter((a) => judged.includes(a)), ...judged.filter((a) => !KNOWN.includes(a))];
const ids = readdirSync(OUT + "spec").filter((f) => /^[a-z]+\.json$/.test(f)).map((f) => f.slice(0, -5));
// Questions the audit found ambiguous (or never-said ones the chat answered after all) are left out.
const audit = Object.fromEntries(ids.map((id) => [id, readJ(OUT + `audit/${id}.json`, {})]));
const spec = Object.fromEntries(ids.map((id) => { const s = readJ(OUT + `spec/${id}.json`); return [id, { ...s, probes: s.probes.filter((p) => !(audit[id][p.id] || {}).exclude) }]; }));
const excluded = ids.flatMap((id) => Object.entries(audit[id]).filter(([, v]) => v.exclude).map(([q, v]) => ({ id, q, reason: v.reason })));
const score = (p, j) => {
  // Requests (a name, no "!", a language) by rule; preferences by the judge: their regexes, written by the
  // designer, miss right drafts ("本周踩坑" for "本周踩的坑").
  if (p.kind === "ask" && j.rule !== null && j.rule !== undefined) return j.rule ? 1 : 0;
  if (p.kind === "abstain") return j.verdict === "correct" || j.verdict === "dont_know" ? 1 : 0;
  return j.verdict === "correct" ? 1 : j.verdict === "partial" ? 0.5 : 0;
};
const ledger = existsSync(OUT + "spend.jsonl") ? readFileSync(OUT + "spend.jsonl", "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const cost = (pre) => ledger.filter((r) => r.tag.startsWith(pre)).reduce((s, r) => ({ usd: s.usd + (r.usd || 0), in: s.in + r.in, out: s.out + r.out, calls: s.calls + 1 }), { usd: 0, in: 0, out: 0, calls: 0 });

const rows = {}; // arm -> [{id, qid, kind, s, verdict}]
for (const a of ARMS) {
  rows[a] = [];
  for (const id of ids) for (const p of spec[id].probes) {
    // The second look (rejudge.mjs), where there is one, replaces the first verdict.
    const j1 = readJ(OUT + `judge/${a}/${id}/${p.id}.json`), j2 = readJ(OUT + `judge2/${a}/${id}/${p.id}.json`), j = j2 ? { ...j1, ...j2 } : j1, an = readJ(OUT + `ans/${a}/${id}/${p.id}.json`);
    if (!j || !an) { rows[a].push({ id, qid: p.id, kind: p.kind, missing: true }); continue; }
    rows[a].push({ id, qid: p.id, kind: p.kind, touched: !!(audit[id][p.id] || {}).gold, s: score(p, j), first: j1 ? score(p, j1) : null, changed: !!j2 && j2.verdict !== j2.first, verdict: j.verdict, rule: j.rule, in: an.calls.reduce((x, c) => x + c.in, 0), calls: an.calls.length, tools: an.steps.length, mem: an.memChars, prompt: an.promptChars });
  }
}
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
// Paired bootstrap of the mean difference against production's rewrite, over the same probes.
function boot(a, b, n = 4000) {
  const pairs = rows[a].map((r, k) => [r, rows[b][k]]).filter(([x, y]) => !x.missing && !y.missing).map(([x, y]) => x.s - y.s);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ds = Array.from({ length: n }, () => mean(Array.from({ length: pairs.length }, () => pairs[Math.floor(rnd() * pairs.length)]))).sort((x, y) => x - y);
  return { diff: mean(pairs), lo: ds[Math.floor(n * 0.025)], hi: ds[Math.floor(n * 0.975)], n: pairs.length };
}
const out = { arms: {}, kinds: Object.keys(KINDS), n: Object.values(spec).reduce((s, x) => s + x.probes.length, 0), excluded, fixed: ids.flatMap((id) => Object.entries(audit[id]).filter(([, v]) => v.gold).map(([q]) => id + ":" + q)), spent: ledger.reduce((s, r) => s + (r.usd || 0), 0) };
for (const a of ARMS) {
  const ok = rows[a].filter((r) => !r.missing), by = {};
  for (const k of Object.keys(KINDS)) by[k] = mean(ok.filter((r) => r.kind === k).map((r) => r.s));
  const answerable = ok.filter((r) => !["abstain", "ask", "pref_apply"].includes(r.kind));
  const build = cost(`build/${a}/`), ans = cost(`answer/${a}/`);
  out.arms[a] = {
    n: ok.length, missing: rows[a].length - ok.length, score: mean(ok.map((r) => r.s)), by,
    // Robustness: only questions whose gold the audit left as designed.
    score_untouched: mean(ok.filter((r) => !r.touched).map((r) => r.s)), n_untouched: ok.filter((r) => !r.touched).length,
    score_first_judge: mean(ok.map((r) => r.first)), regraded: ok.filter((r) => r.changed).length,
    made_up: ok.filter((r) => r.verdict === "made_up").length, made_up_abstain: ok.filter((r) => r.kind === "abstain" && r.verdict === "made_up").length,
    stale: ok.filter((r) => r.kind === "update" && r.verdict === "stale").length, dont_know: answerable.filter((r) => r.verdict === "dont_know").length,
    in_per_q: mean(ok.map((r) => r.in)), calls_per_q: mean(ok.map((r) => r.calls)), tools_per_q: mean(ok.map((r) => r.tools)), mem_chars: mean(ok.map((r) => r.mem)),
    build_usd: build.usd, build_in: build.in, build_out: build.out, build_calls: build.calls, answer_usd: ans.usd,
    vs_rewrite: a === "rewrite" || !rows.rewrite ? null : boot(a, "rewrite"),
  };
}
writeJ(OUT + "summary.json", out);
// One probe of each kind per person, every arm's reply and verdict, for the report.
const ex = [];
for (const id of ids) for (const k of Object.keys(KINDS)) {
  const p = spec[id].probes.find((x) => x.kind === k); if (!p) continue;
  ex.push({ id, qid: p.id, kind: k, q: p.q, gold: p.gold, arms: Object.fromEntries(ARMS.map((a) => { const an = readJ(OUT + `ans/${a}/${id}/${p.id}.json`), j = readJ(OUT + `judge/${a}/${id}/${p.id}.json`); return [a, an && j ? { reply: an.reply.join(" / ").slice(0, 400), v: j.verdict, why: j.why, tools: an.steps.map((s) => s.tool) } : null]; })) });
}
writeJ(OUT + "examples.json", ex);
const f = (x) => (x * 100).toFixed(0).padStart(4);
console.log("arm      n   score " + Object.keys(KINDS).map((k) => k.slice(0, 6).padStart(7)).join("") + "  madeup stale dk  in/q  calls build$  vsRewrite");
for (const [a, r] of Object.entries(out.arms)) console.log(a.padEnd(8), String(r.n).padStart(3), f(r.score), "  " + Object.keys(KINDS).map((k) => f(r.by[k]).padStart(7)).join(""), String(r.made_up).padStart(6), String(r.stale).padStart(5), String(r.dont_know).padStart(3), String(Math.round(r.in_per_q)).padStart(6), r.calls_per_q.toFixed(2), r.build_usd.toFixed(2).padStart(6), r.vs_rewrite ? `${(r.vs_rewrite.diff * 100).toFixed(1)} [${(r.vs_rewrite.lo * 100).toFixed(1)},${(r.vs_rewrite.hi * 100).toFixed(1)}]` : "");
console.log("first-judge score:", Object.entries(out.arms).map(([a, r]) => `${a} ${(r.score_first_judge * 100).toFixed(0)} (${r.regraded} regraded)`).join("  "));
console.log("untouched-only score:", Object.entries(out.arms).map(([a, r]) => `${a} ${(r.score_untouched * 100).toFixed(0)}`).join("  "), "(n=" + (Object.values(out.arms)[0] || {}).n_untouched + ")");
console.log("questions scored", out.n, "excluded", excluded.length, "gold fixed", out.fixed.length, "| spent $" + out.spent.toFixed(2));
