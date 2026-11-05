// Checks each question against the chat as written (the design can contradict
// itself, and the chat writer can add contradictions): is the gold right and
// the only reasonable answer on Nov 1? A clear fix replaces the gold; anything
// ambiguous is left out of scoring. Never-said questions: does any message
// answer them after all?   node audit.mjs
import { chat, PRO, BM25, label, readJ, writeJ, OUT, pool } from "./lib.mjs";
import { fmt } from "./arms.mjs";
import PEOPLE from "./personas.mjs";

const ids = Object.keys(PEOPLE).filter((id) => readJ(OUT + `chat/${id}.json`));
await pool(ids, ids.length, async (id) => {
  const f = OUT + `audit/${id}.json`, out = readJ(f, {});
  const S = readJ(OUT + `spec/${id}.json`), hist = readJ(OUT + `chat/${id}.json`).messages, idx = new BM25(hist, (m) => m.text);
  const ev = new Map(S.events.map((e) => [e.id, e]));
  await pool(S.probes.filter((p) => !out[p.id] && p.kind !== "ask" && p.kind !== "pref_apply"), 6, async (p) => {
    const tagged = hist.filter((m) => (p.evidence || []).includes(m.ev)).flatMap((m) => [hist[m.i - 1], m, hist[m.i + 1]]).filter(Boolean);
    const near = idx.search(p.q + " " + (p.kind === "abstain" ? "" : p.gold), 14).map((h) => h.doc);
    const msgs = [...new Map([...tagged, ...near].map((m) => [m.i, m])).values()].sort((a, b) => a.i - b.i);
    const ask = p.kind === "abstain"
      ? `Does any of these messages answer the question (fully or partly)? It was meant never to be said.\nReply with only JSON: {"answered": true | false, "which": "message number or empty", "reason": "one sentence"}`
      : `Is the gold answer correct, and the only reasonable answer as of ${label(91)}, given these messages? Planted evidence: ${(p.evidence || []).map((x) => ev.get(x)).filter(Boolean).map((e) => `${label(e.day)}: ${e.text}`).join(" / ")}.${(p.stale || []).length ? ` It's an update question: earlier values were ${p.stale.join("; ")}.` : ""}\nIf the messages clearly support a different single answer, give it as "fixed". If they conflict so that no single answer is right, say ambiguous.\nReply with only JSON: {"verdict": "ok" | "fixed" | "ambiguous", "fixed": "corrected gold, if fixed", "reason": "one sentence"}`;
    try {
      const r = await chat({ model: PRO, maxTokens: 400, tag: "audit", messages: [{ role: "user", content: `A memory test for an assistant: ${PEOPLE[id].me} chatted with aicoo for 90 days; on ${label(91)} they ask: "${p.q}"\nProbe kind: ${p.kind}. Gold answer: ${p.gold}\n\nMessages from the chat (#number, date, who):\n${msgs.map(fmt).join("\n")}\n\n${ask}` }] });
      const j = r.json || {};
      out[p.id] = p.kind === "abstain" ? { exclude: !!j.answered, reason: j.reason, which: j.which } : { exclude: j.verdict === "ambiguous" || (j.verdict === "fixed" && !j.fixed), gold: j.verdict === "fixed" && j.fixed ? String(j.fixed) : undefined, verdict: j.verdict, reason: j.reason };
    } catch (e) { if (e.code === "budget") throw e; console.log("audit failed", id, p.id, e.message); }
  });
  writeJ(f, out);
  const v = Object.values(out); console.log(id, "audited", v.length, "excluded", v.filter((x) => x.exclude).length, "gold fixed", v.filter((x) => x.gold).length);
});
