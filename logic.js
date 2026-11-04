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
      return { id, text: t.text.trim(), done: t.done === true };
    });
}
