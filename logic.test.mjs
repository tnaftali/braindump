import test from "node:test";
import assert from "node:assert/strict";
import { label, linkify, move, parseBackup } from "./logic.js";

test("label: GitHub PR and issue shorten to owner/repo#n", () => {
  assert.equal(label("https://github.com/acme/app/pull/42"), "acme/app#42");
  assert.equal(label("https://github.com/acme/app/issues/7"), "acme/app#7");
});

test("label: other URLs show host and path", () => {
  assert.equal(label("https://www.example.com/a/b"), "example.com/a/b");
  assert.equal(label("https://example.com/"), "example.com");
});

test("linkify: splits text and drops trailing punctuation", () => {
  assert.deepEqual(linkify("review https://github.com/a/b/pull/1."), [
    { text: "review " },
    { url: "https://github.com/a/b/pull/1", text: "a/b#1" },
    { text: "." },
  ]);
});

test("linkify: ignores non-http schemes", () => {
  assert.deepEqual(linkify("javascript:alert(1)"), [{ text: "javascript:alert(1)" }]);
});

const L = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (l) => l.map((t) => t.id).join("");

test("move: before and after the target", () => {
  assert.equal(ids(move(L, "a", "c", true)), "bacd");
  assert.equal(ids(move(L, "a", "c", false)), "bcad");
  assert.equal(ids(move(L, "d", "a", true)), "dabc");
});

test("move: self, unknown ids and input stay untouched", () => {
  assert.equal(move(L, "a", "a", true), L);
  assert.equal(move(L, "x", "a", true), L);
  assert.equal(ids(L), "abcd");
});

test("parseBackup: file, bare array, numeric ids, duplicates, junk", () => {
  const t = parseBackup(JSON.stringify({ tasks: [{ id: 1, text: " x ", done: true }, { id: 1, text: "y" }, { text: "" }, null, { text: 5 }] }));
  assert.equal(t.length, 2);
  assert.equal(t[0].id, "1");
  assert.equal(t[0].text, "x");
  assert.equal(t[0].done, true);
  assert.notEqual(t[1].id, "1");
  assert.equal(parseBackup('[{"text":"z"}]').length, 1);
});

test("parseBackup: rejects non-task data", () => {
  assert.throws(() => parseBackup("{}"));
  assert.throws(() => parseBackup("nope"));
});

test("parseBackup: keeps notes, checklist and evening flag; ignores bad ones", () => {
  const [a, b] = parseBackup(JSON.stringify([
    { id: "a", text: "x", date: "2026-11-10", ev: true, n: "note", c: [{ id: "1", text: "one", done: true }, { id: "1", text: "dup" }, { id: "2", text: " " }] },
    { id: "b", text: "y", ev: true, n: "  ", c: "nope" }, // ev needs a date
  ]));
  assert.deepEqual([a.ev, a.n, a.c], [true, "note", [{ id: "1", text: "one", done: true }]]);
  assert.deepEqual([b.ev, b.n, b.c], [undefined, undefined, undefined]);
});
