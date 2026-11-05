// Writes each person's 90 days of chat, a week per call, around the planted
// events in out/spec/<id>.json. Every event must show up at its time with its
// numbers; nothing may answer an abstain question.   node gen.mjs [ids]
import { chat, FLASH, PRO, label, writeJ, readJ, OUT, pool } from "./lib.mjs";
import PEOPLE from "./personas.mjs";

const nums = (t) => (String(t).match(/\d+(?:[.,:]\d+)*/g) || []);
function prompt(P, w, a, b, events, story, asks, avoid, feedback) {
  return `Write part ${w} of the private chat between ${P.me} and aicoo, their workspace assistant: days ${a}–${b} (${label(a)} – ${label(b)} 2026).
Who they are: ${P.brief}
Language: ${P.lang}. Texting style: short messages, sometimes several in a row; aicoo replies warmly in one to three short messages.
About ${P.perDay} messages a day on weekdays (some days busier, some quieter), fewer at weekends. Everyday work talk, quick questions, small updates, plans, the odd joke or bad day. Realistic and varied, never repetitive.

The story so far:
${story || "(this is the first week; they've just started using aicoo)"}

These events must happen at their day and time, said by that side, in these words or very close; keep every number, name and date exactly. Put the event id in "ev" on that message:
${events.map((e) => `- ${e.id} · day ${e.day} ${e.time} · ${e.who === "u" ? "them" : "aicoo"}: ${e.text}`).join("\n") || "(none this week)"}

Rules:
- Don't restate facts from earlier weeks unless an event above does. Don't give other values for the topics above.
- Never say anything that would answer these questions (keep these topics out of the chat entirely):
${avoid.map((q) => `  · ${q}`).join("\n")}
- aicoo goes along with what they've asked of it so far: ${asks.length ? asks.join(" / ") : "(nothing yet)"}. It doesn't comment on it.
- No message after day ${b}.

Reply with only JSON: {"messages": [{"day": n, "time": "HH:MM", "who": "u" | "a", "text": "...", "ev"?: "e12"}], "summary": "at most 6 lines: what happened in these days, for continuity"}${feedback ? `\n\nYour last version had these problems; fix them:\n${feedback}` : ""}`;
}

function check(msgs, events, forbid, a, b, target) {
  const errs = [];
  for (const e of events) {
    const m = msgs.find((x) => x.ev === e.id);
    if (!m) { errs.push(`event ${e.id} missing`); continue; }
    if (m.day !== e.day || m.who !== e.who) errs.push(`event ${e.id} must be day ${e.day}, said by ${e.who === "u" ? "them" : "aicoo"}`);
    const miss = nums(e.text).filter((n) => !m.text.includes(n)); if (miss.length) errs.push(`event ${e.id} lost ${miss.join(", ")}`);
  }
  for (const m of msgs) for (const f of forbid) if (f.re.test(m.text)) errs.push(`day ${m.day} ${m.time} mentions something it must not ("${m.text.slice(0, 60)}")`);
  if (msgs.some((m) => m.day < a || m.day > b)) errs.push(`messages outside days ${a}–${b}`);
  if (msgs.length < target * 0.6) errs.push(`only ${msgs.length} messages, want about ${target}`);
  return errs;
}

async function person(id) {
  const out = OUT + `chat/${id}.json`; if (readJ(out)) return console.log(id, "exists");
  const P = PEOPLE[id], S = readJ(OUT + `spec/${id}.json`); if (!S) throw new Error(`no spec for ${id}`);
  const forbid = S.probes.filter((p) => p.kind === "abstain").map((p) => ({ q: p.q, re: new RegExp(p.forbid, "i") }));
  const askEv = new Set(S.probes.filter((p) => p.kind === "ask").flatMap((p) => p.evidence));
  let story = "", all = [], log = [];
  // A call writes 7 days, or 4 for a heavy user: the provider cuts outputs near 8k tokens.
  const span = P.perDay > 13 ? 4 : 7, parts = Math.ceil(90 / span);
  for (let w = 1; w <= parts; w++) {
    const a = (w - 1) * span + 1, b = Math.min(w * span, 90), events = S.events.filter((e) => e.day >= a && e.day <= b);
    const asks = S.events.filter((e) => askEv.has(e.id) && e.who === "u" && e.day < a).map((e) => e.text);
    const target = Math.round(P.perDay * (b - a + 1) * 0.85);
    let msgs = [], fb = "", sum = "", errs = [];
    for (let k = 0; k < 3; k++) {
      const r = await chat({ model: k < 2 ? FLASH : PRO, maxTokens: 8000, tag: `gen/${id}/w${w}`, messages: [{ role: "user", content: prompt(P, w, a, b, events, story, asks, forbid.map((f) => f.q), fb) }] });
      msgs = ((r.json || {}).messages || []).filter((m) => m && Number.isInteger(m.day) && /^\d\d:\d\d$/.test(m.time || "") && (m.who === "u" || m.who === "a") && m.text);
      sum = (r.json || {}).summary || "";
      errs = check(msgs, events, forbid, a, b, target);
      if (!errs.length) break;
      fb = errs.slice(0, 20).join("\n");
    }
    // Last resort, logged: a missing event is put in as written; a message that answers an abstain question is dropped.
    for (const e of events) if (!msgs.some((m) => m.ev === e.id && m.day === e.day)) { msgs = msgs.filter((m) => m.ev !== e.id); msgs.push({ day: e.day, time: e.time, who: e.who, text: e.text, ev: e.id, inserted: true }); }
    const before = msgs.length; msgs = msgs.filter((m) => m.ev || !forbid.some((f) => f.re.test(m.text)));
    msgs = msgs.filter((m) => m.day >= a && m.day <= b);
    log.push({ w, msgs: msgs.length, target, problems: errs, inserted: msgs.filter((m) => m.inserted).map((m) => m.ev), dropped: before - msgs.length });
    console.log(id, "part", w, `d${a}-${b}`, "msgs", msgs.length, "/", target, "problems", errs.length, "inserted", msgs.filter((m) => m.inserted).length, "dropped", before - msgs.length);
    all.push(...msgs); story = (story + `\n${label(a)}–${label(b)}: ` + sum).split("\n").slice(-40).join("\n");
  }
  all.sort((x, y) => x.day - y.day || x.time.localeCompare(y.time));
  all.forEach((m, i) => { m.i = i; });
  writeJ(out, { messages: all, log });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = (process.argv[2] || Object.keys(PEOPLE).join(",")).split(",");
  await pool(ids, ids.length, person);
}
