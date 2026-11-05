// The seven memory designs. Each has a writer, run in time order over the 90
// days, and what aicoo gets when it answers: a memory block, the recent chat
// and tools. Every arm keeps search_chat (production has it).
import { chat, FLASH, BM25, label, ASK_DAY, readJ, OUT } from "./lib.mjs";

export const fmt = (m) => `#${m.i} ${label(m.day)} ${m.time} ${m.who === "u" ? "Them" : "aicoo"}: ${m.text}`;
const mins = (m) => m.day * 1440 + Number(m.time.slice(0, 2)) * 60 + Number(m.time.slice(3));
const md = (v) => typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map((x) => "- " + (typeof x === "string" ? x : JSON.stringify(x))).join("\n") : v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `## ${k}\n${md(x)}`).join("\n") : "";

// Production's trigger: 8 new turns (4 of them theirs), at least 3 hours since the last write.
function batched(write) {
  return async (st, msgs, ctx) => {
    for (const m of msgs) {
      st.pending.push(m);
      const due = st.pending.length >= 8 && st.pending.filter((x) => x.who === "u").length >= 4 && mins(m) - (st.lastAt ?? -1e9) >= 180;
      if (due) { await write(st, st.pending, { ...ctx, day: m.day }); st.pending = []; st.lastAt = mins(m); st.writes = (st.writes || 0) + 1; }
    }
  };
}

// search_chat as in production: every word must appear; each match with its neighbours.
export function searchChat(hist, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return "(give some words)";
  const hits = hist.filter((m) => words.every((w) => m.text.toLowerCase().includes(w))).slice(-8).reverse();
  if (!hits.length) return "(no messages contain all of those words; try other wording or the other language)";
  return hits.map((m) => [hist[m.i - 1], m, hist[m.i + 1]].filter(Boolean).map(fmt).join("\n")).join("\n---\n");
}

const SEARCH_CHAT = { search_chat: { doc: 'search_chat {"query": "words"} → earlier messages in your chat with them that contain ALL the words, each with the messages around it. Try a couple of wordings (and the other language) if the first finds nothing.', run: (st, a, h) => searchChat(h, a.query) } };

// ---------------------------------------------------------------- none / full
const none = { label: "No memory", recentN: 14, context: () => "", tools: SEARCH_CHAT };
const full = { label: "Full history", recentN: Infinity, context: () => "", tools: SEARCH_CHAT };

// ---------------------------------------------------------------- rewrite (production, 2026-11-01)
const NOTES_MAX = 6000;
const rewrite = {
  label: "Rewrite (production)", recentN: 14,
  init: () => ({ pending: [], asks: "", about: "", notes: "" }),
  day: batched(async (st, batch, { me, tag }) => {
    const ASKS_WHAT = "a name they gave aicoo, what aicoo should call them, how they want it to talk (warmer, cuter, more formal, no stickers, no bullets…), a role they gave it";
    const r = await chat({ tag, messages: [{ role: "user", content: `You keep private notes for aicoo (${me}'s workspace assistant); it reads them before every reply to ${me}. Update them from the new messages below. Only what the messages and data say; never invent.
Reply with only JSON: {"asks": "...", "about": "...", "notes": "..."}
- asks: how they want aicoo to be with them: ${ASKS_WHAT}. One short line each, only what they asked for themselves. aicoo's own character is fixed elsewhere: never write who aicoo is or how it talks in general. Start from the current asks: add or change a line when they ask, drop one they take back. Usually nothing changes: return them as they are, or "" when there are none.
- about: who they are, at most 6 short lines: role and team, who's who around them, what they're working on now, how they talk (language, length, tone), when they work. Stable things only; leave out what the data doesn't show.
- notes: markdown with three headings:
  "## Asked for": their standing requests about their work (how to format things, what to remind them of, how to handle their to-dos), one per line, kept until they change them. How aicoo should talk or what to call each other goes in asks instead.
  "## Keep": facts worth knowing weeks later: numbers, money, dates and deadlines, names and who does what, decisions, promises aicoo made. One line each with the date it was said, like "Oct 7: …". Keep each until it's done or replaced; merge duplicates; never drop one just because it's old.
  "## Recent": the last ~10 days, newest first, one short dated line each: what's going on, how they feel. Small talk only if it matters to them. When a line is older than 10 days, move anything lasting into Keep and drop the rest.
  When they said "tomorrow" or "Friday", write the date only if it's certain; otherwise keep their words. Keep notes under about 5,000 characters.
- Write in the language they use most.
Today is ${label(batch.at(-1).day)} 2026.

CURRENT ASKS:
${st.asks || "(none)"}

CURRENT ABOUT:
${st.about || "(nothing yet)"}

CURRENT NOTES:
${st.notes || "(nothing yet)"}

NEW MESSAGES IN THEIR CHAT WITH AICOO:
${batch.slice(-80).map(fmt).join("\n")}` }] });
    const o = r.json || {};
    const about = md(o.about).slice(0, 900); let notes = md(o.notes);
    if (!about && !notes) return;
    if (notes.length > NOTES_MAX - 200) {
      const c = await chat({ tag, messages: [{ role: "user", content: `This private note about ${me} is ${notes.length} characters; it must be under ${NOTES_MAX - 1000}. Compact it: merge lines about the same thing, drop what's done, trivial or no longer true. Never drop a number, date, name, standing request or promise that may still matter. Keep its three headings.\n\n${notes}\n\nReply with only JSON: {"notes": "..."}` }] });
      const t = md((c.json || {}).notes); if (t) notes = t; st.compactions = (st.compactions || 0) + 1;
    }
    if (o.asks !== undefined) st.asks = md(o.asks);
    st.about = about; st.notes = notes.slice(0, NOTES_MAX);
  }),
  soulAsks: (st) => st.asks,
  context: (st) => `## About them\n${st.about || "(nothing yet)"}\n## Saved preferences\n(nothing yet)\n${st.notes || "## Keep\n(nothing yet)"}`,
  tools: SEARCH_CHAT,
};

// ---------------------------------------------------------------- tiered: raw recent days + summaries that coarsen with age
const tiered = {
  label: "Tiered: raw recent + compressed past", recentDays: 7,
  init: () => ({ days: {}, weeks: {}, months: {} }),
  day: async (st, msgs, { me, tag, day }) => {
    if (msgs.length) {
      const r = await chat({ tag, messages: [{ role: "user", content: `Summarize one day of ${me}'s private chat with aicoo for aicoo's long-term memory. 2–8 lines, each "${label(day)}: …". Keep every specific: numbers, money, dates and deadlines, names, decisions, changes to earlier plans, promises (who owes what), and anything they asked aicoo to do or how to treat them. Drop small talk. Write in the language they use most.\n\n${msgs.map(fmt).join("\n")}\n\nReply with only JSON: {"digest": "..."}` }] });
      st.days[day] = md((r.json || {}).digest);
    }
    if (day % 7 === 0) {
      // A week leaves the daily tier two weeks after it ends.
      for (let w = 0; (w + 1) * 7 <= day - 14; w++) if (!st.weeks[w]) {
        const lines = Object.entries(st.days).filter(([d]) => Math.floor((d - 1) / 7) === w).map(([, t]) => t).join("\n");
        if (!lines) { st.weeks[w] = "(quiet week)"; continue; }
        const r = await chat({ tag, messages: [{ role: "user", content: `Compress one week of daily notes (${label(w * 7 + 1)} – ${label(w * 7 + 7)}) about ${me} into at most 10 dated lines for aicoo's long-term memory. Keep numbers, dates, names, decisions, changes, promises and their requests to aicoo; drop the rest.\n\n${lines}\n\nReply with only JSON: {"summary": "..."}` }] });
        st.weeks[w] = md((r.json || {}).summary);
        for (const d of Object.keys(st.days)) if (Math.floor((d - 1) / 7) === w) delete st.days[d];
      }
      // Weeks older than six weeks fold into their month.
      for (const [w, t] of Object.entries(st.weeks)) if ((Number(w) + 1) * 7 <= day - 42) {
        const mon = label(Number(w) * 7 + 1).slice(7); (st.fold ||= {})[mon] = [...(st.fold[mon] || []), t]; delete st.weeks[w];
        const r = await chat({ tag, messages: [{ role: "user", content: `Merge these notes about ${me} (${mon}) into one month summary of at most 14 dated lines for aicoo's long-term memory. Keep numbers, dates, names, decisions, the latest value of anything that changed (and that it changed), open promises and their requests to aicoo.\n\nCURRENT MONTH SUMMARY:\n${st.months[mon] || "(none)"}\n\nNEW WEEK:\n${t}\n\nReply with only JSON: {"summary": "..."}` }] });
        st.months[mon] = md((r.json || {}).summary);
      }
    }
  },
  context: (st) => `## Months\n${Object.entries(st.months).map(([k, v]) => `### ${k}\n${v}`).join("\n") || "(none)"}\n## Weeks\n${Object.entries(st.weeks).map(([w, v]) => `### Week of ${label(Number(w) * 7 + 1)}\n${v}`).join("\n") || "(none)"}\n## Days\n${Object.values(st.days).join("\n") || "(none)"}`,
  tools: SEARCH_CHAT,
};

// ---------------------------------------------------------------- notes: an index that's always loaded + many topic notes
const notes = {
  label: "Index + topic notes + search", recentN: 14,
  init: () => ({ pending: [], notes: { "about-me": { title: "About them", hook: "who they are and how they want aicoo to treat them", lines: [], updated: 0 } } }),
  day: batched(async (st, batch, { me, tag, day }) => {
    const text = batch.map((m) => m.text).join(" "), all = Object.entries(st.notes);
    const idx = new BM25(all, ([s, n]) => `${s} ${n.title} ${n.hook} ${n.lines.join(" ")}`);
    const open = new Set(["about-me", ...idx.search(text, 5).map((h) => h.doc[0]), ...all.sort((a, b) => b[1].updated - a[1].updated).slice(0, 2).map(([s]) => s)]);
    const r = await chat({ tag, messages: [{ role: "user", content: `You keep aicoo's notes about ${me}: one note per topic (a project, a person, a recurring thing, an area of preferences), plus "about-me" (who they are, and how they want aicoo to treat them: a name, tone, language). aicoo always sees the index (slug, title, hook) and "about-me"; it opens other notes when a question needs them, so a hook must name what's inside (people, numbers, the latest state).
Update the notes from the new messages. Lines are dated like "${label(day).slice(4)}: …" and keep exact numbers, names and dates. When something changes, replace its line with the new value and say what it was ("moved to Nov 10 (was Nov 3)"). Record promises and whether they were kept. Skip small talk. Write in the language they use most. Never invent.
Ops: {"op":"append","slug","lines":[…]}, {"op":"create","slug","title","hook","lines":[…]}, {"op":"replace_line","slug","old":"exact old line","new":"…"}, {"op":"delete_line","slug","old":"exact old line"}, {"op":"set_hook","slug","hook":"…"}.

INDEX:
${all.map(([s, n]) => `- ${s} · ${n.title} — ${n.hook}`).join("\n")}

OPEN NOTES:
${[...open].filter((s) => st.notes[s]).map((s) => `### ${s}\n${st.notes[s].lines.join("\n") || "(empty)"}`).join("\n\n")}

NEW MESSAGES:
${batch.map(fmt).join("\n")}

Reply with only JSON: {"ops": [...]}` }] });
    for (const o of ((r.json || {}).ops || [])) {
      const s = String(o.slug || "").trim().toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, "-").slice(0, 40); if (!s) continue;
      const n = st.notes[s] || (o.op === "create" || o.op === "append" ? (st.notes[s] = { title: o.title || s, hook: o.hook || "", lines: [], updated: day }) : null); if (!n) continue;
      if (o.op === "create" || o.op === "append") n.lines.push(...(o.lines || []).map(String));
      if (o.op === "replace_line") { const k = n.lines.indexOf(o.old); if (k >= 0) n.lines[k] = String(o.new); else n.lines.push(String(o.new)); }
      if (o.op === "delete_line") n.lines = n.lines.filter((l) => l !== o.old);
      if (o.op === "set_hook" || (o.op === "create" && o.hook)) n.hook = String(o.hook);
      if (o.title && o.op === "create") n.title = o.title;
      n.updated = day;
    }
  }),
  context: (st) => `## About them (about-me)\n${st.notes["about-me"].lines.join("\n") || "(nothing yet)"}\n## Your notes (open one with read_note)\n${Object.entries(st.notes).filter(([s]) => s !== "about-me").map(([s, n]) => `- ${s} · ${n.title} — ${n.hook} (updated ${label(n.updated).slice(4)})`).join("\n") || "(none)"}`,
  tools: {
    ...SEARCH_CHAT,
    read_note: { doc: 'read_note {"slug": "…"} → the whole note.', run: (st, a) => { const n = st.notes[String(a.slug || "").trim()]; return n ? `${n.title}\n${n.lines.join("\n")}` : "(no note with that slug)"; } },
    search_notes: { doc: 'search_notes {"query": "words"} → the closest lines across all your notes, with their note.', run: (st, a) => { const L = Object.entries(st.notes).flatMap(([s, n]) => n.lines.map((l) => ({ s, l }))); const h = new BM25(L, (x) => x.l).search(a.query, 10); return h.map((x) => `[${x.doc.s}] ${x.doc.l}`).join("\n") || "(nothing)"; } },
  },
};

// ---------------------------------------------------------------- facts: Mem0-style atomic facts, ADD/UPDATE/DELETE, retrieved per question
const facts = {
  label: "Fact store (Mem0-style)", recentN: 14,
  init: () => ({ pending: [], facts: [], next: 1 }),
  day: batched(async (st, batch, { me, tag, day }) => {
    const r1 = await chat({ tag, messages: [{ role: "user", content: `Extract the facts worth remembering about ${me} from these messages with aicoo: atomic, standalone sentences (who, what, numbers, dates), each with the date it was said, like "${label(day).slice(4)}: …". Include decisions, plans, changes, promises, preferences and how they want aicoo to treat them. Skip small talk. Language: theirs.\n\n${batch.map(fmt).join("\n")}\n\nReply with only JSON: {"candidates": ["…"]}` }] });
    const cands = ((r1.json || {}).candidates || []).map(String).filter(Boolean).slice(0, 30); if (!cands.length) return;
    const live = st.facts.filter((f) => f.active), idx = new BM25(live, (f) => f.text);
    const near = new Map(); for (const c of cands) for (const h of idx.search(c, 5)) near.set(h.doc.id, h.doc);
    const r2 = await chat({ tag, messages: [{ role: "user", content: `You manage a memory of facts about ${me}. For each new fact decide: ADD (new), UPDATE (an existing fact changed or gets more detail: give its id and the full new text), DELETE (an existing fact is no longer true: give its id) or NONE (already known).\n\nEXISTING FACTS THAT MAY BE RELATED:\n${[...near.values()].map((f) => `[${f.id}] ${f.text}`).join("\n") || "(none)"}\n\nNEW FACTS:\n${cands.map((c) => "- " + c).join("\n")}\n\nReply with only JSON: {"decisions": [{"op": "ADD" | "UPDATE" | "DELETE" | "NONE", "id"?: n, "text"?: "…"}]}` }] });
    for (const d of ((r2.json || {}).decisions || [])) {
      const f = st.facts.find((x) => x.id === Number(d.id));
      if (d.op === "ADD" && d.text) st.facts.push({ id: st.next++, text: String(d.text), day, active: true });
      else if (d.op === "UPDATE" && f && d.text) { f.text = String(d.text); f.day = day; }
      else if (d.op === "DELETE" && f) f.active = false;
    }
  }),
  context: (st, q) => { const live = st.facts.filter((f) => f.active); const h = new BM25(live, (f) => f.text).search(q, 12); return `## Memories related to their message\n${h.map((x) => "- " + x.doc.text).join("\n") || "(none found)"}`; },
  tools: {
    ...SEARCH_CHAT,
    search_memory: { doc: 'search_memory {"query": "words"} → the closest facts you remember about them.', run: (st, a) => new BM25(st.facts.filter((f) => f.active), (f) => f.text).search(a.query, 10).map((x) => "- " + x.doc.text).join("\n") || "(nothing)" },
  },
};

// ---------------------------------------------------------------- ledger (ours): append-only typed entries with sources; views are computed
const TYPES = "fact | decision | plan | ask | pref | promise | done | person | feeling";
const ledger = {
  label: "Ledger + views (ours)", recentN: 14,
  init: () => ({ pending: [], log: [], next: 1, about: "" }),
  day: async (st, msgs, ctx) => {
    await ledgerWrite(st, msgs, ctx);
    if (ctx.day % 7 === 0 && st.log.length) {
      const people = st.log.filter((e) => ["person", "fact", "decision"].includes(e.type) && !replaced(st, e)).slice(-60);
      const r = await chat({ tag: ctx.tag, messages: [{ role: "user", content: `From these memory entries about ${ctx.me}, write "about them" in at most 6 short lines: role and team, who's who around them, what they're working on now, how they talk. Stable things only; never invent.\n\nCURRENT:\n${st.about || "(none)"}\n\nENTRIES:\n${people.map(line).join("\n")}\n\nReply with only JSON: {"about": "..."}` }] });
      st.about = md((r.json || {}).about) || st.about;
    }
  },
  context: (st) => {
    const live = (t) => st.log.filter((e) => e.type === t && !replaced(st, e));
    const closed = new Set(st.log.filter((e) => e.type === "done" && e.closes).map((e) => Number(e.closes)));
    const open = live("promise").filter((e) => !closed.has(e.id));
    const recent = st.log.filter((e) => e.day > ASK_DAY - 11 && !["ask", "pref"].includes(e.type));
    return `## About them\n${st.about || "(nothing yet)"}\n## How they want you to be\n${live("ask").map(line).join("\n") || "(nothing asked)"}\n## How they want work done\n${live("pref").map(line).join("\n") || "(nothing yet)"}\n## Open loops (promises not marked done)\n${open.map(line).join("\n") || "(none)"}\n## Last 10 days\n${recent.map(line).join("\n") || "(nothing)"}\n(${st.log.length} entries in all since ${label(1).slice(4)}; older ones: search_memory)`;
  },
  tools: {
    ...SEARCH_CHAT,
    search_memory: { doc: 'search_memory {"query": "words"} → the closest memory entries, newest version first; replaced ones say what replaced them. Each has the message numbers it came from.', run: (st, a) => new BM25(st.log, (e) => e.text).search(a.query, 10).map((x) => { const e = x.doc, by = replaced(st, e); return line(e) + (by ? `  → replaced ${label(by.day).slice(4)} by [${by.id}] ${by.text}` : "") + `  (from #${(e.src || []).join(", #")})`; }).join("\n") || "(nothing)" },
    open_source: { doc: 'open_source {"ids": [message numbers]} → those messages as they were said, with their neighbours, to check a detail.', run: (st, a, h) => (a.ids || []).slice(0, 6).map((i) => [h[i - 1], h[i], h[i + 1]].filter(Boolean).map(fmt).join("\n")).join("\n---\n") || "(none)" },
  },
};
const line = (e) => `[${e.id}] ${label(e.day).slice(4)} · ${e.type}: ${e.text}`;
const replaced = (st, e) => st.log.find((x) => Number(x.supersedes) === e.id);
const ledgerWrite = batched(async (st, batch, { me, tag, day }) => {
  const live = (t) => st.log.filter((e) => e.type === t && !replaced(st, e));
  const closed = new Set(st.log.filter((e) => e.type === "done" && e.closes).map((e) => Number(e.closes)));
  const related = new BM25(st.log, (e) => e.text).search(batch.map((m) => m.text).join(" "), 15).map((h) => h.doc);
  const shown = [...new Map([...live("ask"), ...live("pref"), ...live("promise").filter((e) => !closed.has(e.id)), ...related, ...st.log.slice(-25)].map((e) => [e.id, e])).values()].sort((a, b) => a.id - b.id);
  const r = await chat({ tag, messages: [{ role: "user", content: `You keep aicoo's memory of ${me} as an append-only ledger: entries are never edited, only added. From the new messages, add entries for what's worth knowing later. One line each, with exact numbers, names and dates.
Types: ${TYPES}. fact = something true about their world; decision; plan = something scheduled (say the date); ask = how they want aicoo to treat them (a name, tone, language); pref = how they want a kind of work done; promise = someone committed to something (who, what, by when; includes aicoo agreeing to remind them); done = a promise was kept (set "closes" to its id); person = who someone is; feeling = how they are, only if it matters.
When an entry changes an earlier one (a new date, a new amount, a reversed decision, a withdrawn ask), add the new entry with "supersedes" set to the old id. "src" = the message numbers it comes from. Skip small talk. Write in the language they use. Never invent.

ENTRIES YOU MAY NEED (open asks, prefs and promises; related and latest):
${shown.map(line).join("\n") || "(none yet)"}

NEW MESSAGES:
${batch.map(fmt).join("\n")}

Reply with only JSON: {"add": [{"type": "…", "text": "…", "src": [n], "supersedes"?: id, "closes"?: id}]}` }] });
  for (const a of ((r.json || {}).add || [])) {
    if (!a || !a.text || !TYPES.includes(String(a.type))) continue;
    st.log.push({ id: st.next++, day, type: String(a.type), text: String(a.text), src: (a.src || []).map(Number).filter(Number.isFinite), ...(a.supersedes ? { supersedes: Number(a.supersedes) } : {}), ...(a.closes ? { closes: Number(a.closes) } : {}) });
  }
});

// Two combinations from the first results, built from states already written
// (no new writer): what auto-recall at question time adds to each.
const notesHits = (st, q) => { const L = Object.entries(st.notes).flatMap(([s, n]) => n.lines.map((l) => ({ s, l }))); return new BM25(L, (x) => x.l).search(q, 10).map((x) => `- [${x.doc.s}] ${x.doc.l}`).join("\n"); };
const notes_recall = {
  ...notes, label: "Index + notes + auto-recall",
  load: (id) => readJ(OUT + `mem/notes/${id}.json`).state,
  context: (st, q) => `${notes.context(st)}\n## Lines from your notes that may matter for this message\n${notesHits(st, q) || "(none)"}`,
};
const rewrite_facts = {
  ...rewrite, label: "Rewrite + fact recall",
  load: (id) => ({ ...readJ(OUT + `mem/rewrite/${id}.json`).state, facts: readJ(OUT + `mem/facts/${id}.json`).state.facts }),
  context: (st, q) => `${rewrite.context(st)}\n${facts.context(st, q)}`,
  tools: { ...rewrite.tools, search_memory: facts.tools.search_memory },
};

export const ARMS = { none, full, rewrite, tiered, notes, facts, ledger, notes_recall, rewrite_facts };
