// Grades every answer against the probe's gold (DeepSeek-V4-Pro), and checks
// the behaviour probes with rules.   node judge.mjs [--n 16]
import { readdirSync, existsSync } from "node:fs";
import { chat, PRO, label, readJ, writeJ, OUT, pool, arg } from "./lib.mjs";
import PEOPLE from "./personas.mjs";

const STK = /\[sticker/i;
export function rule(p, reply) {
  const c = p.check || {}, all = reply.join("\n"), text = reply.filter((x) => !STK.test(x)).join("\n");
  if (c.noSticker) return !STK.test(all);
  if (c.noBang) return !/[!！]/.test(text);
  if (c.noBullets) return text.split("\n").filter((l) => /^\s*([-•*·]|\d+[.)、])\s+/.test(l)).length === 0;
  if (c.lang) { const cjk = (text.match(/[一-鿿]/g) || []).length / Math.max(1, text.replace(/\s/g, "").length); return c.lang === "zh" ? cjk > 0.3 : cjk < 0.1; }
  if (c.mention) return new RegExp(c.mention, "i").test(text);
  return null;
}

const GUIDE = {
  recall: "correct if it gives the fact; partial if part of it.",
  update: "correct if it gives the LATEST value (mentioning the history is fine); stale if it gives an earlier value as the current one.",
  temporal: "correct if the date is right within a day (or the order is right).",
  aggregate: "correct if the count and the items are right; partial if some are.",
  open_loop: "correct if it identifies the commitment and gets its status (still open, or done) right.",
  ask: "correct if the reply behaves as the gold says.",
  pref_apply: "correct if the draft follows the preference in the gold.",
  abstain: "this was NEVER said. correct (or dont_know) if it says it doesn't know, can't find it, or asks; made_up if it states any specific answer.",
};

async function grade(p0, a, S, id) {
  // The audit's corrected gold, where it fixed one (audit.mjs).
  const fix = (readJ(OUT + `audit/${id}.json`, {})[p0.id] || {}).gold, p = fix ? { ...p0, gold: fix } : p0;
  const ev = new Map(S.events.map((e) => [e.id, e]));
  const r = await chat({ model: PRO, maxTokens: 400, tag: "judge", messages: [{ role: "user", content: `You grade an assistant's memory. ${PEOPLE[id].me} chatted with their assistant aicoo for 90 days (${label(1)} – ${label(90)} 2026). On ${label(91)} they asked it something.
Who they are: ${PEOPLE[id].brief}

What was said in the chat that answers it:
${(p.evidence || []).map((x) => ev.get(x)).filter(Boolean).map((e) => `- ${label(e.day)} ${e.time} ${e.who === "u" ? "them" : "aicoo"}: ${e.text}`).join("\n") || "(nothing: it was never said)"}

Their question: ${p.q}
Probe kind: ${p.kind}. What a right answer must contain: ${p.gold}${(p.stale || []).length ? `\nOutdated values (stale if given as current): ${p.stale.join("; ")}` : ""}
aicoo's reply (one chat message per line):
${a.reply.join("\n")}
Tools it used: ${a.steps.map((s) => s.tool).join(", ") || "none"}

How to grade this kind: ${GUIDE[p.kind]}
Verdicts: correct | partial | stale | wrong (another answer, not made up) | dont_know (says it doesn't know / can't find / asks) | made_up (states a specific past fact, value or event that the chat above doesn't support, as the answer). Extra details you can't check, beside a right answer, don't count against it.
Reply with only JSON: {"verdict": "...", "why": "one sentence"}` }] });
  return { verdict: (r.json || {}).verdict, why: (r.json || {}).why };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jobs = [];
  for (const arm of readdirSync(OUT + "ans")) for (const id of readdirSync(OUT + `ans/${arm}`)) {
    const S = readJ(OUT + `spec/${id}.json`), P = new Map(S.probes.map((p) => [p.id, p]));
    for (const f of readdirSync(OUT + `ans/${arm}/${id}`)) if (!f.includes(".err")) jobs.push({ arm, id, S, p: P.get(f.replace(".json", "")), f: OUT + `ans/${arm}/${id}/${f}` });
  }
  let n = 0;
  await pool(jobs, Number(arg("n", 16)), async (j) => {
    const out = OUT + `judge/${j.arm}/${j.id}/${j.p.id}.json`; if (existsSync(out)) return;
    const a = readJ(j.f);
    try { writeJ(out, { ...(await grade(j.p, a, j.S, j.id)), rule: rule(j.p, a.reply) }); } catch (e) { if (e.code === "budget") process.exit(2); console.log("judge failed", j.arm, j.id, j.p.id, e.message); }
    if (++n % 100 === 0) console.log("judged", n, "/", jobs.length);
  });
  console.log("judged", n);
}
