import test from "node:test";
import assert from "node:assert/strict";
import { parseWhen } from "./nl.js";

const NOW = new Date(2026, 10, 10, 15, 0); // Tue 10 Nov 2026, 15:00 local
const p = (s) => parseWhen(s, NOW);

test("parseWhen: relative days", () => {
  assert.deepEqual(p("call Sam tomorrow"), { text: "call Sam", date: "2026-11-11" });
  assert.deepEqual(p("pay rent today"), { text: "pay rent", date: "2026-11-10" });
  assert.deepEqual(p("plan in 3 days"), { text: "plan", date: "2026-11-13" });
  assert.deepEqual(p("review next week"), { text: "review", date: "2026-11-16" });
});

test("parseWhen: weekdays are always in the future", () => {
  assert.deepEqual(p("gym fri"), { text: "gym", date: "2026-11-13" });
  assert.deepEqual(p("gym on next tuesday"), { text: "gym", date: "2026-11-17" });
});

test("parseWhen: month and day, rolling to next year when past", () => {
  assert.deepEqual(p("flight 12 dec"), { text: "flight", date: "2026-12-12" });
  assert.deepEqual(p("tax Jan 5th"), { text: "tax", date: "2027-01-05" });
  assert.deepEqual(p("x 31 feb"), { text: "x 31 feb" });
});

test("parseWhen: times, in either order with the date", () => {
  assert.deepEqual(p("call mom tomorrow at 3pm"), { text: "call mom", date: "2026-11-11", tm: "15:00" });
  assert.deepEqual(p("call mom 9:30am tomorrow"), { text: "call mom", date: "2026-11-11", tm: "09:30" });
  assert.deepEqual(p("lunch fri 12pm"), { text: "lunch", date: "2026-11-13", tm: "12:00" });
  assert.deepEqual(p("standup 14:45"), { text: "standup", date: "2026-11-11", tm: "14:45" }); // 14:45 is before now (15:00)
  assert.deepEqual(p("dinner 18:00"), { text: "dinner", date: "2026-11-10", tm: "18:00" });
  assert.deepEqual(p("x 25:00"), { text: "x 25:00" });
});

test("parseWhen: evening and relative time", () => {
  assert.deepEqual(p("read tonight"), { text: "read", date: "2026-11-10", ev: true });
  assert.deepEqual(p("stretch in 2 hours"), { text: "stretch", date: "2026-11-10", tm: "17:00" });
});

test("parseWhen: leaves plain text alone", () => {
  assert.deepEqual(p("buy milk"), { text: "buy milk" });
  assert.deepEqual(p("tomorrow"), { text: "tomorrow" }); // nothing would be left of the task
  assert.deepEqual(p("may the force"), { text: "may the force" });
});
