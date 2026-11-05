// Shared pieces: one model call to an OpenAI-compatible endpoint (spend kept in
// a ledger, so a run stops before the budget, not after), JSON reading, a small
// BM25 for mixed Chinese/English, dates, and a concurrency pool.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
export const DIR = new URL("./", import.meta.url).pathname;
// OUT: where every stage reads and writes (default harness/out/). Point it at
// data/run2-azure/ to re-analyze the published run.
export const OUT = process.env.OUT ? process.env.OUT.replace(/\/?$/, "/") : DIR + "out/";
const BASE = process.env.GW || "https://openrouter.ai/api/v1";
const LEDGER = OUT + "spend.jsonl";
const BUDGET = Number(process.env.BUDGET_USD || 18);
// Read on the first call, so re-scoring a published run needs no key.
let KEY = null;
const key = () => KEY ??= process.env.API_KEY || readFileSync(process.env.KEY_FILE || DIR + ".key", "utf8").trim();
// The published runs used DeepSeek-V4-Flash (writing and answering) and
// DeepSeek-V4-Pro (designing, auditing, grading); set your provider's ids.
export const FLASH = process.env.MODEL_FAST || "DeepSeek-V4-Flash", PRO = process.env.MODEL_STRONG || "DeepSeek-V4-Pro";
mkdirSync(OUT, { recursive: true });

export function spent() {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).usd || 0), 0);
}
let total = null;
// Reasoning is off everywhere: Flash's default spends the whole output budget thinking.
// strict = false: a reply that isn't JSON comes back as text (json: null) instead of being retried.
export async function chat({ model = FLASH, messages, json = true, strict = true, maxTokens = 6000, tag = "", timeout = 240000 }) {
  if (process.env.MOCK) return mock(messages, tag);
  if (total == null) total = spent();
  if (total > BUDGET) throw Object.assign(new Error(`budget: $${total.toFixed(2)} spent, cap $${BUDGET}`), { code: "budget" });
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + "/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(timeout),
        headers: { authorization: "Bearer " + key(), "content-type": "application/json" },
        // PROVIDER pins Flash to one upstream: some providers drop JSON mode on long prompts (2026-11-01: Baidu).
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning: { enabled: false }, ...(process.env.PROVIDER && model === FLASH ? { provider: { order: [process.env.PROVIDER], allow_fallbacks: false } } : {}), ...(json ? { response_format: { type: "json_object" } } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      const usd = body.usage && typeof body.usage.cost === "number" ? body.usage.cost : Number(r.headers.get("x-rmg-cost-microusd") || 0) / 1e6;
      const u = body.usage || {};
      appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), tag, model, prov: body.provider || null, status: r.status, usd, in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cached: (u.prompt_tokens_details || {}).cached_tokens || 0, ms: Date.now() - t0, attempt }) + "\n");
      total += usd;
      if (r.status === 429 || r.status >= 500) { last = new Error(`gateway ${r.status}: ${JSON.stringify(body).slice(0, 200)}`); await sleep(3000 * (attempt + 1)); continue; }
      if (r.status !== 200) throw Object.assign(new Error(`gateway ${r.status}: ${JSON.stringify(body).slice(0, 300)}`), { code: "http" });
      const c = body.choices && body.choices[0], text = (c && c.message && c.message.content) || "";
      if (!text.trim()) { last = new Error("empty reply"); continue; }
      if (json && strict && !parseJson(text)) { last = new Error("unparsable JSON: " + text.slice(0, 120)); continue; }
      return { text, json: json ? parseJson(text) : null, in: u.prompt_tokens || 0, out: u.completion_tokens || 0, usd, finish: c.finish_reason };
    } catch (e) {
      if (e.code === "http" || e.code === "budget") throw e;
      last = e; await sleep(3000 * (attempt + 1));
    }
  }
  throw Object.assign(last || new Error("failed"), { code: "infra" });
}
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function parseJson(t) {
  if (!t) return null;
  const s = String(t).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  return null;
}

// Tokens: lowercased Latin words and numbers, plus Chinese character bigrams.
export function toks(t) {
  const s = String(t || "").toLowerCase(), out = [];
  for (const w of s.match(/[a-z0-9$%.]+/g) || []) { const x = w.replace(/^[.]+|[.]+$/g, ""); if (x.length > 1 || /\d/.test(x)) out.push(x); }
  for (const run of s.match(/[一-鿿]+/g) || []) { if (run.length === 1) out.push(run); for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2)); }
  return out;
}
const STOP = new Set("the a an and or to of in on for is it i my me you we our at was be do did with that this what when how about any".split(" "));
export class BM25 {
  constructor(docs, get = (d) => d) {
    this.docs = docs; this.tf = docs.map((d) => { const m = new Map(); for (const t of toks(get(d))) if (!STOP.has(t)) m.set(t, (m.get(t) || 0) + 1); return m; });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)); this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
    this.df = new Map(); for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }
  search(q, k = 10) {
    const qs = [...new Set(toks(q).filter((t) => !STOP.has(t)))], N = this.docs.length, out = [];
    for (let i = 0; i < N; i++) {
      let s = 0; const m = this.tf[i];
      for (const t of qs) { const f = m.get(t); if (!f) continue; const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * this.len[i] / this.avg)); }
      if (s > 0) out.push([s, i]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, k).map(([s, i]) => ({ score: s, doc: this.docs[i], i }));
  }
}

// Day 1 = Aug 3 2026 (a Monday); questions are asked on day 91 = Nov 1.
const D0 = Date.UTC(2026, 7, 3);
export const dateOf = (day) => new Date(D0 + (day - 1) * 86400e3).toISOString().slice(0, 10);
export const label = (day) => { const d = new Date(D0 + (day - 1) * 86400e3); return d.toUTCString().slice(0, 11).replace(",", ""); }; // "Mon 03 Aug"
export const ASK_DAY = 91;

export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
export const readJ = (p, d = null) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d;
export const writeJ = (p, v) => { mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1)); };
export const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };

// Offline plumbing check (MOCK=1): canned answers shaped like each prompt expects.
function mock(messages, tag) {
  const p = messages.map((m) => m.content).join("\n"), j = (v) => ({ text: JSON.stringify(v), json: v, in: Math.round(p.length / 3), out: 50, usd: 0 });
  if (/"verdict"/.test(p)) return j({ verdict: "correct", why: "mock" });
  if (/"reply"/.test(p)) return j(/search_chat/.test(p) && !/TOOL RESULT/.test(p) ? { tool: "search_chat", args: { query: "budget" } } : { reply: ["mock answer"] });
  if (/"ops"/.test(p)) return j({ ops: [{ op: "create", slug: "work", title: "Work", hook: "what they're working on", lines: ["mock line"] }] });
  if (/"add"/.test(p)) return j({ add: [{ type: "fact", text: "mock fact", src: [0] }] });
  if (/"candidates"/.test(p)) return j({ candidates: ["mock fact"] });
  if (/"decisions"/.test(p)) return j({ decisions: [{ op: "ADD", text: "mock fact" }] });
  if (/"digest"/.test(p)) return j({ digest: "- mock digest line" });
  if (/"summary"/.test(p)) return j({ summary: "- mock summary" });
  if (/"about"/.test(p) && /"notes"/.test(p)) return j({ asks: "", about: "mock about", notes: "## Keep\n- mock" });
  if (/"about"/.test(p)) return j({ about: "mock about" });
  return j({});
}
