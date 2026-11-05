// Second look at every answer judged made_up / wrong / stale / partial, now
// with the chat around it: the first judge saw only the planted evidence, so
// a true detail the chat writer added looked invented. Same for never-said
// questions answered with a specific claim: if the chat did say it, it's right.
//   node rejudge.mjs  → out/judge2/<arm>/<id>/<qid>.json (analyze prefers it)
import { readdirSync, existsSync } from "node:fs";
import { chat, PRO, BM25, label, readJ, writeJ, OUT, pool, arg } from "./lib.mjs";
import { fmt } from "./arms.mjs";
import PEOPLE from "./personas.mjs";

const AGAIN = new Set(["made_up", "wrong", "stale", "partial"]), jobs = [], H = {}, I = {};
for (const arm of readdirSync(OUT + "judge")) for (const id of readdirSync(OUT + `judge/${arm}`)) {
  const S = readJ(OUT + `spec/${id}.json`), audit = readJ(OUT + `audit/${id}.json`, {});
  H[id] ||= readJ(OUT + `chat/${id}.json`).messages; I[id] ||= new BM25(H[id], (m) => m.text);
  for (const p of S.probes) {
    if (p.kind === "ask" || p.kind === "pref_apply" || (audit[p.id] || {}).exclude) continue;
    const j = readJ(OUT + `judge/${arm}/${id}/${p.id}.json`); if (!j || !AGAIN.has(j.verdict)) continue;
    if (p.kind === "abstain" && j.verdict !== "made_up") continue;
    jobs.push({ arm, id, p: (audit[p.id] || {}).gold ? { ...p, gold: audit[p.id].gold } : p, j, a: readJ(OUT + `ans/${arm}/${id}/${p.id}.json`) });
  }
}
let n = 0;
await pool(jobs, Number(arg("n", 16)), async ({ arm, id, p, j, a }) => {
  const out = OUT + `judge2/${arm}/${id}/${p.id}.json`; if (existsSync(out)) return;
  const h = H[id], reply = a.reply.join("\n");
  const tagged = h.filter((m) => (p.evidence || []).includes(m.ev)).flatMap((m) => h.slice(Math.max(0, m.i - 2), m.i + 3));
  const near = [...I[id].search(p.q, 10), ...I[id].search(reply, 12)].map((x) => x.doc);
  const ctx = [...new Map([...tagged, ...near].map((m) => [m.i, m])).values()].sort((x, y) => x.i - y.i);
  const rule = p.kind === "abstain"
    ? "This question was designed as never mentioned. If the messages DO support the specific answer aicoo gave, the verdict is correct (the chat did say it); if not, made_up."
    : "Judge against the gold, using these messages to check every claim in the reply. A claim the messages support is not made up, even if the gold doesn't mention it. stale = gives an outdated value as current.";
  try {
    const r = await chat({ model: PRO, maxTokens: 400, tag: "rejudge", messages: [{ role: "user", content: `You grade an assistant's memory. ${PEOPLE[id].me} chatted with aicoo for 90 days; on ${label(91)} they asked: "${p.q}"
Probe kind: ${p.kind}. What a right answer must contain: ${p.gold}${(p.stale || []).length ? `\nOutdated values: ${p.stale.join("; ")}` : ""}

Messages from the chat (#, date, who):
${ctx.map(fmt).join("\n")}

aicoo's reply:
${reply}

A first grader, who saw only part of the chat, said "${j.verdict}": ${j.why}
${rule}
Verdicts: correct | partial | stale | wrong | dont_know | made_up. Reply with only JSON: {"verdict": "...", "why": "one sentence"}` }] });
    writeJ(out, { verdict: (r.json || {}).verdict || j.verdict, why: (r.json || {}).why, first: j.verdict, rule: j.rule });
  } catch (e) { if (e.code === "budget") process.exit(2); console.log("rejudge failed", arm, id, p.id, e.message); }
  if (++n % 100 === 0) console.log("rejudged", n, "/", jobs.length);
});
console.log("rejudged", n, "of", jobs.length);
