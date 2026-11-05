// Designs each person's 90 days: the events planted in their chat and the
// questions asked on day 91, then checks the design before anything uses it.
// Two halves per person (the provider cuts outputs near 8k tokens): A holds
// the fact probes, B the rest plus noise, written knowing A's events. Each
// half is repaired on its own: its last JSON and its problems go back.
//   node spec.mjs [dan,yuan,mo,kai]
import { chat, PRO, label, writeJ, readJ, OUT } from "./lib.mjs";
import PEOPLE from "./personas.mjs";

export const KINDS = { recall: 10, update: 6, temporal: 5, aggregate: 5, open_loop: 5, ask: 4, pref_apply: 4, abstain: 6 };
const HALF = {
  A: { kinds: { recall: 10, update: 6, temporal: 5, aggregate: 5 }, noise: 0, q0: 1 },
  B: { kinds: { open_loop: 5, ask: 4, pref_apply: 4, abstain: 6 }, noise: 13, q0: 27 },
};
const RULES = {
  recall: "recall ×10: one event states a specific fact (a number, amount, name, place, date or decision) on days 1–80, at least 5 of them before day 45. The question asks for it casually, the way they'd ask on day 91, without giving the answer away.",
  update: "update ×6: a fact is set, then changed once or twice later (each change at least 7 days after the previous, the last by day 85). Every version is its own event. gold = the latest value; \"stale\" = the earlier values.",
  temporal: "temporal ×5: asks WHEN something happened (gold has the date, like \"Sep 14\") or which of two things happened first. Its events are its own.",
  aggregate: "aggregate ×5: 3–5 related events spread over at least 3 different weeks (each time they postponed the same thing, each candidate they interviewed, each city they flew to…), every one its own event. gold = the count and the list.",
  open_loop: "open_loop ×5: a commitment: they promise someone something, or ask aicoo to remind them of something and aicoo agrees (a \"u\" event, then an \"a\" event agreeing). 3 are never closed; 2 are closed by a later event that says it's done. The question asks about that one commitment's status; gold says open or done (and when).",
  ask: "ask ×4: on days 20–80 they ask aicoo to treat them differently: a new name for aicoo; what to call them; no stickers, no bullet lists or no exclamation marks; or which language to reply in. aicoo agrees once (an \"a\" event). The question is a casual message where it would show (\"morning\", \"how's this week looking\"). check is one of {\"mention\": \"<JS regex the reply must match>\"}, {\"noBullets\": true}, {\"noBang\": true}, {\"noSticker\": true}, {\"lang\": \"en\" | \"zh\"}.",
  pref_apply: "pref_apply ×4: on days 10–80 they state how they want a kind of work product done (\"PR descriptions always end with a Risk section\", \"周报里加一段本周踩的坑\"). The question asks aicoo to draft that kind of thing. check = {\"mention\": \"<JS regex>\"}.",
  abstain: "abstain ×6: questions about plausible things in their world that are NEVER said in the chat. 3 are near misses: the same attribute is known for a different person or thing (one person's vacation dates are an event, ask another's), or the same person but another attribute. gold = \"never mentioned: aicoo should say it doesn't know\". \"forbid\" = a JS regex string that would match a chat message that mentioned it (so the chat writer can avoid it). evidence = [].",
};

function prompt(P, h, A) {
  const H = HALF[h], n = Object.values(H.kinds).reduce((a, b) => a + b, 0), e0 = A ? A.events.length + 1 : 1;
  return `You are designing a test of an assistant's long-term memory. ${P.me} chats privately with aicoo, their workspace assistant, every day for 90 days. Day 1 is ${label(1)} 2026 (a Monday), day 90 is ${label(90)} 2026. On day 91 (${label(91)}, morning) they ask aicoo questions. Design events planted in the chat and the questions.

Who they are: ${P.brief}
People: ${P.people.join(", ")}.
Language of every event and question: ${P.lang}.

Make these probes (exact counts), each with the events it needs:
${Object.keys(H.kinds).map((k) => "- " + RULES[k]).join("\n")}
${H.noise ? `Also add ${H.noise} noise events (kind "noise"): ordinary specific facts with numbers, names and dates about other things, including near-duplicates of the facts below with different values (another budget, another deadline), so a sloppy memory confuses them. No probe asks about them.\n` : ""}${A ? `
EVENTS ALREADY PLANTED (don't contradict them, don't reuse their topics for new probes, and no forbid regex may match them):
${A.events.map((e) => `${e.id} d${e.day}: ${e.text}`).join("\n")}
` : ""}
Rules: event ids e${e0}, e${e0 + 1}…; probe ids q${H.q0}…q${H.q0 + n - 1}. Every event has day (1–90), time "HH:MM", who ("u" or "a"), text (what is said, natural, short, with the exact values) and kind (the probe kind, or "noise"). Spread events over all 13 weeks; nothing on days 89–90. Facts are never contradicted except by their own update events. A probe's evidence lists its event ids in time order. Keep texts short.

Reply with only JSON: {"events": [{"id","day","time","who","text","kind"}], "probes": [{"id","kind","q","gold","stale"?: [], "evidence": [], "check"?: {}, "forbid"?: "regex"}]}`;
}

export function validate(s, kinds = KINDS, noise = 20, others = []) {
  const errs = [];
  if (!s || !Array.isArray(s.events) || !Array.isArray(s.probes)) return ["events and probes must be arrays"];
  const ev = new Map([...others, ...s.events].map((e) => [e.id, e]));
  if (ev.size !== others.length + s.events.length) errs.push("duplicate event ids (continue numbering after the planted ones)");
  for (const e of s.events) {
    if (!(e.day >= 1 && e.day <= 90)) errs.push(`${e.id}: day ${e.day} out of range`);
    if (!/^\d\d:\d\d$/.test(e.time || "")) errs.push(`${e.id}: bad time`);
    if (!["u", "a"].includes(e.who) || !e.text) errs.push(`${e.id}: who/text`);
  }
  const n = {}; for (const p of s.probes) n[p.kind] = (n[p.kind] || 0) + 1;
  for (const [k, c] of Object.entries(kinds)) if ((n[k] || 0) !== c) errs.push(`${k}: ${n[k] || 0} probes, need ${c}`);
  for (const k of Object.keys(n)) if (!kinds[k]) errs.push(`${k}: not a kind for this part`);
  for (const p of s.probes) {
    if (!p.q || !p.gold) errs.push(`${p.id}: q or gold missing`);
    const es = (p.evidence || []).map((x) => ev.get(x));
    if (es.some((e) => !e)) errs.push(`${p.id}: evidence ${p.evidence} not all events`);
    if (p.kind !== "abstain" && !es.length) errs.push(`${p.id}: no evidence`);
    if (p.kind === "update" && (es.length < 2 || !(p.stale || []).length)) errs.push(`${p.id}: update needs ≥2 events (every version its own event) and stale values`);
    if (p.kind === "aggregate") { const wk = new Set(es.filter(Boolean).map((e) => Math.floor((e.day - 1) / 7))); if (es.length < 3 || wk.size < 3) errs.push(`${p.id}: aggregate needs 3+ events in 3+ different weeks`); }
    if (p.kind === "recall" && es[0] && es[0].day > 80) errs.push(`${p.id}: recall event after day 80`);
    if ((p.kind === "ask" || p.kind === "pref_apply") && !p.check) errs.push(`${p.id}: check missing`);
    if (p.check && p.check.mention) try { new RegExp(p.check.mention, "i"); } catch { errs.push(`${p.id}: bad check regex`); }
    if (p.kind === "abstain") {
      if (!p.forbid) { errs.push(`${p.id}: forbid missing`); continue; }
      let re; try { re = new RegExp(p.forbid, "i"); } catch { errs.push(`${p.id}: bad forbid regex`); continue; }
      const hit = [...others, ...s.events].find((e) => re.test(e.text)); if (hit) errs.push(`${p.id}: forbid regex matches event ${hit.id} (pick a topic that's never said, or narrow the regex)`);
    }
  }
  if (kinds.recall) { const early = s.probes.filter((p) => p.kind === "recall").map((p) => ev.get((p.evidence || [])[0])).filter((e) => e && e.day < 45).length; if (early < 5) errs.push(`only ${early} recall facts before day 45, need 5`); }
  if (noise && s.events.filter((e) => e.kind === "noise").length < noise - 3) errs.push(`fewer than ${noise - 3} noise events`);
  return errs;
}

// B tends to copy A's events back (sometimes relabelled as noise) and to name
// fields its own way; that's fixed here rather than by another round trip.
function normalize(s, A) {
  if (!s || !Array.isArray(s.events) || !Array.isArray(s.probes)) return s;
  const aIds = new Set((A ? A.events : []).map((e) => e.id));
  return {
    events: s.events.filter((e) => e && !aIds.has(e.id)),
    probes: s.probes.filter(Boolean).map((p) => ({ ...p, q: p.q || p.question, gold: p.gold || p.expected || p.answer || p.gold_answer, stale: Array.isArray(p.stale) ? p.stale : p.stale ? [String(p.stale)] : [], evidence: Array.isArray(p.evidence) ? p.evidence : [] })),
  };
}

async function half(id, h, A) {
  const f = OUT + `spec/${id}.${h}.json`, done = readJ(f); if (done) return done;
  const P = PEOPLE[id], H = HALF[h], check = (s) => validate(s, H.kinds, H.noise, A ? A.events : []);
  const want = Object.values(H.kinds).reduce((a, b) => a + b, 0);
  // Fewer problems is better, but a design missing whole probes is worse than it looks.
  const badness = (s) => check(s).length + 3 * Math.abs(want - ((s && s.probes) || []).length);
  let best = readJ(OUT + `spec/${id}.${h}.failed.json`), s = best && normalize(best.s, A), fb = s && check(s).slice(0, 40).join("\n");
  if (s && !check(s).length) { writeJ(f, s); console.log(id, h, "saved design passes once normalized"); return s; }
  for (let k = 0; k < 6; k++) {
    const messages = s && fb
      ? [{ role: "user", content: prompt(P, h, A) }, { role: "assistant", content: JSON.stringify(s) }, { role: "user", content: `That design has these problems. Fix exactly these, keep everything else, and reply with the whole corrected JSON:\n${fb}` }]
      : [{ role: "user", content: prompt(P, h, A) }];
    let next = null;
    try { next = normalize((await chat({ model: PRO, maxTokens: 8000, tag: `spec/${id}`, messages })).json, A); } catch (e) { if (e.code === "budget") throw e; console.log(id, h, "try", k + 1, "no usable reply:", e.message.slice(0, 80)); continue; }
    const errs = check(next);
    console.log(id, h, "try", k + 1, "events", (next.events || []).length, "probes", (next.probes || []).length, "problems", errs.length, errs.slice(0, 3).join(" | ").slice(0, 240));
    if (!errs.length) { writeJ(f, next); return next; }
    if (!s || badness(next) <= badness(s)) { s = next; fb = errs.slice(0, 40).join("\n"); writeJ(OUT + `spec/${id}.${h}.failed.json`, { s, fb }); }
  }
  throw new Error(`${id} ${h}: no valid design`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = (process.argv[2] || Object.keys(PEOPLE).join(",")).split(",");
  await Promise.all(ids.map(async (id) => {
    const out = OUT + `spec/${id}.json`; if (readJ(out)) return console.log(id, "exists");
    try {
      const A = await half(id, "A"), B = await half(id, "B", A);
      const s = { events: [...A.events, ...B.events].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time)), probes: [...A.probes, ...B.probes] };
      const errs = validate(s, KINDS, 13); if (errs.length) throw new Error("combined: " + errs.join("; "));
      writeJ(out, s); console.log(id, "spec ok:", s.events.length, "events,", s.probes.length, "probes");
    } catch (e) { console.log(id, "FAILED:", e.message.slice(0, 300)); }
  }));
}
