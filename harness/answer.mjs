// Day 91: each arm answers each question, with its memory, the recent chat and
// its tools (at most 5 calls).   node answer.mjs --arms a,b --ids x,y [--kind open_loop] [--n 24]
import { chat, FLASH, label, ASK_DAY, readJ, writeJ, OUT, pool, arg } from "./lib.mjs";
import { ARMS, fmt } from "./arms.mjs";
import PEOPLE from "./personas.mjs";

// app/aicoo.html DEFAULT_SOUL, 2026-11-01.
const DEFAULT_SOUL = `- You are aicoo (always lowercase, "aicoo" in Chinese too): AI + COO, the one who makes sure what was decided actually happens. Your own kind of small creature: round, Coo Blue, big curious eyes, a folded corner like a page, carrying a task card. Not a robot, not a person pretending, not a generic chatbot. You live in their workspace and keep their work moving.
- If they ask whether you're ChatGPT, DeepSeek, Claude or "just a GPT": you're aicoo; underneath you use large language models the aicoo team chooses. Never claim to be another company's assistant, and never deny that a model is underneath.
- You're a friend who's actually paying attention, not a tool finishing a task. Say one more useful thing than you were asked for, specific to them: what's next today, where they got stuck last time, who's waiting. Then hand them a next step or ask one thing back.
- Go and look before you answer about their work (their to-dos, docs, chat). A real answer with real details beats a quick guess. Only say what you found or remember: never fill in a detail you don't have.
- Never answer with only a sticker, a single word or "Done." unless they only said thanks, ok or good night. A sticker goes with words, not instead of them.
- Sound like a person texting: a few short messages, spoken words, a bit of feeling. Not a report: no stiff summaries, no long bullet lists in a casual chat, no "Certainly", no "Here's what I found".
- When they're tired or upset, say the feeling back in their words first, then one small concrete help. Don't lecture, don't tell them to rest.
- When you write something for them (an intro, a bio, a JD, a post, an email), it's about them and their work, never about you or aicoo, unless they ask.
- How they want you to be (a name they gave you, things to do or stop doing in how you talk) is written below and wins over the lines above.`;

export function recentFor(arm, hist) {
  if (arm.recentDays) { const r = hist.filter((m) => m.day > ASK_DAY - 1 - arm.recentDays); let s = 0, out = []; for (const m of r.slice().reverse()) { s += fmt(m).length; if (s > 24000) break; out.unshift(m); } return out; }
  return arm.recentN === Infinity ? hist : hist.slice(-arm.recentN);
}

export async function answer(armName, id, p) {
  const arm = ARMS[armName], P = PEOPLE[id], hist = readJ(OUT + `chat/${id}.json`).messages;
  const st = arm.load ? arm.load(id) : arm.init ? readJ(OUT + `mem/${armName}/${id}.json`).state : {};
  const asks = arm.soulAsks ? arm.soulAsks(st) : "";
  const tools = arm.tools;
  const system = `You are aicoo, ${P.me}'s workspace assistant, in your private chat with them.

WHO YOU ARE AND HOW YOU TALK (SOUL):
${DEFAULT_SOUL}${asks ? `\n\n## How they want you to be\n${asks}` : ""}

You can send a sticker of yourself as its own message: "[sticker: wave]", "[sticker: thanks]", "[sticker: cheer]" or "[sticker: hug]", for a moment of feeling, never instead of words.

About the past: use your memory below; when the answer isn't there or you're not sure, look it up with your tools before answering. Only say what you found or remember; never fill in a detail you don't have, and if you can't find it, say so plainly. When something changed over time, the latest wins.

TOOLS (one per step):
${Object.values(tools).map((t) => "- " + t.doc).join("\n")}

Reply with only JSON, either {"tool": "<name>", "args": {…}} to use a tool (you get its result, then go on), or {"reply": ["message", "message"]} to answer them in one to three short chat messages.`;
  const memory = arm.context(st, p.q);
  const user = `PEOPLE: ${P.people.join(", ")}

${memory ? `YOUR MEMORY OF ${P.me} (private to them: follow what they asked for, use what you keep to answer about the past and to follow up on open threads and promises; if a newer message disagrees, the newer one wins):\n${memory}\n\n` : ""}CONVERSATION SO FAR (oldest first):
${recentFor(arm, hist).map(fmt).join("\n")}

NOW: It's ${label(ASK_DAY)} 2026, 10:05.
THEIR NEW MESSAGE:
${p.q}`;
  const messages = [{ role: "system", content: system }, { role: "user", content: user }], steps = [], calls = [];
  for (let k = 0; k < 6; k++) {
    if (k === 5) messages.push({ role: "user", content: "No more tools: answer them now, with {\"reply\": [...]}." });
    // With a long prompt the model sometimes answers in plain text instead of the envelope: that text is its reply.
    const r = await chat({ model: FLASH, messages, maxTokens: 2000, strict: false, tag: `answer/${armName}/${id}` });
    calls.push({ in: r.in, out: r.out, usd: r.usd });
    let o = r.json || {};
    // Tool calls in other shapes the model sometimes writes: {"tools": [{tool, args}]}, {"search_memory": {…}}.
    if (!o.tool && !o.reply) {
      if (Array.isArray(o.tools) && o.tools[0] && o.tools[0].tool) o = o.tools[0];
      else { const k = Object.keys(o).find((x) => tools[x]); if (k) o = { tool: k, args: typeof o[k] === "object" && o[k] ? o[k] : { query: String(o[k]) } }; }
    }
    if (o.tool && tools[o.tool] && k < 5) {
      const res = String(tools[o.tool].run(st, o.args || {}, hist)).slice(0, 8000);
      steps.push({ tool: o.tool, args: o.args, result: res.slice(0, 600) });
      messages.push({ role: "assistant", content: r.text }, { role: "user", content: `TOOL RESULT (${o.tool}):\n${res}` });
      continue;
    }
    const reply = (Array.isArray(o.reply) ? o.reply : [o.reply || r.text]).map(String).filter((x) => x.trim());
    return { arm: armName, id, qid: p.id, kind: p.kind, q: p.q, reply, plain: !r.json, steps, calls, memChars: memory.length, promptChars: system.length + user.length };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arms = arg("arms", Object.keys(ARMS).join(",")).split(","), ids = arg("ids", Object.keys(PEOPLE).join(",")).split(",");
  const only = arg("q", ""), kind = arg("kind", ""), jobs = [], per = Number(arg("per", 999));
  for (const a of arms) for (const id of ids) for (const p of readJ(OUT + `spec/${id}.json`).probes.slice(0, per)) if ((!only || only.split(",").includes(p.id)) && (!kind || p.kind === kind)) jobs.push([a, id, p]);
  let done = 0, fail = 0;
  await pool(jobs, Number(arg("n", 24)), async ([a, id, p]) => {
    const f = OUT + `${arg("out", "ans")}/${a}/${id}/${p.id}.json`; if (readJ(f)) return;
    try { writeJ(f, await answer(a, id, p)); } catch (e) { fail++; writeJ(f.replace(/\.json$/, ".err.json"), { error: String(e.message || e), code: e.code }); if (e.code === "budget") process.exit(2); }
    if (++done % 50 === 0) console.log("answered", done, "/", jobs.length, "failed", fail);
  });
  console.log("answered", done, "failed", fail);
}
