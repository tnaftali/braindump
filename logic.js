// Pure helpers. No DOM, so `node --test` can run them.
const URL_RE = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g; // trailing punctuation stays out of the link

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function label(u) {
  try {
    const x = new URL(u), m = x.pathname.match(/^\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/);
    if (x.hostname === "github.com" && m) return `${m[1]}#${m[2]}`;
    return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname : "");
  } catch {
    return u;
  }
}

// Split text into [{text}] and [{url, text}] parts. Only http(s) URLs match, so no javascript: links.
export function linkify(text) {
  const out = [];
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > i) out.push({ text: text.slice(i, m.index) });
    out.push({ url: m[0], text: label(m[0]) });
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push({ text: text.slice(i) });
  return out;
}

// Move task `id` next to `targetId`. Returns a new array; the input is untouched.
export function move(list, id, targetId, before) {
  const task = list.find((t) => t.id === id);
  if (!task || id === targetId || !list.some((t) => t.id === targetId)) return list;
  const rest = list.filter((t) => t !== task);
  rest.splice(rest.findIndex((t) => t.id === targetId) + (before ? 0 : 1), 0, task);
  return rest;
}

// ---- Dates and repeats ----
// A date is a local-day string "YYYY-MM-DD": it compares as text, with no time of day and no zones.
// A task may carry `date` and, only with a date, `rep` = { n, unit: day|week|month|year, mode: schedule|after }.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = ["day", "week", "month", "year"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const fmt = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based
const parts = (s) => { const [y, m, d] = s.split("-").map(Number); return [y, m - 1, d]; };
const dow = (s) => { const [y, m, d] = parts(s); return new Date(Date.UTC(y, m, d)).getUTCDay(); };

export const today = (d = new Date()) => fmt(d.getFullYear(), d.getMonth(), d.getDate());

export function addDays(s, n) {
  const [y, m, d] = parts(s), t = new Date(Date.UTC(y, m, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
function addMonths(s, n) {
  const [y, m, d] = parts(s), i = y * 12 + m + n, ny = Math.floor(i / 12), nm = i % 12;
  return fmt(ny, nm, Math.min(d, new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate())); // the 31st clamps to the month's last day
}
export const addInterval = (s, n, unit) => (unit === "day" ? addDays(s, n) : unit === "week" ? addDays(s, 7 * n) : addMonths(s, unit === "year" ? 12 * n : n));
export const nextMonday = (now) => addDays(now, (8 - dow(now)) % 7 || 7);

// The date a repeating task moves to when completed. "schedule" keeps the rhythm and skips every
// missed slot (one next date, never a backlog); "after" counts from today.
// shortcut: a clamped month (31st -> 28th) does not snap back to the 31st, upgrade if that matters.
export function nextDate(date, rep, now) {
  if (rep.mode === "after") return addInterval(now, rep.n, rep.unit);
  for (let k = 1; k < 20000; k++) {
    const d = addInterval(date, k * rep.n, rep.unit);
    if (d > now) return d;
  }
  return addInterval(now, rep.n, rep.unit);
}

// "Today" covers overdue too: late tasks roll forward with no warning.
export function whenLabel(t, now) {
  if (!t.date) return "";
  const lead = t.rep ? "↻ " : "";
  const at = t.tm ? " " + t.tm : "";
  if (t.date <= now) return lead + "Today" + at;
  if (t.date === addDays(now, 1)) return lead + "Tomorrow" + at;
  const [, m, d] = parts(t.date);
  return `${lead}${DAYS[dow(t.date)]} ${d} ${MONTHS[m]}${at}`;
}

const cleanChecks = (arr) => {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter((c) => c && typeof c.id === "string" && typeof c.text === "string" && c.text.trim() && !seen.has(c.id) && seen.add(c.id))
    .slice(0, 100)
    .map((c) => ({ id: c.id, text: c.text.trim().slice(0, 200), done: c.done === true }));
};

// Only the valid parts of a task's optional date fields. A rep without a valid date is dropped.
const extras = (t) => {
  const out = {};
  if (typeof t.date === "string" && DATE_RE.test(t.date) && addDays(t.date, 0) === t.date) {
    out.date = t.date;
    const r = t.rep;
    if (r && Number.isInteger(r.n) && r.n >= 1 && r.n <= 365 && UNITS.includes(r.unit) && (r.mode === "schedule" || r.mode === "after")) out.rep = { n: r.n, unit: r.unit, mode: r.mode };
    if (typeof t.tm === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.tm)) out.tm = t.tm; // optional time of day, local "HH:MM"
    if (t.ev === true) out.ev = true; // "this evening": Today lists it in its own group
  }
  if (typeof t.n === "string" && t.n.trim()) out.n = t.n.slice(0, 5000); // notes
  const c = cleanChecks(t.c);
  if (c.length) out.c = c; // checklist: [{ id, text, done }]
  if (typeof t.l === "string" && t.l) { // area id
    out.l = t.l;
    if (typeof t.s === "string" && t.s) out.s = t.s; // subarea id inside that area
    if (typeof t.h === "string" && t.h) out.h = t.h; // heading id, in the subarea if it has one, else in the area
  }
  if (Number.isFinite(t.dt) && t.done === true) out.dt = t.dt; // when it was completed, for the Done view
  return out;
};

// Named lists: [{ id, name, u }]. Deleted ones are tombstoned in `tomb`, like tasks.
export function cleanLists(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter((l) => l && typeof l.id === "string" && typeof l.name === "string" && l.name.trim() && !seen.has(l.id) && seen.add(l.id))
    .map((l) => {
      const subs = cleanSubs(l.subs), ids = new Set(subs.map((x) => x.id));
      // shortcut: a heading straight under an area (old data) becomes a subarea with the same id; tasks find it through t.h
      for (const h of cleanHeads(l.heads)) if (!ids.has(h.id)) subs.push({ id: h.id, name: h.name, heads: [] });
      return { id: l.id, name: l.name.trim().slice(0, 40), u: Number.isFinite(l.u) ? l.u : 0, heads: [], subs };
    });
}
// Headings of an area live inside it: [{ id, name }] in display order. shortcut: an area and its headings merge as one unit, newest edit wins.
const cleanHeads = (arr) => {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter((h) => h && typeof h.id === "string" && typeof h.name === "string" && h.name.trim() && !seen.has(h.id) && seen.add(h.id))
    .map((h) => ({ id: h.id, name: h.name.trim().slice(0, 60) }));
};
// Subareas of an area: [{ id, name, heads }]. A heading belongs to the area or to one subarea.
const cleanSubs = (arr) => {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x.id === "string" && typeof x.name === "string" && x.name.trim() && !seen.has(x.id) && seen.add(x.id))
    .map((x) => ({ id: x.id, name: x.name.trim().slice(0, 60), heads: cleanHeads(x.heads) }));
};
export function parseLists(text) {
  try { return cleanLists(JSON.parse(text)?.lists); } catch { return []; }
}

// Accepts an export file ({tasks: [...]}) or a bare array. Throws on anything else.
export function parseBackup(text) {
  let data = JSON.parse(text);
  if (data && !Array.isArray(data)) data = data.tasks;
  if (!Array.isArray(data)) throw new Error("No tasks found");
  const seen = new Set();
  return data
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .map((t) => {
      let id = String(t.id ?? "");
      if (!id || seen.has(id)) id = newId();
      seen.add(id);
      return { id, text: t.text.trim(), done: t.done === true, u: Number.isFinite(t.u) ? t.u : 0, ...extras(t) };
    });
}

// ---- Sync merge ----
// A side is { tasks: [{id, text, done, u}], tomb: { id: deletedAt }, ou }. `u` is the last edit time,
// `ou` the last reorder time. shortcut: device clocks decide who wins, so a badly skewed clock can lose an edit.

// Clean a side that came from storage or the network. Drops anything malformed.
export function normalize(s) {
  const tasks = Array.isArray(s?.tasks) ? s.tasks : [];
  const tomb = {};
  for (const [id, ts] of Object.entries(s?.tomb ?? {})) if (Number.isFinite(ts)) tomb[id] = ts;
  const seen = new Set();
  return {
    tasks: tasks
      .filter((t) => t && typeof t.id === "string" && typeof t.text === "string" && t.text.trim() && !seen.has(t.id) && seen.add(t.id))
      .map((t) => ({ id: t.id, text: t.text.trim(), done: t.done === true, u: Number.isFinite(t.u) ? t.u : 0, ...extras(t) })),
    tomb,
    ou: Number.isFinite(s?.ou) ? s.ou : 0,
    lists: cleanLists(s?.lists),
  };
}

// Newest edit wins per task. A delete beats a task not edited since. The side with the newer `ou`
// sets the order; tasks only the other side has go on top.
export function merge(a, b) {
  const tomb = { ...a.tomb };
  for (const [id, ts] of Object.entries(b.tomb)) tomb[id] = Math.max(tomb[id] ?? 0, ts);
  const byId = new Map();
  for (const t of [...b.tasks, ...a.tasks]) { // a goes last, so a wins a tie
    const cur = byId.get(t.id);
    if (!cur || t.u >= cur.u) byId.set(t.id, t);
  }
  const [win, lose] = a.ou >= b.ou ? [a, b] : [b, a];
  const known = new Set(win.tasks.map((t) => t.id));
  const order = [...lose.tasks.map((t) => t.id).filter((id) => !known.has(id)), ...win.tasks.map((t) => t.id)];
  const tasks = order.map((id) => byId.get(id)).filter((t) => t.u > (tomb[t.id] ?? -1));
  const [la, lb] = [a.lists ?? [], b.lists ?? []], lmap = new Map();
  for (const l of [...lb, ...la]) { const c = lmap.get(l.id); if (!c || l.u >= c.u) lmap.set(l.id, l); } // newest rename wins
  // the side with the newer order (ou) sets the list order
  const lists = [...new Set([...(win === a ? la : lb), ...(win === a ? lb : la)].map((l) => l.id))].map((id) => lmap.get(id)).filter((l) => l.u > (tomb[l.id] ?? -1));
  return { tasks, tomb, ou: Math.max(a.ou, b.ou), lists };
}

// Cheap equality for two sides, used to skip no-op saves and uploads.
export const sig = (s) => JSON.stringify([s.tasks.map((t) => [t.id, t.text, t.done, t.u, t.date, t.rep, t.l, t.s, t.h, t.dt, t.ev, t.tm, t.n, t.c]), Object.entries(s.tomb).sort(), s.ou, (s.lists ?? []).map((l) => [l.id, l.name, l.u, l.heads, l.subs])]);
