import test from "node:test";
import assert from "node:assert/strict";
import { addDays, addInterval, nextDate, nextMonday, normalize, parseBackup, sig, today, whenLabel } from "./logic.js";

test("addInterval: days, weeks, months, years, month-end clamp, leap day", () => {
  assert.equal(addInterval("2026-11-05", 3, "day"), "2026-11-08");
  assert.equal(addInterval("2026-12-30", 1, "week"), "2027-01-06");
  assert.equal(addInterval("2026-01-31", 1, "month"), "2026-02-28");
  assert.equal(addInterval("2026-11-30", 3, "month"), "2027-02-28");
  assert.equal(addInterval("2028-02-29", 1, "year"), "2029-02-28");
});

test("nextDate schedule: keeps rhythm, skips every missed slot", () => {
  const rep = { n: 1, unit: "week", mode: "schedule" };
  assert.equal(nextDate("2026-11-02", rep, "2026-11-02"), "2026-11-09"); // done on the day
  assert.equal(nextDate("2026-11-02", rep, "2026-11-25"), "2026-11-30"); // 3 weeks late: one next date
  assert.equal(nextDate("2026-11-20", rep, "2026-11-05"), "2026-11-27"); // done early: next slot after the due date
});

test("nextDate after: counts from today", () => {
  assert.equal(nextDate("2026-10-01", { n: 2, unit: "week", mode: "after" }, "2026-11-05"), "2026-11-19");
});

test("nextMonday is always in the future", () => {
  assert.equal(nextMonday("2026-11-05"), "2026-11-09"); // Thu
  assert.equal(nextMonday("2026-11-09"), "2026-11-16"); // Mon
  assert.equal(nextMonday("2026-11-08"), "2026-11-09"); // Sun
});

test("whenLabel: overdue reads Today, no warning", () => {
  const now = "2026-11-05";
  assert.equal(whenLabel({}, now), "");
  assert.equal(whenLabel({ date: "2026-01-01" }, now), "Today");
  assert.equal(whenLabel({ date: "2026-11-06" }, now), "Tomorrow");
  assert.equal(whenLabel({ date: "2026-11-10", rep: { n: 1, unit: "week", mode: "schedule" } }, now), "↻ Tue 10 Nov");
});

test("today(): local day string", () => {
  assert.equal(today(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
  assert.equal(addDays("2026-11-05", 0), "2026-11-05");
});

test("normalize and parseBackup keep valid date/rep, drop bad ones", () => {
  const rep = { n: 2, unit: "week", mode: "after" };
  const raw = [
    { id: "a", text: "ok", date: "2026-11-10", rep },
    { id: "b", text: "bad date", date: "2026-02-31", rep },
    { id: "c", text: "bad rep", date: "2026-11-10", rep: { n: 0, unit: "year", mode: "after" } },
    { id: "d", text: "rep no date", rep },
  ];
  const t = normalize({ tasks: raw }).tasks;
  assert.deepEqual([t[0].date, t[0].rep], ["2026-11-10", rep]);
  assert.equal(t[1].date, undefined);
  assert.equal(t[1].rep, undefined);
  assert.equal(t[2].rep, undefined);
  assert.equal(t[3].rep, undefined);
  assert.deepEqual(parseBackup(JSON.stringify(raw))[0].rep, rep);
});

test("sig changes when date or rep changes", () => {
  const side = (date) => ({ tasks: [{ id: "a", text: "x", done: false, u: 1, date }], tomb: {}, ou: 0 });
  assert.notEqual(sig(side("2026-11-10")), sig(side("2026-11-11")));
});

import { merge, parseLists } from "./logic.js";

test("lists: newest rename wins, union, tombstone removes", () => {
  const side = (lists, tomb = {}) => ({ tasks: [], tomb, ou: 0, lists });
  const a = side([{ id: "h", name: "Home", u: 1 }]);
  const b = side([{ id: "h", name: "House", u: 5 }, { id: "i", name: "Ideas", u: 2 }]);
  assert.deepEqual(merge(a, b).lists.map((l) => l.name), ["House", "Ideas"]);
  const gone = side([], { i: 9 });
  assert.deepEqual(merge(b, gone).lists.map((l) => l.id), ["h"]);
});

test("lists: normalize cleans, tasks keep l, parseLists reads an export", () => {
  const n = normalize({ tasks: [{ id: "a", text: "x", l: "h" }], lists: [{ id: "h", name: "  Home " }, { id: "h", name: "dup" }, { name: "no id" }, { id: "z", name: " " }] });
  assert.deepEqual(n.lists, [{ id: "h", name: "Home", u: 0, heads: [] }]);
  assert.equal(n.tasks[0].l, "h");
  assert.deepEqual(parseLists(JSON.stringify({ lists: [{ id: "q", name: "Q", u: 3 }] })), [{ id: "q", name: "Q", u: 3, heads: [] }]);
  assert.deepEqual(parseLists("nope"), []);
});

test("headings and completion time survive normalize; heading needs an area", () => {
  const n = normalize({
    tasks: [{ id: "a", text: "x", l: "h", h: "k", done: true, dt: 5 }, { id: "b", text: "y", h: "k", dt: 5 }],
    lists: [{ id: "h", name: "Home", heads: [{ id: "k", name: " Taxes " }, { id: "k", name: "dup" }, { name: "no id" }] }],
  });
  assert.deepEqual(n.lists[0].heads, [{ id: "k", name: "Taxes" }]);
  assert.deepEqual([n.tasks[0].h, n.tasks[0].dt], ["k", 5]);
  assert.deepEqual([n.tasks[1].h, n.tasks[1].dt], [undefined, undefined]); // no area, not done
});
