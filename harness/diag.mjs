// Why the numbers came out as they did: per-person scores, memory sizes,
// cost per answer, plain-text replies, and every open-loop / ask / pref
// verdict with its reason.   node diag.mjs  → out/diag.json
import { readdirSync, readFileSync } from "node:fs";
import { readJ, writeJ, OUT } from "./lib.mjs";

const ARMS = ["none", "full", "rewrite", "tiered", "notes", "facts", "ledger", "notes_recall", "rewrite_facts"];
const ids = readdirSync(OUT + "spec").filter((f) => /^[a-z]+\.json$/.test(f)).map((f) => f.slice(0, -5));
const ledger = readFileSync(OUT + "spend.jsonl", "utf8").split("\n").filter(Boolean).map(JSON.parse);
const out = { perPerson: {}, mem: {}, costPerAnswer: {}, plain: {}, detail: {} };
for (const a of ARMS) {
  out.perPerson[a] = {}; out.plain[a] = 0;
  const ans = ledger.filter((r) => r.tag.startsWith(`answer/${a}/`));
  for (const id of ids) {
    const S = readJ(OUT + `spec/${id}.json`), audit = readJ(OUT + `audit/${id}.json`, {});
    let s = 0, n = 0;
    for (const p of S.probes) {
      if ((audit[p.id] || {}).exclude) continue;
      const j1 = readJ(OUT + `judge/${a}/${id}/${p.id}.json`), j2 = readJ(OUT + `judge2/${a}/${id}/${p.id}.json`), j = j2 ? { ...j1, ...j2 } : j1, an = readJ(OUT + `ans/${a}/${id}/${p.id}.json`); if (!j || !an) continue;
      if (an.plain) out.plain[a]++;
      const sc = p.kind === "ask" && j.rule != null ? +j.rule : p.kind === "abstain" ? +(j.verdict === "correct" || j.verdict === "dont_know") : j.verdict === "correct" ? 1 : j.verdict === "partial" ? 0.5 : 0;
      s += sc; n++;
      if (["open_loop", "ask", "pref_apply", "aggregate"].includes(p.kind)) (out.detail[`${id}:${p.id}`] ||= { kind: p.kind, q: p.q.slice(0, 80), gold: String((audit[p.id] || {}).gold || p.gold).slice(0, 80), arms: {} }).arms[a] = `${j.verdict}${j.rule != null ? (j.rule ? "/rule✓" : "/rule✗") : ""}: ${String(j.why || "").slice(0, 90)}`;
    }
    out.perPerson[a][id] = +(s / Math.max(1, n)).toFixed(3);
    const m = readJ(OUT + `mem/${a}/${id}.json`);
    if (m) { const st = m.state; (out.mem[a] ||= {})[id] = { writes: st.writes, ledger: st.log && st.log.length, ledgerTypes: st.log && Object.fromEntries(Object.entries(st.log.reduce((c, e) => (c[e.type] = (c[e.type] || 0) + 1, c), {}))), notes: st.notes && Object.keys(st.notes).length, facts: st.facts && st.facts.filter((f) => f.active).length, rewriteChars: st.notes && typeof st.notes === "string" ? st.notes.length : undefined, compactions: st.compactions, months: st.months && Object.keys(st.months).length, weeks: st.weeks && Object.keys(st.weeks).length }; }
  }
  const answered = ids.reduce((k, id) => k + readdirSync(OUT + `ans/${a}/${id}`).filter((f) => !f.includes(".err")).length, 0);
  out.costPerAnswer[a] = +(ans.reduce((x, r) => x + (r.usd || 0), 0) / Math.max(1, answered)).toFixed(6);
}
writeJ(OUT + "diag.json", out);
console.log(JSON.stringify({ perPerson: out.perPerson, plain: out.plain }));
