import { linkify, merge, move, newId, normalize, parseBackup, sig } from "./logic.js";
import { newCode, parseCode, sync } from "./sync.js";

const KEY = "braindump.tasks";
const META = "braindump.meta"; // { tomb, ou }: deleted ids and last reorder time, needed to merge
const SYNC = "braindump.sync"; // the sync code, when sync is on
const $ = (id) => document.getElementById(id);
const list = $("list");

let tasks = load();
let meta = loadMeta();
const now = () => Date.now();
const touch = (t) => { t.u = now(); };
const drop = (t) => { meta.tomb[t.id] = now(); };

function loadMeta() {
  try { const m = normalize({ tasks: [], ...JSON.parse(localStorage.getItem(META)) }); return { tomb: m.tomb, ou: m.ou }; } catch { return { tomb: {}, ou: 0 }; }
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch {}
  if (!raw) return [];
  try {
    return parseBackup(raw);
  } catch {
    try { localStorage.setItem(`${KEY}.corrupt`, raw); } catch {} // keep the bad copy, start clean
    return [];
  }
}
function save() {
  const cut = now() - 90 * 864e5; // shortcut: deletes are forgotten after 90 days; a device offline longer can bring deleted tasks back
  for (const id in meta.tomb) if (meta.tomb[id] < cut) delete meta.tomb[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(tasks));
    localStorage.setItem(META, JSON.stringify(meta));
  } catch { alert("Couldn't save. Export a backup."); }
}
const commit = () => { save(); render(); queue(); };
const byId = (el) => tasks.find((t) => t.id === el.closest("li").dataset.id);

function fill(el, text) {
  el.replaceChildren(...linkify(text).map((p) => {
    if (!p.url) return document.createTextNode(p.text);
    return Object.assign(document.createElement("a"), { href: p.url, textContent: p.text, target: "_blank", rel: "noopener noreferrer", title: p.url });
  }));
}

function edit(el) {
  el.contentEditable = "plaintext-only";
  el.textContent = byId(el).text; // show the raw URL while editing
  el.focus();
  getSelection().selectAllChildren(el);
  getSelection().collapseToEnd();
}

function render() {
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done);
  list.textContent = "";
  if (!tasks.length) list.innerHTML = '<div class="empty">Nothing yet. Dump a thought above.</div>';
  for (const t of [...open, ...done]) {
    const li = document.createElement("li");
    li.className = t.done ? "done" : "";
    li.dataset.id = t.id;
    const grip = Object.assign(document.createElement("span"), { className: "grip", textContent: "⋮⋮", title: "Drag to reorder" });
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: t.done });
    cb.setAttribute("aria-label", "Done");
    const tx = Object.assign(document.createElement("span"), { className: "t", tabIndex: 0, spellcheck: false });
    fill(tx, t.text);
    const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: "Delete" });
    x.setAttribute("aria-label", "Delete");
    li.append(grip, cb, tx, x);
    list.append(li);
  }
  $("count").textContent = open.length ? `${open.length} open` : tasks.length ? "all clear ✓" : "";
  $("meta").textContent = done.length ? `${done.length} done` : "";
  $("clear").hidden = !done.length;
}

$("f").onsubmit = (e) => {
  e.preventDefault();
  const text = $("in").value.trim();
  if (!text) return;
  tasks.unshift({ id: newId(), text, done: false, u: now() });
  $("in").value = "";
  commit();
};

list.addEventListener("change", (e) => { const t = byId(e.target); t.done = e.target.checked; touch(t); commit(); });
list.addEventListener("click", (e) => {
  if (e.target.classList.contains("t") && !e.target.isContentEditable) return edit(e.target);
  if (!e.target.classList.contains("x")) return;
  const t = byId(e.target);
  drop(t); tasks = tasks.filter((x) => x !== t); commit();
});
list.addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("t") || !e.target.isContentEditable) return;
  const t = byId(e.target), text = e.target.textContent.trim();
  if (!text) { drop(t); tasks = tasks.filter((x) => x !== t); }
  else if (text !== t.text) { t.text = text; touch(t); }
  commit();
});
list.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("t")) return;
  e.preventDefault();
  if (e.target.isContentEditable) { e.target.blur(); $("in").focus(); } else edit(e.target);
});
$("clear").onclick = () => { tasks.filter((t) => t.done).forEach(drop); tasks = tasks.filter((t) => !t.done); commit(); };

// Drag to reorder with pointer events: works for mouse and touch. Array order is display order;
// open and done groups keep their own relative order.
let drag = null;
const clearOver = () => list.querySelectorAll(".over-top,.over-bottom").forEach((l) => l.classList.remove("over-top", "over-bottom"));
list.addEventListener("pointerdown", (e) => {
  const grip = e.target.closest(".grip");
  if (!grip) return;
  const li = grip.closest("li");
  drag = { id: li.dataset.id, li, y0: e.clientY, over: null, before: false };
  grip.setPointerCapture(e.pointerId);
  li.classList.add("drag");
});
list.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.li.style.transform = `translateY(${e.clientY - drag.y0}px)`;
  clearOver();
  drag.over = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest("li")).find((l) => l && l !== drag.li && list.contains(l)) ?? null;
  if (drag.over) {
    const r = drag.over.getBoundingClientRect();
    drag.before = e.clientY < r.top + r.height / 2;
    drag.over.classList.add(drag.before ? "over-top" : "over-bottom");
  }
  if (e.clientY < 70) scrollBy(0, -10); else if (e.clientY > innerHeight - 70) scrollBy(0, 10);
});
const endDrag = (e) => {
  if (!drag) return;
  if (e.type === "pointerup" && drag.over) { tasks = move(tasks, drag.id, drag.over.dataset.id, drag.before); meta.ou = now(); save(); queue(); }
  drag = null;
  render();
};
list.addEventListener("pointerup", endDrag);
list.addEventListener("pointercancel", endDrag);

// Backup: localStorage can be wiped by the browser, so keep an export habit.
$("export").onclick = () => {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify({ version: 1, tasks }, null, 2)], { type: "application/json" })),
    download: `braindump-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};
$("import").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const next = parseBackup(await file.text());
    if (!confirm(`Replace your ${tasks.length} tasks with ${next.length} from this file?`)) return;
    tasks.filter((t) => !next.some((n) => n.id === t.id)).forEach(drop);
    tasks = next.map((t) => ({ ...t, u: now() })); meta.ou = now(); commit();
  } catch { alert("That file isn't a Brain Dump backup."); }
};

// Theme: head script sets the first value from the system; this toggles and persists it.
const THEME_BG = { light: "#e6e0d2", dark: "#262624" };
$("theme").onclick = () => {
  const r = document.documentElement, t = r.dataset.theme === "dark" ? "light" : "dark";
  r.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = THEME_BG[t];
  try { localStorage.setItem("theme", t); } catch {}
};

// Another tab or the installed app changed the data.
addEventListener("storage", (e) => {
  if ((e.key !== KEY && e.key !== META) || document.activeElement?.isContentEditable) return;
  tasks = load(); meta = loadMeta(); render();
});

// ---- Sync ----
// On when a sync code is stored. Tasks merge with the encrypted copy on the server; see sync.js.
let code = null, timer = 0, running = false;
try { code = localStorage.getItem(SYNC); } catch {}
const side = () => ({ tasks, tomb: meta.tomb, ou: meta.ou });
const busy = () => drag || document.activeElement?.isContentEditable;
const LABEL = { off: "Sync", syncing: "Syncing…", ok: "Synced ✓", offline: "Offline", error: "Sync failed" };
function setStatus(s) {
  $("syncb").textContent = LABEL[s];
  $("st").textContent = s === "error" ? "Last sync failed. It retries on the next change." : s === "offline" ? "No connection. It syncs when you are back online." : "";
}

function queue(ms = 3000) {
  if (!code) return;
  clearTimeout(timer);
  timer = setTimeout(runSync, ms);
}

async function runSync() {
  if (!code || running) return;
  if (!navigator.onLine) return setStatus("offline");
  if (busy()) return queue(1500);
  running = true; setStatus("syncing");
  const start = sig(side());
  try {
    const out = await sync(code, side());
    if (busy()) { setStatus("ok"); return queue(1500); }
    const m = merge(side(), out); // folds in edits made while the request ran
    if (sig(m) !== sig(side())) { tasks = m.tasks; meta = { tomb: m.tomb, ou: m.ou }; save(); render(); }
    setStatus("ok");
  } catch { setStatus("error"); } finally {
    running = false;
    if (code && sig(side()) !== start) queue(500);
  }
}

function setCode(c) {
  code = c;
  try { c ? localStorage.setItem(SYNC, c) : localStorage.removeItem(SYNC); } catch {}
  showDialog();
  if (c) runSync(); else setStatus("off");
}

function showDialog() {
  $("offv").hidden = !!code;
  $("onv").hidden = !code;
  $("codev").value = code ?? "";
}
const copy = (text, btn) => navigator.clipboard?.writeText(text).then(() => { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1500); });
const link = () => `${location.origin}${location.pathname}#sync=${code}`;

$("syncb").onclick = () => { showDialog(); $("dlg").showModal(); };
$("close").onclick = () => $("dlg").close();
$("on").onclick = () => setCode(newCode());
$("joinb").onclick = () => {
  const c = parseCode($("join").value);
  if (c) { $("join").value = ""; setCode(c); } else $("join").setCustomValidity("Not a sync code");
  $("join").reportValidity();
};
$("join").oninput = () => $("join").setCustomValidity("");
$("copyl").onclick = (e) => copy(link(), e.target);
$("copyc").onclick = (e) => copy(code, e.target);
$("now").onclick = () => runSync();
$("offb").onclick = () => { if (confirm("Turn off sync on this device? Your tasks here stay. The synced copy stays on the server.")) setCode(null); };

// A #sync=<code> link joins this device. Confirm first: a link from someone else would upload your tasks to their list.
const joinHash = location.hash.match(/^#sync=([A-Za-z0-9_-]{22})$/);
if (joinHash) {
  history.replaceState(null, "", location.pathname + location.search); // the code is a secret, keep it out of the URL bar
  if (joinHash[1] !== code && confirm("Sync this device with the shared list from that link? Your tasks here merge into it.")) setCode(joinHash[1]);
}

addEventListener("online", () => queue(500));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") queue(300); });
setInterval(() => { if (document.visibilityState === "visible") queue(0); }, 60000); // pick up changes from other devices while the app stays open
queue(300);
addEventListener("keydown", (e) => {
  const a = document.activeElement;
  if (e.key === "/" && !/INPUT|TEXTAREA/.test(a.tagName) && !a.isContentEditable) { e.preventDefault(); $("in").focus(); }
});

render();
navigator.storage?.persist?.().catch(() => {});
navigator.serviceWorker?.register("sw.js").catch(() => {}); // needs HTTPS or localhost
