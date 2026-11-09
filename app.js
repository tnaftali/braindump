import { addDays, linkify, merge, move, newId, nextDate, nextMonday, normalize, parseBackup, parseLists, sig, today, whenLabel } from "./logic.js";
import { newCode, parseCode, sync } from "./sync.js";

const KEY = "braindump.tasks";
const META = "braindump.meta"; // { tomb, ou, lists }: deleted ids, last reorder time and the named lists, all needed to merge
const VIEW = "braindump.view"; // the view on screen ("inbox", "today" or an area id); per device, not synced
const SYNC = "braindump.sync"; // the sync code, when sync is on
const $ = (id) => document.getElementById(id);
const list = $("list");

let tasks = load();
let meta = loadMeta();
let day = today(); // the local day of the last render
let view = "today"; // "inbox", "today" or an area id
try { view = localStorage.getItem(VIEW) || "today"; } catch {}
const SCHED = "braindump.sched"; // is the Scheduled group open; per device, not synced
let showSched = false;
try { showSched = !!localStorage.getItem(SCHED); } catch {}
const setView = (v) => { view = v; try { localStorage.setItem(VIEW, v); } catch {} render(); };
// A task has an optional date and an optional area. Inbox: neither. Today: any date. Area tab: that area's tasks, dated or not.
const areaOf = (t) => (meta.lists.some((l) => l.id === t.l) ? t.l : ""); // a task of an unknown area counts as having none
const isArea = () => !["inbox", "today", "done"].includes(view);
const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const now = () => Date.now();
const touch = (t) => { t.u = now(); };
const drop = (t) => { meta.tomb[t.id] = now(); };

function loadMeta() {
  try { const m = normalize({ tasks: [], ...JSON.parse(localStorage.getItem(META)) }); return { tomb: m.tomb, ou: m.ou, lists: m.lists }; } catch { return { tomb: {}, ou: 0, lists: [] }; }
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

// Done tasks leave every view except Done, which groups them by the day they were completed.
const inView = (t) => (view === "done" ? t.done : !t.done && (view === "inbox" ? !areaOf(t) && !t.date : view === "today" ? !!t.date : areaOf(t) === view));
const dayOf = (t) => today(new Date(t.dt ?? t.u));

function row(t, td) {
  const li = document.createElement("li");
  li.className = t.done ? "done" : t.date > td ? "future" : "";
  li.dataset.id = t.id;
  const cal = Object.assign(document.createElement("button"), { type: "button", className: "cal", title: "Set a date", innerHTML: CAL });
  cal.setAttribute("aria-label", "Set a date");
  const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: t.done });
  cb.setAttribute("aria-label", "Done");
  const tx = Object.assign(document.createElement("span"), { className: "t", tabIndex: 0, spellcheck: false });
  fill(tx, t.text);
  const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: "Delete" });
  x.setAttribute("aria-label", "Delete");
  const body = Object.assign(document.createElement("div"), { className: "body" });
  body.append(tx);
  if (!isArea() && areaOf(t)) { // the area sits under the text; it is a select, so a tap re-files the task
    const sel = Object.assign(document.createElement("select"), { className: "area", title: "Move to another area" });
    sel.setAttribute("aria-label", "Area");
    sel.append(new Option("No area", ""), ...meta.lists.map((l) => new Option(l.name, l.id)));
    sel.value = areaOf(t);
    body.append(sel);
  }
  const chip = t.date && !(view === "today" && t.date <= td) && !t.done; // in Today every due row would just say "Today"
  const w = Object.assign(document.createElement("button"), { type: "button", className: "when chip", title: "Date and repeat", textContent: chip ? whenLabel(t, td) : "" });
  w.setAttribute("aria-label", "Date and repeat");
  li.append(cal, cb, body, ...(chip ? [w] : []), x);
  return li;
}
const secRow = (text, ...kids) => {
  const li = Object.assign(document.createElement("li"), { className: "sec" });
  li.append(...(kids.length ? kids : [text]));
  return li;
};
const btn = (text, cls, fn, title) => Object.assign(document.createElement("button"), { type: "button", textContent: text, className: cls, title, onclick: fn });

function render() {
  const td = (day = today());
  if (isArea() && !meta.lists.some((l) => l.id === view)) view = "today"; // that area was deleted, here or on another device
  const mine = tasks.filter(inView);
  list.textContent = "";
  $("lren").hidden = $("ldel").hidden = $("hadd").hidden = !isArea();
  $("clear").hidden = !(view === "done" && mine.length);
  $("meta").textContent = "";
  const EMPTY = { inbox: "Inbox is empty. Dump a thought above.", today: "Nothing for today. Give a task a date to see it here.", done: "Nothing completed yet." };
  if (!mine.length && !(isArea() && cur()?.heads.length)) list.innerHTML = `<div class="empty">${EMPTY[view] ?? "This area is empty."}</div>`;
  if (view === "done") {
    $("count").textContent = mine.length ? `${mine.length} done` : "";
    let last = "";
    for (const t of mine.sort((a, b) => (b.dt ?? b.u) - (a.dt ?? a.u))) {
      const d = dayOf(t);
      if (d !== last) { last = d; list.append(secRow(d === td ? "Today" : d === addDays(td, -1) ? "Yesterday" : whenLabel({ date: d }, "1970-01-01"))); }
      list.append(row(t, td));
    }
  } else {
    const open = mine.filter((t) => !(t.date > td));
    const sched = mine.filter((t) => t.date > td).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // closest first
    const heads = (isArea() && cur()?.heads) || [];
    const hid = (t) => (heads.some((h) => h.id === t.h) ? t.h : "");
    open.filter((t) => !hid(t)).forEach((t) => list.append(row(t, td)));
    for (const h of heads) {
      const name = btn(h.name, "hn", () => renameHead(h), "Rename heading");
      list.append(Object.assign(secRow("", name, btn("×", "hx", () => deleteHead(h), "Delete heading")), { className: "sec head" }));
      open.filter((t) => hid(t) === h.id).forEach((t) => list.append(row(t, td)));
    }
    if (sched.length) {
      list.append(secRow("", btn(`${showSched ? "▾" : "▸"} Scheduled (${sched.length})`, "", () => { showSched = !showSched; try { localStorage.setItem(SCHED, showSched ? "1" : ""); } catch {} render(); })));
      if (showSched) sched.forEach((t) => list.append(row(t, td)));
    }
    $("count").textContent = open.length ? `${open.length} open` : mine.length ? "all clear ✓" : "";
  }
  renderTabs({ inbox: tasks.filter((t) => !t.done && !areaOf(t) && !t.date).length, today: tasks.filter((t) => !t.done && t.date <= td).length });
}

function addHead() {
  const l = cur(), name = l && prompt("Heading name")?.trim().slice(0, 60);
  if (!name) return;
  l.heads.push({ id: newId(), name }); l.u = now(); commit();
}
function renameHead(h) {
  const name = prompt("Rename heading", h.name)?.trim().slice(0, 60);
  if (name) { h.name = name; cur().u = now(); commit(); }
}
function deleteHead(h) {
  const l = cur(), mine = tasks.filter((t) => t.h === h.id);
  if (!confirm(`Delete the heading "${h.name}"? Its ${mine.length} tasks stay in the area.`)) return;
  mine.forEach((t) => { delete t.h; touch(t); });
  l.heads = l.heads.filter((x) => x !== h); l.u = now(); commit();
}

const ICON = { // 24px stroke icons, drawn by style.css
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  today: '<path d="M12 3.5l2.6 5.3 5.9.9-4.250 4.100 1 5.800L12 16.800 6.750 19.600l1-5.800L3.500 9.700l5.900-.9z"/>',
  area: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const icon = (k) => Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "svg"), { innerHTML: ICON[k] }); // set below with attributes
const svg = (k) => { const s = icon(k); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); return s; };

function renderTabs(counts) {
  const item = (id, name, ic, onclick = () => setView(id)) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "nav" });
    if (ic) b.append(svg(ic));
    b.append(Object.assign(document.createElement("span"), { className: "nl", textContent: name }));
    if (counts[id]) b.append(Object.assign(document.createElement("span"), { className: "n", textContent: counts[id] }));
    b.setAttribute("aria-current", String(id === view));
    b.onclick = () => { onclick(); document.body.classList.remove("menu"); };
    return b;
  };
  const gap = () => Object.assign(document.createElement("div"), { className: "gap" });
  $("tabs").replaceChildren(
    item("inbox", "Inbox", "inbox"), item("today", "Today", "today"), gap(),
    ...meta.lists.map((l) => item(l.id, l.name, "")), ...(meta.lists.length ? [gap()] : []),
    item("done", "Done", "done"),
    Object.assign(item("", "New area", "add", newArea), { className: "nav new" }),
  );
  $("vt").textContent = { inbox: "Inbox", today: "Today", done: "Done" }[view] ?? cur()?.name ?? "";
}
$("menu").onclick = () => document.body.classList.add("menu");
$("scrim").onclick = () => document.body.classList.remove("menu");

function newArea() {
  const name = prompt("Area name (Home, Finances…)")?.trim().slice(0, 40);
  if (!name) return;
  const l = { id: newId(), name, u: now(), heads: [] };
  meta.lists.push(l);
  view = l.id; try { localStorage.setItem(VIEW, view); } catch {}
  commit();
}
const cur = () => meta.lists.find((l) => l.id === view);
$("lren").onclick = () => {
  const l = cur(), name = l && prompt("Rename area", l.name)?.trim().slice(0, 40);
  if (name) { l.name = name; l.u = now(); commit(); }
};
$("ldel").onclick = () => {
  const l = cur();
  if (!l) return;
  const mine = tasks.filter((t) => t.l === l.id);
  if (!confirm(`Delete the area "${l.name}"? Its ${mine.length} tasks stay, in Today if they have a date and in the Inbox if not.`)) return;
  mine.forEach((t) => { delete t.l; touch(t); });
  meta.lists = meta.lists.filter((x) => x !== l);
  meta.tomb[l.id] = now();
  setView("today"); commit();
};

$("f").onsubmit = (e) => {
  e.preventDefault();
  const text = $("in").value.trim();
  if (!text) return;
  tasks.unshift({ id: newId(), text, done: false, u: now(), ...(view === "today" ? { date: today() } : isArea() ? { l: view } : {}) }); // the tab on screen decides where a new task lands
  $("in").value = "";
  commit();
};

list.addEventListener("change", (e) => {
  const t = byId(e.target);
  if (e.target.matches("select.area")) { // re-file: no area plus no date sends it back to the Inbox
    if (e.target.value) t.l = e.target.value; else delete t.l;
    delete t.h;
    touch(t); commit();
    return;
  }
  if (e.target.checked && t.rep) t.date = nextDate(t.date, t.rep, today()); // repeating: no done state, it moves to its next date
  else { t.done = e.target.checked; if (t.done) t.dt = now(); else delete t.dt; }
  touch(t); commit();
});
list.addEventListener("click", (e) => {
  if (e.target.closest(".when, .cal")) return openWhen(byId(e.target));
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
// Date and repeat sheet. Every change applies at once; there is no save button.
let wid = null;
const wd = $("whend");
function openWhen(t) { wid = t.id; fillWhen(t); wd.showModal(); }
function fillWhen(t) {
  $("wdate").value = t.date ?? "";
  $("runit").value = t.rep?.unit ?? "";
  $("rn").value = t.rep?.n ?? 1;
  $("rmode").value = t.rep?.mode ?? "schedule";
  $("wlistrow").hidden = !meta.lists.length;
  $("wlist").replaceChildren(new Option("None", ""), ...meta.lists.map((l) => new Option(l.name, l.id)));
  $("wlist").value = meta.lists.some((l) => l.id === t.l) ? t.l : "";
  const heads = meta.lists.find((l) => l.id === t.l)?.heads ?? [];
  $("whrow").hidden = !heads.length;
  $("whead").replaceChildren(new Option("None", ""), ...heads.map((h) => new Option(h.name, h.id)));
  $("whead").value = heads.some((h) => h.id === t.h) ? t.h : "";
  wd.toggleAttribute("data-never", !t.rep);
  $("rhelp").textContent = t.rep ? (t.rep.mode === "after" ? "The next date counts from the day you complete it." : "Keeps its rhythm. Missed dates are skipped, not stacked.") : "";
}
function applyWhen(date = $("wdate").value) {
  const t = tasks.find((x) => x.id === wid);
  if (!t) return;
  const unit = $("runit").value, n = Math.min(365, Math.max(1, parseInt($("rn").value, 10) || 1));
  if (unit && !date) date = today(); // a repeat needs a date
  if (date) t.date = date; else delete t.date;
  if (date && unit) t.rep = { n, unit, mode: $("rmode").value }; else delete t.rep;
  touch(t); commit(); fillWhen(t);
}
wd.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => applyWhen({ today: today(), tomorrow: addDays(today(), 1), monday: nextMonday(today()) }[b.dataset.d])));
["wdate", "runit", "rn", "rmode"].forEach((id) => ($(id).onchange = () => applyWhen()));
$("wlist").onchange = () => {
  const t = tasks.find((x) => x.id === wid), v = $("wlist").value;
  if (!t) return;
  if (v) t.l = v; else delete t.l;
  delete t.h;
  touch(t); commit(); fillWhen(t);
};
$("whead").onchange = () => {
  const t = tasks.find((x) => x.id === wid), v = $("whead").value;
  if (!t) return;
  if (v) t.h = v; else delete t.h;
  touch(t); commit(); fillWhen(t);
};
$("hadd").onclick = addHead;
$("wclear").onclick = () => { $("runit").value = ""; applyWhen(""); };
$("wclose").onclick = () => wd.close();

$("clear").onclick = () => { // Done view only: delete every completed task for good
  const n = tasks.filter((t) => t.done).length;
  if (!n || !confirm(`Delete all ${n} completed tasks for good?`)) return;
  tasks.filter((t) => t.done).forEach(drop);
  tasks = tasks.filter((t) => !t.done);
  commit();
};

// Drag to reorder with pointer events: works for mouse and touch. Array order is display order;
// open and done groups keep their own relative order.
let drag = null;
const clearOver = () => list.querySelectorAll(".over-top,.over-bottom").forEach((l) => l.classList.remove("over-top", "over-bottom"));
// The whole row is the handle. Mouse: drag after 5px. Touch: press and hold, so scrolling still works.
const startDrag = (d) => {
  clearTimeout(d.timer);
  d.on = true;
  d.y0 = d.y;
  d.li.setPointerCapture(d.pid);
  d.li.classList.add("drag");
  getSelection()?.removeAllRanges();
};
list.addEventListener("pointerdown", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || li.classList.contains("future") || e.button > 0 || e.target.closest("button, input, a") || e.target.isContentEditable) return;
  drag = { id: li.dataset.id, li, pid: e.pointerId, y: e.clientY, x0: e.clientX, y0: e.clientY, on: false, over: null, before: false, touch: e.pointerType !== "mouse" };
  if (drag.touch) { const d = drag; d.timer = setTimeout(() => { navigator.vibrate?.(8); startDrag(d); }, 300); }
});
list.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.y = e.clientY;
  if (!drag.on) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    if (drag.touch) { clearTimeout(drag.timer); drag = null; return; } // it is a scroll
    startDrag(drag);
  }
  drag.li.style.transform = `translateY(${e.clientY - drag.y0}px)`;
  clearOver();
  drag.over = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest("li[data-id]")).find((l) => l && l !== drag.li && list.contains(l)) ?? null;
  if (drag.over) {
    const r = drag.over.getBoundingClientRect();
    drag.before = e.clientY < r.top + r.height / 2;
    drag.over.classList.add(drag.before ? "over-top" : "over-bottom");
  }
  if (e.clientY < 70) scrollBy(0, -10); else if (e.clientY > innerHeight - 70) scrollBy(0, 10);
});
list.addEventListener("touchmove", (e) => { if (drag?.on) e.preventDefault(); }, { passive: false }); // no page scroll while dragging
const endDrag = (e) => {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag;
  drag = null;
  if (!d.on) return; // a plain click: let it through
  const eat = (c) => c.stopPropagation();
  addEventListener("click", eat, true); // a drag must not also edit or toggle
  setTimeout(() => removeEventListener("click", eat, true), 0);
  if (e.type === "pointerup" && d.over) {
    if (isArea()) { // dropping next to a task also files it under that task's heading
      const o = tasks.find((x) => x.id === d.over.dataset.id), m = tasks.find((x) => x.id === d.id);
      if (o?.h) m.h = o.h; else delete m.h;
      touch(m);
    }
    tasks = move(tasks, d.id, d.over.dataset.id, d.before); meta.ou = now(); save(); queue(); }
  render();
};
list.addEventListener("pointerup", endDrag);
list.addEventListener("pointercancel", endDrag);

// Backup: localStorage can be wiped by the browser, so keep an export habit.
$("export").onclick = () => {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify({ version: 1, tasks, lists: meta.lists }, null, 2)], { type: "application/json" })),
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
    const text = await file.text(), next = parseBackup(text);
    if (!confirm(`Replace your ${tasks.length} tasks with ${next.length} from this file?`)) return;
    for (const l of parseLists(text)) if (!meta.lists.some((x) => x.id === l.id)) meta.lists.push({ ...l, u: now() });
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
const side = () => ({ tasks, tomb: meta.tomb, ou: meta.ou, lists: meta.lists });
const busy = () => drag || document.activeElement?.isContentEditable;
const LABEL = { off: "Sync", syncing: "Syncing…", ok: "Synced ✓", offline: "Offline", error: "Sync failed" };
function setStatus(s, detail = "") {
  $("syncb").textContent = LABEL[s];
  $("refresh").classList.toggle("spin", s === "syncing");
  $("refresh").title = s === "error" ? `Sync failed: ${detail}` : "Sync now";
  $("st").textContent = s === "error" ? `Last sync failed: ${detail}. It retries on the next change.` : s === "offline" ? "No connection. It syncs when you are back online." : "";
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
    if (sig(m) !== sig(side())) { tasks = m.tasks; meta = { tomb: m.tomb, ou: m.ou, lists: m.lists }; save(); render(); }
    setStatus("ok");
  } catch (e) { console.error("sync failed", e); setStatus("error", e?.message ?? String(e)); } finally {
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
$("refresh").onclick = () => (code ? runSync() : $("syncb").click()); // sync off: open the dialog to turn it on
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

const rollover = () => { if (today() !== day && !busy() && !wd.open) render(); }; // a new day: tasks dated today appear
addEventListener("online", () => queue(500));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { rollover(); queue(300); } });
setInterval(() => { if (document.visibilityState === "visible") { rollover(); queue(0); } }, 60000); // pick up changes from other devices while the app stays open
queue(300);
addEventListener("keydown", (e) => {
  const a = document.activeElement;
  if (e.key === "/" && !/INPUT|TEXTAREA/.test(a.tagName) && !a.isContentEditable) { e.preventDefault(); $("in").focus(); }
});

render();
navigator.storage?.persist?.().catch(() => {});
document.addEventListener("gesturestart", (e) => e.preventDefault()); // iOS ignores user-scalable=no, so block pinch here
if (navigator.serviceWorker) {
  // A new app version took over: reload once so the open app runs it now, not on the next launch.
  const had = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !reloaded && !busy()) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js").catch(() => {}); // needs HTTPS or localhost
}
