import { linkify, move, newId, parseBackup } from "./logic.js";

const KEY = "braindump.tasks";
const $ = (id) => document.getElementById(id);
const list = $("list");

// shortcut: localStorage only, no sync between devices; use Export/Import to move data
let tasks = load();

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
  try { localStorage.setItem(KEY, JSON.stringify(tasks)); } catch { alert("Couldn't save. Export a backup."); }
}
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
  tasks.unshift({ id: newId(), text, done: false });
  $("in").value = "";
  save(); render();
};

list.addEventListener("change", (e) => { byId(e.target).done = e.target.checked; save(); render(); });
list.addEventListener("click", (e) => {
  if (e.target.classList.contains("t") && !e.target.isContentEditable) return edit(e.target);
  if (!e.target.classList.contains("x")) return;
  tasks = tasks.filter((t) => t !== byId(e.target)); save(); render();
});
list.addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("t") || !e.target.isContentEditable) return;
  const t = byId(e.target), text = e.target.textContent.trim();
  if (text) t.text = text; else tasks = tasks.filter((x) => x !== t);
  save(); render();
});
list.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("t")) return;
  e.preventDefault();
  if (e.target.isContentEditable) { e.target.blur(); $("in").focus(); } else edit(e.target);
});
$("clear").onclick = () => { tasks = tasks.filter((t) => !t.done); save(); render(); };

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
  if (e.type === "pointerup" && drag.over) { tasks = move(tasks, drag.id, drag.over.dataset.id, drag.before); save(); }
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
    tasks = next; save(); render();
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
  if (e.key !== KEY || document.activeElement?.isContentEditable) return;
  tasks = load(); render();
});
addEventListener("keydown", (e) => {
  const a = document.activeElement;
  if (e.key === "/" && !/INPUT|TEXTAREA/.test(a.tagName) && !a.isContentEditable) { e.preventDefault(); $("in").focus(); }
});

render();
navigator.storage?.persist?.().catch(() => {});
navigator.serviceWorker?.register("sw.js").catch(() => {}); // needs HTTPS or localhost
