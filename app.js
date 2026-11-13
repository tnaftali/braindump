import { addDays, label, linkify, merge, move, newId, nextDate, nextMonday, normalize, parseBackup, parseLists, sig, today, whenLabel } from "./logic.js";
import { parseWhen } from "./nl.js";
import { VAPID_PUBLIC, ackInbox, captureUrl, derive, newCode, parseCode, pullInbox, putReminders, sync } from "./sync.js";

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
const FOLD = "braindump.folded"; // collapsed headings, by id
const folded = new Set();
try { for (const id of JSON.parse(localStorage.getItem(FOLD) ?? "[]")) folded.add(id); } catch {}
const REM = "braindump.rem"; // reminders are on for this device
let remOn = false, remSent = "", remTimer = 0;
try { remOn = !!localStorage.getItem(REM); } catch {}
const SCHED = "braindump.sched"; // is the Scheduled group open; per device, not synced
let showSched = false;
try { showSched = !!localStorage.getItem(SCHED); } catch {}
// Going deeper (an area from a task, a project from its area) remembers where you came from; the Back button returns there.
// Picking a view in the sidebar starts over.
let trail = [];
const goView = (v) => { view = v; try { localStorage.setItem(VIEW, v); } catch {} render(); };
const setView = (v, deep) => { if (v === view) return; trail = deep ? [...trail, view] : []; goView(v); };
// A task has an optional date and an optional area. Inbox: neither. Today: any date. Area tab: that area's tasks, dated or not.
const areaOf = (t) => (meta.lists.some((l) => l.id === t.l) ? t.l : ""); // a task of an unknown area counts as having none
const isArea = () => !["inbox", "today", "upcoming", "done", "board", "all"].includes(view); // a view is a built-in name, an area id, or "area|subarea"
const vArea = () => view.split("|")[0], vSub = () => view.split("|")[1] ?? "";
const NAVFOLD = "braindump.navfold"; // areas whose subareas are hidden in the sidebar; per device
const navShut = new Set(); try { for (const id of JSON.parse(localStorage.getItem(NAVFOLD) ?? "[]")) navShut.add(id); } catch {}
const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
// Our own dialog in place of confirm/prompt/alert. With `input` it returns the trimmed text, or null on cancel; without, true or false.
const askd = $("ask"), aski = $("aski");
function ask({ title, text = "", ok = "OK", input, cancel = true, danger = false }) {
  return new Promise((resolve) => {
    let out = null;
    $("askt").textContent = title; aski.setAttribute("aria-label", title);
    $("askp").textContent = text;
    $("askp").hidden = !text;
    aski.hidden = input === undefined;
    aski.value = input ?? "";
    $("asko").textContent = ok;
    $("askx").hidden = !cancel;
    askd.toggleAttribute("data-danger", danger);
    askd.onclose = () => resolve(out ?? (input === undefined ? false : null)); // Esc, a tap outside and Cancel all land here
    $("askf").onsubmit = () => { out = input === undefined ? true : aski.value.trim(); };
    askd.showModal();
    if (input !== undefined) { aski.focus(); aski.select(); }
  });
}
$("askx").onclick = () => askd.close();
// A short-lived "Undo" bar instead of a confirm dialog.
let toastTimer;
function undoable(text, undo) {
  const el = $("toast");
  el.replaceChildren(text, Object.assign(document.createElement("button"), { type: "button", textContent: "Undo", onclick: () => { clearTimeout(toastTimer); el.hidden = true; undo(); } }));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
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
  } catch { ask({ title: "Couldn't save", text: "Export a backup.", cancel: false }); }
}
const commit = () => { save(); render(); queue(); };
const byId = (el) => tasks.find((t) => t.id === el.closest("li").dataset.id);

function fill(el, text) {
  el.replaceChildren(...linkify(text).map((p) => {
    if (!p.url) return document.createTextNode(p.text);
    return Object.assign(document.createElement("a"), { href: p.url, textContent: p.text, target: "_blank", rel: "noopener noreferrer", title: p.url });
  }));
}

// Done tasks leave every view except Done, which groups them by the day they were completed.
const inView = (t) => (view === "done" ? t.done : !t.done && (view === "all" ? true : view === "board" || view === "inbox" ? !areaOf(t) && !t.date : view === "today" ? !!t.date && t.date <= day : view === "upcoming" ? t.date > day : areaOf(t) === vArea() && (!vSub() || subOf(meta.lists.find((l) => l.id === t.l), t)?.id === vSub())));
const byDate = (a, b) => (a.date + (a.tm ?? "")).localeCompare(b.date + (b.tm ?? "")); // by day, then by time
const dayOf = (t) => today(new Date(t.dt ?? t.u));

// One select for the whole place: an area, a subarea in it, or a heading in one of its subareas.
// Values: "area", "area|sub", "area|sub|heading".
const subOf = (l, t) => l?.subs.find((x) => x.id === (t.s || t.h)); // old data: t.h alone names a subarea
const placeOf = (t) => {
  const l = meta.lists.find((x) => x.id === areaOf(t)), sa = subOf(l, t), h = t.s ? sa?.heads.find((x) => x.id === t.h) : undefined; // headings live in subareas only
  return { l, sa, h };
};
function placeSelect(sel, t, none) {
  sel.replaceChildren(new Option(none, ""));
  for (const l of meta.lists) {
    sel.append(new Option(l.name, l.id));
    for (const sa of l.subs) {
      sel.append(new Option(`\u2003↳ ${sa.name}`, `${l.id}|${sa.id}`));
    }
  }
  const { l, sa, h } = placeOf(t);
  sel.value = l ? [l.id, sa?.id ?? ""].join("|").replace(/\|+$/, "") : ""; // headings are not listed: drag a task onto one
  if (sa) sel.selectedOptions[0].textContent = `${l.name} › ${sa.name}`; // closed, it names the whole path
}
const placeName = (t) => { const { l, sa } = placeOf(t); return l ? (sa ? `${l.name} › ${sa.name}` : l.name) : ""; }; // headings are not named: drag a task onto one
const setPlace = (t, v) => {
  const [l, sa] = v.split("|"), h = sa && sa === t.s ? t.h : ""; // a task keeps its heading while it stays in the same subarea
  for (const [k, x] of [["l", l], ["s", sa], ["h", h]]) if (x) t[k] = x; else delete t[k];
};
function row(t, td) {
  const li = document.createElement("li");
  li.className = t.done ? "done" : t.date > td ? "future" : "";
  li.dataset.id = t.id;
  const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: t.done });
  cb.setAttribute("aria-label", `Done: ${t.text}`);
  const tx = Object.assign(document.createElement("span"), { className: "t", tabIndex: 0, spellcheck: false });
  tx.setAttribute("role", "button"); tx.setAttribute("aria-description", "Press Enter to open it. Alt and arrow keys move it."); tx.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  fill(tx, t.text);
  const x = Object.assign(document.createElement("button"), { className: "x", title: "Delete" });
  x.append(svg("x")); x.setAttribute("aria-label", `Delete: ${t.text}`);
  const body = Object.assign(document.createElement("div"), { className: "body" });
  body.append(tx);
  if (t.n) { const nt = Object.assign(document.createElement("p"), { className: "note", title: "Edit notes" }); fill(nt, t.n); body.append(nt); }
  const shutc = folded.has(t.id);
  if (t.c?.length) {
    const tc = Object.assign(document.createElement("button"), { type: "button", className: "tc", title: shutc ? "Show checklist" : "Hide checklist" });
    tc.append(svg("chev"), `${t.c.filter((c) => c.done).length}/${t.c.length}`); tc.classList.toggle("open", !shutc);
    body.append(tc);
  }
  for (const c of shutc ? [] : t.c ?? []) { // checklist items toggle in place; edit them in the details sheet
    const ci = Object.assign(document.createElement("label"), { className: c.done ? "ci done" : "ci" }), box = Object.assign(document.createElement("input"), { type: "checkbox", checked: c.done });
    box.dataset.c = c.id;
    ci.append(box, Object.assign(document.createElement("span"), { textContent: c.text }));
    body.append(ci);
  }
  let ar = null; // the area (and subarea) sits at the top right of the row; a tap opens that area, the details sheet re-files the task
  if (!isArea() && view !== "board" && view !== "all" && areaOf(t)) {
    const { l, sa } = placeOf(t);
    ar = Object.assign(document.createElement("button"), { type: "button", className: "area", title: "Open this area", textContent: sa ? `${l.name} › ${sa.name}` : l.name });
  }
  const past = !!t.tm && new Date(`${t.date}T${t.tm}`) <= new Date(); // a passed time is hidden; the task keeps it
  const shown = past ? { ...t, tm: undefined } : t;
  const label = view === "today" && t.date <= td ? shown.tm ?? "" : whenLabel(shown, td); // in Today every due row would just say "Today", so show only its time
  const chip = !!label && !t.done;
  const w = Object.assign(document.createElement("button"), { type: "button", className: "when chip", title: "Date and repeat", textContent: label });
  w.setAttribute("aria-label", "Date and repeat");
  if (t.tm && !t.done && !past) w.prepend(svg("bell"));
  if (chip && view !== "today" && t.date <= td) w.prepend(svg("today")); // a star marks what is due today (or overdue); the Today view needs none // only while the reminder is still to come; a past one keeps its date and time
  li.append(cb, body, ...(chip ? [w] : []), ...(ar ? [ar] : []), x);
  return li;
}
const secRow = (text, ...kids) => {
  const li = Object.assign(document.createElement("li"), { className: "sec" });
  li.append(...(kids.length ? kids : [text]));
  return li;
};
const ibtn = (k, cls, fn, title, open) => { const b = btn("", cls, fn, title); b.append(svg(k)); if (open) b.classList.add("open"); return b; }; // a button drawn with an ICON, not a glyph
const btn = (text, cls, fn, title) => Object.assign(document.createElement("button"), { type: "button", textContent: text, className: cls, title, onclick: fn });

// Board: one column per area (tasks with no area sit in Inbox), a project's tasks under its name. Rows are the same rows as everywhere else.
function renderBoard(mine, td) {
  const col = (id, name, inCol, l) => {
    const c = Object.assign(document.createElement("section"), { className: "col" }), body = document.createElement("ul");
    c.dataset.col = id;
    const add = Object.assign(document.createElement("input"), { className: "cadd", placeholder: "Add a task", enterkeyhint: "done", autocomplete: "off", maxLength: 500 });
    add.setAttribute("aria-label", `Add a task to ${name}`);
    add.onkeydown = (e) => {
      const typed = add.value.trim();
      if (e.key !== "Enter" || !typed) return;
      const { text, ...when } = parseWhen(typed);
      const place = add.pick ? { l: add.pick.l, ...(add.pick.s ? { s: add.pick.s } : {}) } : l ? { l: l.id } : {}; // the column decides where a new task lands; "#" overrides it
      tasks.unshift({ id: newId(), text, done: false, u: now(), ...place, ...when });
      commit();
      list.querySelector(`[data-col="${id}"] .cadd`)?.focus();
    };
    const h = btn(name, "colh", l ? () => setView(l.id, true) : () => setView("inbox", true), l ? "Open this area" : "Open the Inbox");
    const toggle = (key) => () => { if (!folded.delete(key)) folded.add(key); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} render(); };
    const later = inCol.filter((t) => t.date > td).sort(byDate), now_ = inCol.filter((t) => !(t.date > td)); // scheduled tasks wait in Upcoming at the bottom
    body.append(...now_.filter((t) => !l || !subOf(l, t)).map((t) => row(t, td)));
    for (const sa of l?.subs ?? []) { // headings are not shown: a project's tasks sit together
      const mineSa = now_.filter((t) => subOf(l, t)?.id === sa.id);
      if (!mineSa.length) continue;
      const key = `bd:${sa.id}`, shut = folded.has(key);
      const sh = ibtn("chev", "hc", toggle(key), shut ? "Expand" : "Collapse", !shut), nm = btn(sa.name, "subh", () => setView(`${l.id}|${sa.id}`, true), "Open this project");
      body.append(secRow("", sh, nm));
      if (!shut) body.append(...mineSa.map((t) => row(t, td)));
    }
    if (later.length) {
      const key = `bd:up:${id}`, open = folded.has(key), u = ibtn("chev", "upg", toggle(key), "", open);
      u.append(`Upcoming (${later.length})`);
      body.append(secRow("", u));
      if (open) body.append(...later.map((t) => row(t, td)));
    }
    c.append(h, add, body);
    return c;
  };
  const open = tasks.filter((t) => !t.done); // shown in full: the date chip on a row says when
  list.append(col("inbox", "Inbox", open.filter((t) => !areaOf(t))), ...meta.lists.map((l) => col(l.id, l.name, open.filter((t) => areaOf(t) === l.id), l)));
}
// Everything: every open task in one list, grouped like the Board: the Inbox, then each area with its projects under it.
function renderAll(mine, td) {
  const toggle = (key) => () => { if (!folded.delete(key)) folded.add(key); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} render(); };
  const group = (id, name, all, onOpen, l) => {
    if (!all.length) return;
    const tasks = [...all.filter((t) => t.date).sort(byDate), ...all.filter((t) => !t.date)]; // coming up first, undated last
    const key = `all:${id}`, shut = folded.has(key);
    list.append(secRow("", ibtn("chev", "hc", toggle(key), shut ? "Expand" : "Collapse", !shut), btn(name, "hn", onOpen, "Open")));
    if (shut) return;
    list.append(...tasks.filter((t) => !l || !subOf(l, t)).map((t) => row(t, td)));
    for (const sa of l?.subs ?? []) {
      const inSa = tasks.filter((t) => subOf(l, t)?.id === sa.id);
      if (inSa.length) list.append(secRow("", btn(sa.name, "subh", () => setView(`${l.id}|${sa.id}`, true), "Open this project")), ...inSa.map((t) => row(t, td)));
    }
  };
  group("inbox", "Inbox", mine.filter((t) => !areaOf(t)), () => setView("inbox", true));
  for (const l of meta.lists) group(l.id, l.name, mine.filter((t) => areaOf(t) === l.id), () => setView(l.id, true), l);
}
let drawn = 0; // when the list was last drawn
function render() {
  drawn = now();
  const td = (day = today());
  if (isArea() && !(cur() && (!vSub() || cur().subs.some((s) => s.id === vSub())))) view = "today"; // that area or subarea was deleted, here or on another device
  const mine = tasks.filter(inView);
  list.textContent = "";
  $("lren").hidden = $("ldel").hidden = !isArea(); $("sadd").hidden = !isArea() || !!vSub(); $("hadd").hidden = !vSub();
  $("lren").textContent = vSub() ? "Rename project" : "Rename area"; $("ldel").textContent = vSub() ? "Delete project" : "Delete area";
  $("clear").hidden = !(view === "done" && mine.length);
  $("meta").textContent = "";
  list.classList.toggle("up", view === "upcoming");
  $("back").hidden = !trail.length;
  list.classList.toggle("board", view === "board"); document.body.classList.toggle("board", view === "board");
  const EMPTY = { inbox: "Inbox is empty. Dump a thought above.", today: "Nothing for today. Give a task a date to see it here.", upcoming: "Nothing scheduled. Give a task a future date to see it here.", done: "Nothing completed yet.", all: "No open tasks." };
  if (!mine.length && view !== "board" && !(isArea() && cur()?.subs.length)) list.innerHTML = `<div class="empty">${EMPTY[view] ?? "This area is empty."}</div>`;
  if (view === "board") renderBoard(mine, td);
  else if (view === "all") renderAll(mine, td);
  else if (view === "done") {
    let last = "";
    for (const t of mine.sort((a, b) => (b.dt ?? b.u) - (a.dt ?? a.u))) {
      const d = dayOf(t);
      if (d !== last) { last = d; list.append(secRow(d === td ? "Today" : d === addDays(td, -1) ? "Yesterday" : whenLabel({ date: d }, "1970-01-01"))); }
      list.append(row(t, td));
    }
  } else if (view === "upcoming") { // future dates only, one group per day
    let last = "";
    const near = addDays(td, 10), mon = (d) => d.slice(0, 7); // the next 10 days by day; later ones fold into a month each
    for (const t of mine.sort(byDate)) {
      if (t.date > near) {
        if (mon(t.date) !== last) {
          last = mon(t.date);
          const key = `upm:${last}`, open = folded.has(key), n = mine.filter((x) => x.date > near && mon(x.date) === last).length;
          const y = +last.slice(0, 4), name = new Date(y, +last.slice(5) - 1, 1).toLocaleString(undefined, { month: "long", ...(y !== +td.slice(0, 4) ? { year: "numeric" } : {}) });
          const u = ibtn("chev", "upg", () => { if (!folded.delete(key)) folded.add(key); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} render(); }, "", open);
          u.append(`${name} (${n})`);
          list.append(secRow("", u));
        }
        if (!folded.has(`upm:${last}`)) continue;
      } else if (t.date !== last) { last = t.date; list.append(secRow(whenLabel({ date: t.date }, td))); }
      list.append(row(t, td));
    }
  } else {
    const open = mine.filter((t) => !(t.date > td));
    const eve = new Set(view === "today" ? open.filter((t) => t.ev) : []); // Today lists "this evening" tasks last
    const l = isArea() ? cur() : null;
    const loc = (t) => { // where a task sits in this area: its subarea and heading, if both still exist
      const sa = subOf(l, t);
      return { sa: sa?.id ?? "", h: t.s ? sa?.heads.find((x) => x.id === t.h)?.id ?? "" : "" };
    };
    const placed = (t) => !!(loc(t).sa || loc(t).h);
    const sched = mine.filter((t) => t.date > td && (vSub() || !placed(t))).sort(byDate); // closest first; a scheduled task in a group stays in it
    open.filter((t) => !placed(t) && !eve.has(t)).forEach((t) => list.append(row(t, td)));
    // A group is a subarea or a heading: a header row (fold, name, count when folded, extras, delete) and its tasks, scheduled ones last.
    const group = (item, cls, inside, ds, isSub, ...extra) => {
      const shut = folded.has(item.id) && !(isSub && vSub()); // a subarea on its own page is never folded
      const later = inside.filter((t) => t.date > td).sort(byDate), key = `up:${item.id}`; // future tasks get their own Upcoming row, closed until opened
      inside = inside.filter((t) => !(t.date > td));
      const fold = ibtn("chev", "hc", () => { if (shut) folded.delete(item.id); else folded.add(item.id); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} render(); }, shut ? "Expand" : "Collapse", !shut);
      const hl = Object.assign(secRow("", fold, isSub && !vSub() ? btn(item.name, "hn", () => setView(`${vArea()}|${item.id}`, true), "Open this project") : btn(item.name, "hn", () => renameItem(item), "Rename"), ...extra, ibtn("x", "hx", () => deleteItem(item, isSub), isSub ? "Delete project" : "Delete heading")), { className: `sec ${cls}` });
      Object.assign(hl.dataset, ds); // dragging a task onto the header files the task under it
      list.append(hl);
      if (!shut) inside.forEach((t) => list.append(row(t, td)));
      if (!shut && !vSub() && later.length) { // on a project's own page the page-level Upcoming covers these
        const open = folded.has(key), u = ibtn("chev", "upg", () => { if (open) folded.delete(key); else folded.add(key); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} render(); }, "", open);
        u.append(`Upcoming (${later.length})`);
        list.append(Object.assign(secRow("", u), { className: `sec ups${isSub ? "" : " in"}` }));
        if (open) later.forEach((t) => list.append(row(t, td)));
      }
      return shut;
    };
    for (const sa of l?.subs ?? []) {
      if (vSub() && sa.id !== vSub()) continue;
      const shut = group(sa, "sub", mine.filter((t) => loc(t).sa === sa.id && !loc(t).h), { sid: sa.id }, true, btn("+", "ha", () => addHead(sa), "Add a heading"));
      if (vSub()) list.querySelector("li.sec.sub")?.remove(); // the page title already names it
      if (!shut) for (const h of sa.heads) group(h, "head in", mine.filter((t) => loc(t).sa === sa.id && loc(t).h === h.id), { hid: h.id, hs: sa.id }, false);
    }
    if (view === "today" && open.length) { // shown even when empty: it is a drop target for moving a task into the evening
      const eh = secRow("", svg("evening"), "This Evening");
      eh.dataset.ev = "1";
      list.append(eh);
      open.filter((t) => eve.has(t)).forEach((t) => list.append(row(t, td)));
    }
    if (sched.length) {
      list.append(secRow("", (() => { const u = ibtn("chev", "upg", () => { showSched = !showSched; try { localStorage.setItem(SCHED, showSched ? "1" : ""); } catch {} render(); }, "", showSched); u.append(`Upcoming (${sched.length})`); return u; })()));
      if (showSched) sched.forEach((t) => list.append(row(t, td)));
    }
  }
  remQueue();
  renderTabs({ inbox: tasks.filter((t) => !t.done && !areaOf(t) && !t.date).length, today: tasks.filter((t) => !t.done && t.date <= td).length });
}

async function addHead(sa) {
  const l = cur(), name = l && (await ask({ title: "New heading", text: `In ${sa.name}`, input: "", ok: "Add" }))?.slice(0, 60);
  if (!name) return;
  sa.heads.push({ id: newId(), name }); l.u = now(); commit();
}
async function addSub() {
  const l = cur(), name = l && (await ask({ title: "New project", text: `In ${l.name}`, input: "", ok: "Add" }))?.slice(0, 60);
  if (!name) return;
  l.subs.push({ id: newId(), name, heads: [] }); l.u = now(); commit();
}
async function renameItem(item) {
  const name = (await ask({ title: "Rename", input: item.name, ok: "Save" }))?.slice(0, 60);
  if (name) { item.name = name; cur().u = now(); commit(); }
}
async function deleteItem(item, isSub) {
  const l = cur(), mine = tasks.filter((t) => (isSub ? t.s : t.h) === item.id);
  if (!(await ask({ title: `Delete ${isSub ? "project" : "heading"}?`, text: `"${item.name}" goes away. Its ${mine.length} tasks stay in the area.`, ok: "Delete", danger: true }))) return;
  mine.forEach((t) => { delete t.h; if (isSub) delete t.s; touch(t); });
  if (isSub) l.subs = l.subs.filter((x) => x !== item);
  else for (const c of l.subs) c.heads = c.heads.filter((x) => x !== item);
  l.u = now(); commit();
}

const ICON = { // 24px stroke icons, drawn by style.css
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path class="cut" d="M4 13h5l1 2h4l1-2h5"/>',
  today: '<path d="M12 3.5l2.6 5.3 5.9.9-4.250 4.100 1 5.800L12 16.800 6.750 19.600l1-5.800L3.500 9.700l5.900-.9z"/>',
  upcoming: '<rect x="4" y="5" width="16" height="15" rx="2"/><path class="cut" d="M4 10h16"/><path d="M9 3v4M15 3v4"/>',
  area: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  done: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.500 2h-15z"/><path d="M10 20.500a2 2 0 0 0 4 0"/>',
  evening: '<path d="M20.5 14.500A9 9 0 1 1 9.500 3.500a9.200 9.200 0 0 0 11 11z"/>',
  tomorrow: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  week: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  all: '<rect x="4" y="10" width="16" height="10" rx="2.500"/><path d="M7 5.500h10"/>',
  task: '<circle cx="12" cy="12" r="7.5"/>',
  board: '<rect x="4" y="4" width="4" height="15" rx="1"/><rect x="10" y="4" width="4" height="9" rx="1"/><rect x="16" y="4" width="4" height="12" rx="1"/>',
  chev: '<path d="M9 6l6 6-6 6"/>', // points right; .open turns it down
};
const icon = (k) => Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "svg"), { innerHTML: ICON[k] }); // set below with attributes
const svg = (k) => { const s = icon(k); s.dataset.k = k; s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); return s; };

function renderTabs(counts) {
  const item = (id, name, ic, onclick = () => setView(id)) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "nav" });
    if (ic) b.append(svg(ic));
    b.append(Object.assign(document.createElement("span"), { className: "nl", textContent: name }));
    if (counts[id]) b.append(Object.assign(document.createElement("span"), { className: "n", textContent: counts[id] }));
    b.setAttribute("aria-current", String(id === view));
    b.onclick = () => { if (swallow) return (swallow = false); onclick(); document.body.classList.remove("menu"); };
    return b;
  };
  const gap = () => Object.assign(document.createElement("div"), { className: "gap" });
  $("tabs").replaceChildren(
    item("inbox", "Inbox", "inbox"), item("today", "Today", "today"), item("upcoming", "Upcoming", "upcoming"), item("all", "Anytime", "all"), item("board", "Board", "board"), item("done", "Done", "done"), gap(),
    ...meta.lists.map((l) => { // an area with its subareas under it; the caret hides them
      const g = Object.assign(document.createElement("div"), { className: "ngrp" }), shut = navShut.has(l.id);
      g.dataset.lid = l.id;
      const a = item(l.id, l.name, "");
      if (l.subs.length) {
        const c = Object.assign(document.createElement("span"), { className: shut ? "car" : "car open", title: shut ? "Show projects" : "Hide projects" });
        c.onclick = (e) => { e.stopPropagation(); if (shut) navShut.delete(l.id); else navShut.add(l.id); try { localStorage.setItem(NAVFOLD, JSON.stringify([...navShut])); } catch {} renderTabs(counts); };
        c.append(svg("chev")); a.append(c);
      }
      g.append(a);
      if (!shut) for (const s of l.subs) g.append(Object.assign(item(`${l.id}|${s.id}`, s.name, ""), { className: "nav subnav" }));
      return g;
    }), ...(meta.lists.length ? [gap()] : []),
    Object.assign(item("", "New area", "add", newArea), { className: "nav new" }),
  );
  $("vt").replaceChildren(...(ICON[view] && isArea() === false ? [svg(view)] : []), { inbox: "Inbox", today: "Today", upcoming: "Upcoming", done: "Done", board: "Board", all: "Anytime" }[view] ?? (vSub() ? cur()?.subs.find((s) => s.id === vSub())?.name : cur()?.name) ?? "");
}
// Drag an area up or down in the sidebar. Touch: hold 300 ms first, so a plain swipe still scrolls.
let swallow = false;
$("tabs").addEventListener("pointerdown", (e) => {
  const b = e.target.closest("[data-lid]");
  if (!b || e.button) return;
  const touch = e.pointerType === "touch", y0 = e.clientY;
  let on = false, timer;
  const start = () => { on = true; b.classList.add("drag"); b.setPointerCapture(e.pointerId); navigator.vibrate?.(8); };
  const block = (ev) => { if (on) ev.preventDefault(); }; // stop the page scrolling under the drag
  const move = (m) => {
    if (!on) {
      if (Math.abs(m.clientY - y0) <= 8) return;
      if (touch) return stop(); // a swipe, not a hold: let it scroll
      start();
    }
    for (const o of $("tabs").querySelectorAll("[data-lid]")) {
      const r = o.getBoundingClientRect();
      if (o !== b && m.clientY > r.top && m.clientY < r.bottom) { o.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? o.after(b) : o.before(b); break; }
    }
  };
  const stop = () => {
    clearTimeout(timer);
    removeEventListener("pointermove", move); removeEventListener("pointerup", stop); removeEventListener("pointercancel", stop); removeEventListener("touchmove", block);
    if (!on) return;
    b.classList.remove("drag"); swallow = true; setTimeout(() => (swallow = false), 0);
    const ids = [...$("tabs").querySelectorAll("[data-lid]")].map((o) => o.dataset.lid);
    if (ids.join() !== meta.lists.map((l) => l.id).join()) { meta.lists = ids.map((id) => meta.lists.find((l) => l.id === id)); meta.ou = now(); commit(); }
  };
  addEventListener("pointermove", move); addEventListener("pointerup", stop); addEventListener("pointercancel", stop); addEventListener("touchmove", block, { passive: false });
  if (touch) timer = setTimeout(start, 300);
});
$("tabs").addEventListener("keydown", (e) => { // Alt+Up/Down moves the focused area
  const g = e.target.closest(".ngrp");
  if (!e.altKey || !g || !e.target.classList.contains("nav") || e.target.classList.contains("subnav") || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const i = meta.lists.findIndex((l) => l.id === g.dataset.lid), j = i + (e.key === "ArrowUp" ? -1 : 1);
  if (j < 0 || j >= meta.lists.length) return;
  [meta.lists[i], meta.lists[j]] = [meta.lists[j], meta.lists[i]]; meta.ou = now(); commit();
  $("tabs").querySelector(`[data-lid="${g.dataset.lid}"] > .nav`)?.focus();
});
$("back").onclick = () => { if (trail.length) goView(trail.pop()); };
$("menu").onclick = () => document.body.classList.add("menu");
$("scrim").onclick = () => document.body.classList.remove("menu");
// Phone: swipe right from the left edge opens the sidebar, swipe left closes it.
const phone = matchMedia("(max-width: 767px)");
let sw = null;
addEventListener("touchstart", (e) => {
  const p = e.touches[0], open = document.body.classList.contains("menu");
  sw = phone.matches && e.touches.length === 1 && (open || p.clientX < 24) ? { x: p.clientX, y: p.clientY, open } : null;
}, { passive: true });
addEventListener("touchmove", (e) => {
  if (!sw) return;
  const p = e.touches[0], dx = p.clientX - sw.x, dy = p.clientY - sw.y;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) sw = null; // a scroll, not a swipe
  else if (sw.open ? dx < -60 : dx > 60) { document.body.classList.toggle("menu", !sw.open); sw = null; }
}, { passive: true });

async function newArea() {
  const name = (await ask({ title: "New area", text: "Home, Finances, Work…", input: "", ok: "Create" }))?.slice(0, 40);
  if (!name) return;
  const l = { id: newId(), name, u: now(), heads: [], subs: [] };
  meta.lists.push(l);
  commit(); setView(l.id);
}
const cur = () => meta.lists.find((l) => l.id === vArea());
$("lren").onclick = async () => {
  const sub = vSub() && cur()?.subs.find((s) => s.id === vSub());
  if (sub) return renameItem(sub);
  const l = cur(), name = l && (await ask({ title: "Rename area", input: l.name, ok: "Save" }))?.slice(0, 40);
  if (name) { l.name = name; l.u = now(); commit(); }
};
$("ldel").onclick = async () => {
  const l = cur(), sub = vSub() && l?.subs.find((s) => s.id === vSub());
  if (sub) { await deleteItem(sub, true); if (!l.subs.includes(sub)) setView(l.id); return; } // back to the area once it is gone
  if (!l) return;
  const mine = tasks.filter((t) => t.l === l.id);
  if (!(await ask({ title: "Delete area?", text: `"${l.name}" goes away. Its ${mine.length} tasks stay, in Today if they have a date and in the Inbox if not.`, ok: "Delete", danger: true }))) return;
  mine.forEach((t) => { delete t.l; touch(t); });
  meta.lists = meta.lists.filter((x) => x !== l);
  meta.tomb[l.id] = now();
  setView("today"); commit();
};

// "#" in any task text field picks an area or project: type #, filter, Enter or Tab to choose.
// New-task fields (the main box, a board column) show the choice as a chip until the task is added; a field that edits a task (in the list, in the sheet) moves that task at once.
// shortcut: the "#" word must be the last one in the field, upgrade if you want it mid-text.
const pk = $("pk"), nin = $("in");
const hl = Object.assign(document.createElement("ul"), { className: "hl", role: "listbox", hidden: true }); // one popup, moved under whichever field is active
hl.setAttribute("aria-label", "Areas and projects");
let pick = null, hitems = [], hfocus = 0, hostEl = null;
// The sheet's Area box is the same popup as a combobox: no "#", the whole text filters, and focusing it lists everything.
const HASH = "#in, #wtitle, #wlist, .cadd";
const hfield = (e) => e.target.closest?.(HASH);
const hval = (el) => (el.isContentEditable ? el.textContent : el.value);
const hq = (el) => (el.id === "wlist" ? { 2: el.dataset.q ?? "" } : /(^|\s)#([^\s#]*)$/.exec(hval(el)));
function setPick(p) { pick = p; pk.hidden = !p; if (p) pk.textContent = `${p.name} ×`; }
function colPick(add, p) { // the chip under a board column's box
  add.pick = p;
  if (add.nextElementSibling?.classList.contains("pkc")) add.nextElementSibling.remove();
  if (p) add.after(Object.assign(document.createElement("button"), { type: "button", className: "chip pkc", title: "Clear", textContent: `${p.name} ×`, onclick: () => { colPick(add, null); add.focus(); } }));
}
function hdraw() {
  const m = hostEl && hq(hostEl), q = m?.[2].toLowerCase() ?? "";
  hitems = !m ? [] : [...(hostEl.id === "wlist" ? [{ l: "", name: "No area" }] : []), ...meta.lists.flatMap((l) => [{ l: l.id, name: l.name }, ...l.subs.map((s) => ({ l: l.id, s: s.id, name: `${l.name} › ${s.name}` }))])]
    .map((p) => ({ p, s: kscore(p.name, q) })).filter((x) => x.s).sort((a, b) => b.s - a.s).map((x) => x.p);
  hfocus = Math.min(hfocus, Math.max(hitems.length - 1, 0));
  hl.hidden = !hitems.length;
  if (hl.hidden) return;
  const r = hostEl.getBoundingClientRect(), w = Math.min(Math.max(r.width, 220), 360), host = hostEl.closest("dialog") ?? document.body, up = (visualViewport?.height ?? innerHeight) - r.bottom < 260 && r.top > 260; // near the bottom (phone capture bar): open upward // inside the sheet's own layer, or it would sit behind it
  if (hl.parentNode !== host) host.append(hl);
  Object.assign(hl.style, { width: `${w}px`, left: `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`, top: `${up ? r.top - 6 : r.bottom + 6}px`, transform: up ? "translateY(-100%)" : "" });
  hl.replaceChildren(...hitems.map((p, i) => {
    const li = Object.assign(document.createElement("li"), { role: "option", className: i === hfocus ? "on" : "", textContent: p.name });
    li.onpointerdown = (e) => { e.preventDefault(); hpick(p); }; // keep the focus in the field
    return li;
  }));
}
function hpick(p) {
  const el = hostEl, was = hval(el), text = was.replace(/(^|\s)#[^\s#]*$/, "$1").trimEnd();
  hostEl = null; hdraw();
  const v = p.s ? `${p.l}|${p.s}` : p.l;
  if (el.id === "wlist") { edited((t) => setPlace(t, v)); fillWhen(tasks.find((x) => x.id === wid)); }
  else if (el === nin) { nin.value = text; setPick(p); }
  else if (el.classList.contains("cadd")) { el.value = text; colPick(el, p); }
  else if (el.id === "wtitle") { // the sheet saves as you type, so the half-typed "#wo" is in the task now: store the clean title with the new place
    el.value = text;
    edited((t) => { if (text) t.text = text; setPlace(t, v); });
    fillWhen(tasks.find((x) => x.id === wid));
  }
  el.focus();
}
document.addEventListener("input", (e) => { const el = hfield(e); if (el) { hostEl = el; hfocus = 0; if (el.id === "wlist") el.dataset.q = el.value.trim(); hdraw(); } });
document.addEventListener("focusin", (e) => { const el = hfield(e); if (el?.id === "wlist") { el.dataset.q = ""; el.select(); hostEl = el; hfocus = 0; hdraw(); } });
document.addEventListener("focusout", (e) => {
  const el = hfield(e);
  if (!el) return;
  hostEl = null; hdraw();
  if (el.id === "wlist") { const t = tasks.find((x) => x.id === wid); if (t) el.value = placeName(t); } // text typed but not picked is dropped
});
document.addEventListener("keydown", (e) => { // capture: while the popup is open it owns these keys, before the field's own Enter handler adds the task
  const el = hfield(e);
  if (hl.hidden && el?.id === "wlist" && e.key === "ArrowDown") { el.dataset.q = ""; hostEl = el; hfocus = 0; hdraw(); e.preventDefault(); return; }
  if (hl.hidden || el !== hostEl || e.ctrlKey || e.metaKey) return; // Ctrl+Enter is the sheet's Done
  const k = e.key;
  if (k === "ArrowDown" || k === "ArrowUp") hfocus = (hfocus + (k === "ArrowDown" ? 1 : -1) + hitems.length) % hitems.length, hdraw();
  else if (k === "Enter" || k === "Tab") hpick(hitems[hfocus]);
  else if (k === "Escape") { hostEl = null; hdraw(); }
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);
pk.onclick = () => { setPick(null); nin.focus(); };
const newPlace = () => (view === "today" ? { date: today() } : view === "upcoming" ? { date: addDays(today(), 1) } : isArea() ? { l: vArea(), ...(vSub() ? { s: vSub() } : {}) } : {});
// Paste a link anywhere outside a text field: a new task with the link in its notes, and its sheet opens on the title.
addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const url = (e.clipboardData?.getData("text") ?? "").trim();
  if (!/^https?:\/\/\S+$/.test(url)) return;
  e.preventDefault();
  const t = { id: newId(), text: label(url), done: false, u: now(), n: url.slice(0, 5000), ...newPlace() }; // the label stays as the title until you type one: a task is never saved untitled
  tasks.unshift(t); commit(); openWhen(t, true);
  $("wtitle").value = ""; $("wtitle").focus();
});
$("f").onsubmit = (e) => {
  e.preventDefault();
  const typed = $("in").value.trim();
  if (!typed) return;
  const { text, ...when } = parseWhen(typed); // "call Sam tomorrow 3pm" sets the date and time
  const place = newPlace();
  if (pick) { delete place.l; delete place.s; Object.assign(place, { l: pick.l }, pick.s ? { s: pick.s } : {}); } // "#work" beats the tab on screen
  setPick(null);
  tasks.unshift({ id: newId(), text, done: false, u: now(), ...place, ...when }); // the tab on screen decides where a new task lands
  $("in").value = "";
  commit();
};

list.addEventListener("change", (e) => {
  const t = byId(e.target);
  if (e.target.dataset.c) { // a checklist item
    t.c.find((c) => c.id === e.target.dataset.c).done = e.target.checked;
    touch(t); commit();
    return;
  }
  const finish = () => {
    const before = e.target.checked && structuredClone(t); // undo restores the whole task: a repeating one gets its old date and checklist back
    if (e.target.checked && t.rep) { t.date = nextDate(t.date, t.rep, today()); t.c?.forEach((c) => { c.done = false; }); } // repeating: no done state, it moves to its next date with a fresh checklist
    else { t.done = e.target.checked; if (t.done) t.dt = now(); else delete t.dt; }
    touch(t); commit();
    if (before) undoable(t.rep ? "Moved to next date" : "Task completed", () => { const i = tasks.indexOf(t); if (i < 0) return; tasks[i] = before; touch(before); commit(); });
  };
  const li = e.target.closest("li");
  if (!e.target.checked || li.classList.contains("completing") || matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
  // Complete: the box ticks and the text strikes, then the row fades out and closes up, then the change lands.
  li.classList.add("completing");
  setTimeout(() => {
    li.style.maxHeight = `${li.offsetHeight}px`;
    requestAnimationFrame(() => li.classList.add("leaving"));
    setTimeout(finish, 320);
  }, 450);
});
list.addEventListener("click", async (e) => {
  if (e.target.closest("a")) return; // a link in a note opens the link, not the sheet
  if (e.target.closest(".when, .note, .t")) return openWhen(byId(e.target)); // a tap on the text opens the sheet: titles are edited there, not in the list
  if (e.target.classList.contains("area")) return setView(byId(e.target).l, true);
  if (e.target.classList.contains("tc")) { const id = byId(e.target).id; if (!folded.delete(id)) folded.add(id); try { localStorage.setItem(FOLD, JSON.stringify([...folded])); } catch {} return render(); }
  if (!e.target.classList.contains("x")) return;
  const t = byId(e.target);
  const at = tasks.indexOf(t);
  drop(t); tasks = tasks.filter((x) => x !== t); commit();
  undoable("Task deleted", () => { delete meta.tomb[t.id]; touch(t); tasks.splice(Math.min(at, tasks.length), 0, t); commit(); });
});
// Alt+Up/Down moves the focused task or project one place: the keyboard twin of dragging.
const nextTask = (li, up) => { for (let n = up ? li.previousElementSibling : li.nextElementSibling; n; n = up ? n.previousElementSibling : n.nextElementSibling) if (n.dataset.id) return n; };
list.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const up = e.key === "ArrowUp", li = e.target.closest("li");
    if (e.target.classList.contains("t")) {
      e.preventDefault();
      const o = nextTask(li, up);
      if (!o) return;
      moveNear(li.dataset.id, o.dataset.id, up); meta.ou = now(); save(); queue(); render();
      list.querySelector(`li[data-id="${li.dataset.id}"] .t`)?.focus();
    } else if (e.target.classList.contains("hn") && li?.matches(".sub")) {
      e.preventDefault();
      const l = cur(), i = l.subs.findIndex((s) => s.id === li.dataset.sid), j = i + (up ? -1 : 1);
      if (j < 0 || j >= l.subs.length) return;
      [l.subs[i], l.subs[j]] = [l.subs[j], l.subs[i]]; l.u = now(); commit();
      list.querySelector(`li[data-sid="${li.dataset.sid}"] .hn`)?.focus();
    }
    return;
  }
  if (e.key !== "Enter" || !e.target.classList.contains("t")) return;
  e.preventDefault();
  openWhen(byId(e.target));
});
// Date and repeat sheet. Every change applies at once; there is no save button.
// Cancel (and Esc) puts the task back as it was when the sheet opened; a task made by pasting a link is removed. Done, Ctrl+Enter and a click outside keep the edits.
let wid = null, wsnap = null, wnew = false, wdiscard = false;
const wd = $("whend");
function openWhen(t, isNew) { wid = t.id; wsnap = structuredClone(t); wnew = !!isNew; $("wtitle").value = t.text; fillWhen(t); $("wnote").value = t.n ?? ""; fillChecks(t); wd.showModal(); }
function fillWhen(t) {
  $("wdate").value = t.date ?? "";
  $("wtime").value = t.tm ?? "";
  $("runit").value = t.rep?.unit ?? "";
  $("rn").value = t.rep?.n ?? 1;
  $("rmode").value = t.rep?.mode ?? "schedule";
  $("wlistrow").hidden = !meta.lists.length;
  $("wlist").value = placeName(t);
  const td = today(); // the shortcut that matches the task's date shows as pressed
  const on = { today: t.date === td && !t.ev, evening: t.date === td && !!t.ev, tomorrow: t.date === addDays(td, 1), monday: t.date === nextMonday(td), clear: !t.date };
  wd.querySelectorAll("[data-d]").forEach((b) => b.setAttribute("aria-pressed", String(on[b.dataset.d])));
  wd.toggleAttribute("data-never", !t.rep);
  $("rhelp").textContent = t.rep ? (t.rep.mode === "after" ? "The next date counts from the day you complete it." : "Keeps its rhythm. Missed dates are skipped, not stacked.") : "";
}
function applyWhen(date = $("wdate").value, ev) {
  const t = tasks.find((x) => x.id === wid);
  if (!t) return;
  ev ??= !!t.ev;
  const unit = $("runit").value, tm = $("wtime").value, n = Math.min(365, Math.max(1, parseInt($("rn").value, 10) || 1));
  if ((unit || tm) && !date) date = today(); // a repeat or a time needs a date
  if (date) t.date = date; else delete t.date;
  if (date && ev) t.ev = true; else delete t.ev;
  if (date && tm) t.tm = tm; else delete t.tm;
  if (date && unit) t.rep = { n, unit, mode: $("rmode").value }; else delete t.rep;
  touch(t); commit(); fillWhen(t);
}
const WICON = { today: "today", evening: "evening", tomorrow: "tomorrow", monday: "week", clear: "x" };
wd.querySelectorAll("[data-d]").forEach((b) => {
  b.prepend(svg(WICON[b.dataset.d]));
  b.onclick = () => {
    const k = b.dataset.d;
    if (k === "clear") { $("runit").value = ""; $("wtime").value = ""; return applyWhen(""); } // no date also drops the time and the repeat
    applyWhen({ today: today(), evening: today(), tomorrow: addDays(today(), 1), monday: nextMonday(today()) }[k], k === "evening" ? true : k === "today" ? false : undefined); // "Today" clears the evening flag, "Evening" sets it, the others keep it
  };
});
["wdate", "runit", "rn", "rmode"].forEach((id) => ($(id).onchange = () => applyWhen()));
// The time is typed in 24-hour form ("13", "1330", "13:30"): a native time input follows the phone's 12-hour setting.
$("wtime").onchange = () => {
  const s = $("wtime").value.trim(), m = s.match(/^(\d{1,2})(?::?(\d{2}))?$/);
  $("wtime").value = !s ? "" : m && +m[1] < 24 && +(m[2] ?? 0) < 60 ? `${m[1].padStart(2, "0")}:${m[2] ?? "00"}` : tasks.find((x) => x.id === wid)?.tm ?? "";
  applyWhen();
};
$("wtitle").oninput = () => { const v = $("wtitle").value.trim(); if (v) edited((t) => { t.text = v; }); }; // an empty title is not saved: the task keeps its old one
// Notes and checklist. Edits save as you type; there is no save button.
const edited = (fn) => { const t = tasks.find((x) => x.id === wid); if (t) { fn(t); touch(t); commit(); } return t; };
const rmItem = (t, id) => { t.c = t.c.filter((c) => c.id !== id); if (!t.c.length) delete t.c; };
const itemId = (e) => e.target.closest(".ci")?.dataset.c;
function fillChecks(t) {
  $("wchk").replaceChildren(...(t.c ?? []).map((c) => {
    const r = Object.assign(document.createElement("div"), { className: "ci" }), box = Object.assign(document.createElement("input"), { type: "checkbox", checked: c.done }), tx = Object.assign(document.createElement("input"), { type: "text", value: c.text, maxLength: 200 });
    r.dataset.c = c.id;
    box.setAttribute("aria-label", `Done: ${c.text}`); tx.setAttribute("aria-label", "Item");
    r.append(box, tx, ibtn("x", "cx", null, "Delete item"));
    return r;
  }));
}
$("wnote").oninput = () => edited((t) => { if ($("wnote").value.trim()) t.n = $("wnote").value.slice(0, 5000); else delete t.n; });
$("wcadd").onkeydown = (e) => {
  const text = $("wcadd").value.trim();
  if (e.key !== "Enter" || !text) return;
  e.preventDefault();
  fillChecks(edited((t) => { t.c = [...(t.c ?? []), { id: newId(), text: text.slice(0, 200), done: false }].slice(0, 100); }));
  $("wcadd").value = "";
};
$("wchk").onchange = (e) => {
  if (e.target.type === "checkbox") edited((t) => { t.c.find((c) => c.id === itemId(e)).done = e.target.checked; });
  else if (!e.target.value.trim()) fillChecks(edited((t) => rmItem(t, itemId(e)))); // a blanked item is removed
};
$("wchk").oninput = (e) => { if (e.target.type === "text" && e.target.value.trim()) edited((t) => { t.c.find((c) => c.id === itemId(e)).text = e.target.value.trim().slice(0, 200); }); };
$("wchk").onclick = (e) => { if (e.target.classList.contains("cx")) fillChecks(edited((t) => rmItem(t, itemId(e)))); };
$("sadd").onclick = addSub;
$("hadd").onclick = () => { const sa = cur()?.subs.find((s) => s.id === vSub()); if (sa) addHead(sa); };
$("wtclear").onclick = () => { $("wtime").value = ""; applyWhen(); };
$("wclose").onclick = () => wd.close();
$("wcancel").onclick = () => { wdiscard = true; wd.close(); };
wd.addEventListener("cancel", () => { wdiscard = true; }); // Esc
wd.addEventListener("close", () => {
  if (wdiscard) {
    const i = tasks.findIndex((x) => x.id === wid);
    if (i >= 0) { if (wnew) { drop(tasks[i]); tasks.splice(i, 1); } else { tasks[i] = wsnap; touch(wsnap); } commit(); }
  }
  wdiscard = wnew = false;
});
wd.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); wd.close(); } });
// A click outside a sheet closes it. Edits already apply as you make them, so there is nothing to discard.
for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => {
  const r = d.getBoundingClientRect();
  if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
});

$("clear").onclick = async () => { // Done view only: delete every completed task for good
  const n = tasks.filter((t) => t.done).length;
  if (!n || !(await ask({ title: "Delete completed tasks?", text: `${n} tasks go for good.`, ok: "Delete all", danger: true }))) return;
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
  d.sy0 = scrollY;
  d.rows = [...list.children].filter((l) => l.tagName === "LI").map((el) => { const r = el.getBoundingClientRect(); return { el, top: r.top + scrollY, bottom: r.bottom + scrollY }; });
  d.h = d.li.getBoundingClientRect().height;
  getSelection()?.removeAllRanges();
};
list.addEventListener("pointerdown", (e) => {
  const li = e.target.closest("li[data-id]");
  if (view === "board" || view === "all" || !li || li.classList.contains("future") || e.button > 0 || e.target.closest("button, input, a") || e.target.isContentEditable) return;
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
  const d = drag, y = e.clientY + scrollY;
  d.li.style.transform = `translateY(${y - d.y0 - d.sy0}px)`;
  // Hit-test against the rows' resting positions, not their shifted ones, so the shifting cannot feed back into the target.
  const hit = d.rows.find((r) => r.el !== d.li && y >= r.top && y < r.bottom && (r.el.dataset.id || r.el.dataset.hid || r.el.dataset.sid || r.el.dataset.ev));
  d.over = hit?.el ?? null;
  d.before = !!hit?.el.dataset.id && y < (hit.top + hit.bottom) / 2; // a group header takes the task below it
  // The rows between the old and the new slot step aside, so the list shows where the task will land.
  const i = d.rows.findIndex((r) => r.el === d.li), j = hit ? d.rows.indexOf(hit) : -1, k = d.before ? j : j + 1;
  d.rows.forEach((r, n) => {
    if (r.el === d.li) return;
    const s = j < 0 ? 0 : n > i && n < k ? -d.h : n >= k && n < i ? d.h : 0;
    r.el.style.transform = s ? `translateY(${s}px)` : "";
  });
  if (e.clientY < 70) scrollBy(0, -10); else if (e.clientY > innerHeight - 70) scrollBy(0, 10);
});
list.addEventListener("touchmove", (e) => { if (drag?.on) e.preventDefault(); }, { passive: false }); // no page scroll while dragging
// Put task `id` next to `targetId` and let it join that task's group. Shared by pointer drag and the keyboard.
function moveNear(id, targetId, before) {
  const m = tasks.find((x) => x.id === id), o = tasks.find((x) => x.id === targetId);
  if (isArea()) { for (const k of ["s", "h"]) if (o?.[k]) m[k] = o[k]; else delete m[k]; touch(m); } // next to a task: join its project and heading
  else if (view === "today") { if (o?.ev) m.ev = true; else delete m.ev; touch(m); } // ...or its group, Today or evening
  tasks = move(tasks, id, targetId, before);
}
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
    const m = tasks.find((x) => x.id === d.id), { hid, sid, hs, ev } = d.over.dataset;
    if (hid || sid || ev) { // let go on a subarea, a heading or "This Evening": first task under it
      if (sid) { m.s = sid; delete m.h; } else if (hid) { m.h = hid; if (hs) m.s = hs; else delete m.s; } else m.ev = true;
      touch(m); tasks = [m, ...tasks.filter((x) => x !== m)];
    } else {
      moveNear(d.id, d.over.dataset.id, d.before);
    }
    meta.ou = now(); save(); queue();
  }
  render();
};
list.addEventListener("pointerup", endDrag);
list.addEventListener("pointercancel", endDrag);

// Drag a project or heading header to reorder: its headings (for a project) and tasks travel with it; a heading stays within its project. Same gestures as tasks: mouse after 5px, touch after a hold.
const blockOf = (h) => { // a project's rows: its header, then everything up to the next project or a plain section like "Upcoming"; a heading's: up to the next header
  const out = [h], sub = h.matches(".sub");
  for (let n = h.nextElementSibling; n && !(sub ? n.matches("li.sec.sub") || (n.matches("li.sec") && !n.matches(".head, .ups")) : n.matches("li.sec")); n = n.nextElementSibling) out.push(n);
  return out;
};
list.addEventListener("pointerdown", (e) => {
  const h = e.target.closest("li.sec.sub, li.sec.head");
  if (!h || e.button > 0 || e.target.closest(".hc, .ha, .hx")) return;
  const sel = h.matches(".sub") ? "li.sec.sub" : `li.sec.head[data-hs="${h.dataset.hs}"]`; // the siblings it can swap with
  const touch = e.pointerType !== "mouse", x0 = e.clientX, y0 = e.clientY;
  let on = false, timer, eat;
  const start = () => { on = true; h.classList.add("drag"); h.setPointerCapture(e.pointerId); navigator.vibrate?.(8); getSelection()?.removeAllRanges(); };
  const block = (ev) => { if (on) ev.preventDefault(); };
  const move = (m) => {
    if (!on) {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      if (touch) return stop(); // a scroll
      start();
    }
    for (const o of list.querySelectorAll(sel)) {
      const r = o.getBoundingClientRect();
      if (o === h || m.clientY < r.top || m.clientY > r.bottom) continue;
      const mine = blockOf(h), theirs = blockOf(o);
      if (h.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING) theirs.at(-1).after(...mine); else o.before(...mine);
      break;
    }
    if (m.clientY < 70) scrollBy(0, -10); else if (m.clientY > innerHeight - 70) scrollBy(0, 10);
  };
  const stop = () => {
    clearTimeout(timer);
    for (const [ev, f] of [["pointermove", move], ["pointerup", stop], ["pointercancel", stop]]) removeEventListener(ev, f);
    removeEventListener("touchmove", block);
    if (!on) return;
    h.classList.remove("drag");
    eat = (c) => c.stopPropagation(); addEventListener("click", eat, true); setTimeout(() => removeEventListener("click", eat, true), 0); // a drag must not also rename
    const l = cur(), isSub = h.matches(".sub"), group = isSub ? l?.subs : l?.subs.find((s) => s.id === h.dataset.hs)?.heads;
    const ids = [...list.querySelectorAll(sel)].map((o) => (isSub ? o.dataset.sid : o.dataset.hid));
    if (group && ids.join() !== group.map((s) => s.id).join()) {
      const re = ids.map((id) => group.find((s) => s.id === id));
      if (isSub) l.subs = re; else l.subs.find((s) => s.id === h.dataset.hs).heads = re;
      l.u = now(); commit();
    }
  };
  addEventListener("pointermove", move); addEventListener("pointerup", stop); addEventListener("pointercancel", stop); addEventListener("touchmove", block, { passive: false });
  if (touch) timer = setTimeout(start, 300);
});

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
    if (!(await ask({ title: "Replace your tasks?", text: `Your ${tasks.length} tasks become the ${next.length} in this file.`, ok: "Replace", danger: true }))) return;
    for (const l of parseLists(text)) meta.lists = [...meta.lists.filter((x) => x.id !== l.id), { ...l, u: now() }]; // a re-import brings the file's structure
    tasks.filter((t) => !next.some((n) => n.id === t.id)).forEach(drop);
    tasks = next.map((t) => ({ ...t, u: now() })); meta.ou = now(); commit();
  } catch { ask({ title: "Can't import", text: "That file isn't a Tasks backup.", cancel: false }); }
};

// Theme: head script sets the first value from the system; this toggles and persists it.
const THEME_BG = { light: "#f1f4fa", dark: "#2b2f3c" };
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
const LASTSYNC = "braindump.lastsync"; // per device
let code = null, timer = 0, running = false, lastSync = 0;
try { lastSync = +localStorage.getItem(LASTSYNC) || 0; } catch {}
try { code = localStorage.getItem(SYNC); } catch {}
const side = () => ({ tasks, tomb: meta.tomb, ou: meta.ou, lists: meta.lists });
const busy = () => drag || document.activeElement?.isContentEditable;
const LABEL = { off: "", syncing: "Syncing…", ok: "", offline: "Offline", error: "Sync failed" };
const stamp = (ms) => new Date(ms).toLocaleString([], new Date(ms).toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); // today: just the time
function setStatus(s, detail = "") {
  if (s === "ok") { lastSync = now(); try { localStorage.setItem(LASTSYNC, String(lastSync)); } catch {} }
  $("lastsync").textContent = s === "ok" ? `Last synced: ${stamp(lastSync)}` : s === "off" ? "" : LABEL[s];
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
    await pullCaptures().catch((e) => console.error("inbox failed", e)); // never fails the sync
  } catch (e) { console.error("sync failed", e); setStatus("error", e?.message ?? String(e)); } finally {
    running = false;
    if (code && sig(side()) !== start) queue(500);
  }
}

// Quick capture: text posted to the Worker inbox becomes an Inbox task. A bare link is the notes, titled by its host; other text is the title, extra lines the notes.
// The item id is the task id, so a pull that is not acknowledged (offline) adds nothing twice.
async function pullCaptures() {
  const items = await pullInbox(code);
  if (!items.length) return;
  const fresh = items.filter((i) => !tasks.some((t) => t.id === i.id));
  for (const i of fresh.reverse()) {
    const s = i.text.trim(), link = /^https?:\/\/\S+$/.test(s), [first, ...rest] = s.split("\n"), n = link ? s : rest.join("\n").trim();
    tasks.unshift({ id: i.id, text: (link ? label(s) : first).slice(0, 500), done: false, u: now(), date: today(), ...(n ? { n: n.slice(0, 5000) } : {}) }); // due today, so a capture shows up in Today until you file it
  }
  if (fresh.length) commit();
  await ackInbox(code, items.length);
}
$("capc").onclick = async (e) => {
  try { $("capv").value = await captureUrl(code); $("capv").hidden = false; $("capv").select(); copy($("capv").value, e.target); }
  catch (err) { $("st").textContent = `Capture URL failed: ${err.message}`; }
};

function setCode(c) {
  if (remOn && c !== code) disableReminders(code); // reminders belong to one sync code
  code = c;
  try { c ? localStorage.setItem(SYNC, c) : localStorage.removeItem(SYNC); } catch {}
  showDialog();
  if (c) runSync(); else setStatus("off");
}

function showDialog() {
  $("offv").hidden = !!code;
  $("onv").hidden = !code;
  $("codev").value = code ?? "";
  $("remb").textContent = remOn ? "Turn off reminders" : "Turn on reminders";
  $("remt").hidden = !remOn;
}
// ---- Reminders ----
// Web Push: the Worker's cron job pushes at the due time and the service worker shows it, so the app can be closed.
// This device uploads its subscription and the timed tasks due in the next 14 days; see sync.js.
// The notification shows the task as its title, the time and place as its line, and opens the task's area or project on tap.
const remInfo = (t) => {
  const l = meta.lists.find((x) => x.id === t.l), sa = l && subOf(l, t);
  return { c: [t.tm, l && [l.name, sa?.name].filter(Boolean).join(" › ")].filter(Boolean).join(" · "), v: l ? (sa ? `${l.id}|${sa.id}` : l.id) : "today" };
};
const dueList = () => tasks.filter((t) => !t.done && t.date && t.tm).map((t) => ({ k: t.id, at: new Date(`${t.date}T${t.tm}`).getTime(), t: t.text, ...remInfo(t) })).filter((r) => r.at > now() && r.at < now() + 14 * 864e5).sort((a, b) => a.at - b.at).slice(0, 100);
const remSay = (s) => { $("remst").textContent = s; };
const keep = (key) => new Promise((res, rej) => { // the service worker reads the data key from here to decrypt a push
  const r = indexedDB.open("braindump", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("k");
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const tx = r.result.transaction("k", "readwrite"); tx.objectStore("k").put(key, "key"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
});
function remQueue(ms = 2000) {
  if (!remOn || !code) return;
  clearTimeout(remTimer);
  remTimer = setTimeout(() => pushReminders().catch((e) => { console.error("reminders failed", e); remSay(`Reminders failed: ${e.message}`); }), ms);
}
// The browser can lose its push subscription (cleared site data, expired); subscribe again, the permission is already granted.
async function pushSub() {
  const pm = (await navigator.serviceWorker.ready).pushManager;
  return (await pm.getSubscription()) ?? pm.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
}
async function pushReminders(list = dueList()) {
  const s = JSON.stringify(list.map((r) => [r.k, r.at, r.t, r.c, r.v]));
  if (s === remSent) return;
  const sub = await pushSub();
  await keep(await putReminders(code, sub.toJSON(), list));
  remSent = s;
}
async function enableReminders() {
  if (!code) return remSay("Turn on sync first: reminders use it.");
  if (!navigator.serviceWorker || !("PushManager" in window)) return remSay("This browser can't do push. On iPhone, open the app from the Home Screen icon.");
  try {
    if ((await Notification.requestPermission()) !== "granted") return remSay("Notifications are blocked. Allow them in the system settings.");
    await pushSub();
    remOn = true; remSent = "";
    try { localStorage.setItem(REM, "1"); } catch {}
    await pushReminders();
    remSay("Reminders are on.");
  } catch (e) { remSay(`Could not turn on reminders: ${e.message}`); }
  showDialog();
}
async function disableReminders(old = code) {
  remOn = false; remSent = "";
  try { localStorage.removeItem(REM); } catch {}
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) { if (old) await putReminders(old, sub.toJSON(), [], true).catch(() => {}); await sub.unsubscribe(); }
  } catch {}
  remSay(""); showDialog();
}
$("remb").onclick = () => (remOn ? disableReminders() : enableReminders());
$("remt").onclick = async () => { // one reminder in 5 seconds; the cron job sends it within a minute
  try {
    if (Notification.permission !== "granted") throw new Error("notifications are not allowed; turn reminders off and on");
    const sub = await pushSub();
    await keep(await putReminders(code, sub.toJSON(), [{ k: "test", at: now() + 5000, t: "Test reminder", c: "It works ✓" }]));
    remSent = "";
    remSay("Test sent. It arrives within a minute.");
  } catch (e) { remSay(`Test failed: ${e.message}`); }
};
const copy = (text, btn) => navigator.clipboard?.writeText(text).then(() => { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1500); });
const link = () => `${location.origin}${location.pathname}#sync=${code}`;

$("gear").onclick = () => { showDialog(); $("dlg").showModal(); };
$("refresh").onclick = () => (code ? runSync() : $("gear").click()); // sync off: open the settings to turn it on
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
$("offb").onclick = async () => { if (await ask({ title: "Turn off sync?", text: "Your tasks here stay. The synced copy stays on the server.", ok: "Turn off", danger: true })) setCode(null); };

// Save the data key on every start, not only when reminders go on: a push can arrive before they are switched on again.
if (code) derive(code).then((d) => keep(d.raw)).catch(() => {});
// A reinstalled app has no saved data key or reminder flag, yet its push subscription can live on: the service worker then cannot read a push
// and shows "A task is due". Spotting the subscription turns reminders back on, which saves the key again.
if (code && navigator.serviceWorker && "PushManager" in window) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((sub) => {
  if (!sub || remOn || Notification.permission !== "granted") return;
  remOn = true; try { localStorage.setItem(REM, "1"); } catch {}
  remQueue(500);
}).catch(() => {});
// Tapping a reminder opens its area or project: a running app gets a message, a closed one a ?view= link.
const goto = (v) => { if (v) setView(v); };
navigator.serviceWorker?.addEventListener("message", (e) => goto(e.data?.view));
const openView = new URLSearchParams(location.search).get("view");
if (openView) { history.replaceState(null, "", location.pathname + location.hash); goto(openView); }

// A #sync=<code> link joins this device. Confirm first: a link from someone else would upload your tasks to their list.
const joinHash = location.hash.match(/^#sync=([A-Za-z0-9_-]{22})$/);
if (joinHash) {
  history.replaceState(null, "", location.pathname + location.search); // the code is a secret, keep it out of the URL bar
  if (joinHash[1] !== code) ask({ title: "Join shared list?", text: "Your tasks here merge into the shared list from that link.", ok: "Join" }).then((yes) => { if (yes) setCode(joinHash[1]); });
}

const dueAt = (t) => new Date(`${t.date}T${t.tm}`).getTime();
const rollover = () => { // a new day, or a reminder time that passed since the last draw: redraw so the bell and time go
  const passed = tasks.some((t) => t.tm && t.date && !t.done && dueAt(t) > drawn && dueAt(t) <= now());
  if ((today() !== day || passed) && !busy() && !wd.open) render();
};
addEventListener("online", () => queue(500));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { rollover(); queue(300); } });
setInterval(() => { if (document.visibilityState === "visible") { rollover(); queue(0); } }, 60000); // pick up changes from other devices while the app stays open
queue(300);
// Ctrl+K (Cmd+K): jump to a view, area or project. Type to filter, arrows and Enter to pick, Esc to close.
const kd = $("kbar"), kq = $("kq"), kl = $("kl");
let kitems = [], kfocus = 0;
const kscore = (name, q) => { // 0 = no match; a prefix beats a word start, which beats letters in order
  const n = name.toLowerCase();
  if (!q) return 1;
  if (n.startsWith(q)) return 4;
  if (n.split(/[\s›]+/).some((w) => w.startsWith(q))) return 3;
  if (n.includes(q)) return 2;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
};
function kdraw() {
  const q = kq.value.trim().toLowerCase();
  const all = [["inbox", "Inbox", "inbox"], ["today", "Today", "today"], ["upcoming", "Upcoming", "upcoming"], ["all", "Anytime", "all"], ["board", "Board", "board"], ["done", "Done", "done"],
    ...meta.lists.flatMap((l) => [[l.id, l.name, "area"], ...l.subs.map((s) => [`${l.id}|${s.id}`, `${l.name} › ${s.name}`, "area"])])];
  kitems = all.map((x) => ({ x, s: kscore(x[1], q) })).filter((m) => m.s).sort((a, b) => b.s - a.s).map((m) => m.x); // sort is stable: equal scores keep sidebar order
  if (q) kitems.push(...tasks.filter((t) => t.text.toLowerCase().includes(q)).sort((a, b) => a.done - b.done || b.u - a.u).slice(0, 8).map((t) => [`task:${t.id}`, t.text, t.done ? "done" : "task", t.done ? "Done" : placeOf(t).l?.name ?? "Inbox"])); // tasks only once you type; open ones first, newest first
  kfocus = Math.min(kfocus, Math.max(kitems.length - 1, 0));
  kl.replaceChildren(...kitems.map(([id, name, ic, hint], i) => {
    const li = Object.assign(document.createElement("li"), { role: "option", className: i === kfocus ? "on" : "" });
    li.setAttribute("aria-selected", String(i === kfocus));
    li.append(svg(ic), Object.assign(document.createElement("span"), { textContent: name }));
    if (id === view || hint) li.append(Object.assign(document.createElement("em"), { textContent: hint ?? "here" }));
    li.onpointermove = () => { if (kfocus !== i) { kfocus = i; kdraw(); } };
    li.onclick = () => kgo(id);
    return li;
  }));
  if (!kitems.length) kl.append(Object.assign(document.createElement("li"), { className: "none", textContent: "Nothing matches" }));
  kl.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function kgo(id) {
  kd.close();
  document.body.classList.remove("menu");
  const t = id.startsWith("task:") && tasks.find((x) => x.id === id.slice(5));
  if (!t) return setView(id);
  if (!t.done) folded.delete(`all:${areaOf(t) || "inbox"}`); // an open task: show it in Everything, with its group open
  setView(t.done ? "done" : "all");
  const li = list.querySelector(`li[data-id="${t.id}"]`);
  li?.scrollIntoView({ block: "center" });
  li?.classList.add("hit");
}
kq.oninput = () => { kfocus = 0; kdraw(); };
kq.onkeydown = (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (kitems.length) { kfocus = (kfocus + (e.key === "ArrowDown" ? 1 : -1) + kitems.length) % kitems.length; kdraw(); }
  } else if (e.key === "Enter" && kitems[kfocus]) { e.preventDefault(); kgo(kitems[kfocus][0]); }
};
kd.addEventListener("pointerdown", (e) => { if (e.target === kd) kd.close(); }); // a tap outside the box
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (kd.open) return kd.close();
    kopen();
  }
  $("fab").onclick = () => { scrollTo({ top: 0 }); $("in").focus(); }; // inside the tap, so the phone opens the keyboard
const go = { Digit1: "inbox", Digit2: "today" }[e.code];
  if (go && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !document.querySelector("dialog[open]")) { e.preventDefault(); setView(go); }
});
function kopen() {
  if (document.querySelector("dialog[open]")) return; // not on top of another dialog
  kq.value = ""; kfocus = 0; kdraw(); kd.showModal(); kq.focus();
}
$("jump").onclick = kopen;
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
