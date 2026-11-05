// Runs each arm's writer over each person's 90 days in time order. Saves the
// state every 10 days, so a crashed run resumes.   node build.mjs --arms a,b --ids x,y
import { readJ, writeJ, OUT, pool, arg } from "./lib.mjs";
import { ARMS } from "./arms.mjs";
import PEOPLE from "./personas.mjs";

const arms = arg("arms", Object.keys(ARMS).filter((a) => ARMS[a].init && !ARMS[a].load).join(",")).split(",");
const ids = arg("ids", Object.keys(PEOPLE).join(",")).split(",");
const jobs = arms.flatMap((a) => ids.map((id) => [a, id]));
await pool(jobs, jobs.length, async ([a, id]) => {
  const f = OUT + `mem/${a}/${id}.json`, saved = readJ(f);
  if (saved && saved.done) return console.log(a, id, "done already");
  const arm = ARMS[a], hist = readJ(OUT + `chat/${id}.json`).messages;
  let st = saved ? saved.state : arm.init(), from = saved ? saved.lastDay + 1 : 1;
  const t0 = Date.now();
  for (let d = from; d <= 90; d++) {
    try { await arm.day(st, hist.filter((m) => m.day === d), { me: PEOPLE[id].me, tag: `build/${a}/${id}`, day: d }); }
    // The last 10-day checkpoint stays: this day's half-applied state isn't saved.
    catch (e) { console.log(a, id, "stopped on day", d, e.message); if (e.code === "budget") process.exit(2); return; }
    if (d % 10 === 0) writeJ(f, { state: st, lastDay: d });
  }
  writeJ(f, { state: st, lastDay: 90, done: true, minutes: (Date.now() - t0) / 60000 });
  console.log(a, id, "built in", ((Date.now() - t0) / 60000).toFixed(1), "min");
});
