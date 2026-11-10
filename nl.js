// Natural-language date and time at the END of a task: "call Sam tomorrow 3pm" -> text "call Sam", date, tm.
// Pure, no DOM. shortcut: English only, only phrases at the end of the text; upgrade to chrono-node for more.
import { addDays, addInterval, nextMonday, today } from "./logic.js";

const WEEKDAY = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat";
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const DAYS = "sun mon tue wed thu fri sat".split(" ");
const pad = (n) => String(n).padStart(2, "0");
const hm = (h, m) => (h < 24 && m < 60 ? `${pad(h)}:${pad(m)}` : null);
const dow = (s) => new Date(s + "T00:00").getDay();

// [pattern, (match, ctx) => fields | null]. Each pattern is matched against the end of the text.
const RULES = [
  [/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/, (m) => (m[1] >= 1 && m[1] <= 12 ? { tm: hm((m[1] % 12) + (m[3].toLowerCase() === "p" ? 12 : 0), +(m[2] ?? 0)) } : null)],
  [/(\d{1,2}):(\d{2})/, (m) => ({ tm: hm(+m[1], +m[2]) })],
  [/noon/, () => ({ tm: "12:00" })],
  [/in\s+(\d+)\s*(min(?:ute)?s?|h(?:ou)?rs?|h)/, (m, c) => { // "in 2 hours": a date and a time from now
    const d = new Date(c.now.getTime() + m[1] * (m[2][0] === "m" ? 6e4 : 36e5));
    return { date: today(d), tm: hm(d.getHours(), d.getMinutes()) };
  }],
  [/tonight|this evening/, (m, c) => ({ date: c.td, ev: true })],
  [/today/, (m, c) => ({ date: c.td })],
  [/tomorrow|tmrw|tmr/, (m, c) => ({ date: addDays(c.td, 1) })],
  [/next week/, (m, c) => ({ date: nextMonday(c.td) })],
  [/in\s+(\d+)\s*(day|week|month|year)s?/, (m, c) => ({ date: addInterval(c.td, +m[1], m[2]) })],
  [/(\d{4})-(\d{2})-(\d{2})/, (m) => ({ date: m[0] })],
  [new RegExp(`(?:next\\s+|this\\s+)?(${WEEKDAY})`), (m, c) => { // the next such weekday, never today
    const want = DAYS.indexOf(m[1].slice(0, 3).toLowerCase());
    for (let k = 1; k <= 7; k++) if (dow(addDays(c.td, k)) === want) return { date: addDays(c.td, k) };
  }],
  [new RegExp(`(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})|(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?)`), (m, c) => { // 12 nov, nov 12th
    const day = +(m[1] ?? m[4]), mon = MONTHS.indexOf((m[2] ?? m[3]).slice(0, 3).toLowerCase()), y = +c.td.slice(0, 4);
    let d = `${y}-${pad(mon + 1)}-${pad(day)}`;
    if (day < 1 || addDays(d, 0) !== d) return null; // 31 feb and the like
    if (d < c.td) d = `${y + 1}-${pad(mon + 1)}-${pad(day)}`; // already past this year: next year
    return addDays(d, 0) === d ? { date: d } : null;
  }],
].map(([re, fn]) => [new RegExp(`(?:^|\\s)(?:(?:on|at|by|for|due)\\s+)?${re.source}\\s*$`, "i"), fn]);

export function parseWhen(input, now = new Date()) {
  const ctx = { now, td: today(now) }, out = {};
  let text = input.trim();
  for (let again = true; again;) {
    again = false;
    for (const [re, fn] of RULES) {
      const m = text.match(re), r = m && fn(m, ctx);
      if (!r || r.tm === null || Object.keys(r).some((k) => k !== "ev" && k in out)) continue; // one date and one time at most
      Object.assign(out, r);
      text = text.slice(0, m.index).trim();
      again = true;
      break;
    }
  }
  text = text.replace(/[\s,;:-]+$/, "");
  if (!text || !(out.date || out.tm)) return { text: input.trim() }; // nothing found, or nothing left of the task
  if (out.tm && !out.date) out.date = out.tm > `${pad(now.getHours())}:${pad(now.getMinutes())}` ? ctx.td : addDays(ctx.td, 1); // a time already past means tomorrow
  return { text, ...out };
}
