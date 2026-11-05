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
      return { id, text: t.text.trim(), done: t.done === true, u: Number.isFinite(t.u) ? t.u : 0 };
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
      .map((t) => ({ id: t.id, text: t.text.trim(), done: t.done === true, u: Number.isFinite(t.u) ? t.u : 0 })),
    tomb,
    ou: Number.isFinite(s?.ou) ? s.ou : 0,
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
  return { tasks, tomb, ou: Math.max(a.ou, b.ou) };
}

// Cheap equality for two sides, used to skip no-op saves and uploads.
export const sig = (s) => JSON.stringify([s.tasks.map((t) => [t.id, t.text, t.done, t.u]), Object.entries(s.tomb).sort(), s.ou]);
