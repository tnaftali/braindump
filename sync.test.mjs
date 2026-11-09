import test from "node:test";
import assert from "node:assert/strict";
import { merge, normalize } from "./logic.js";
import { newCode, parseCode, derive, encrypt, decrypt, sync, API } from "./sync.js";
import worker from "./worker/index.js";

const T = (id, u, extra = {}) => ({ id, text: id, done: false, u, ...extra });
const S = (tasks, tomb = {}, ou = 0) => ({ tasks, tomb, ou });
const ids = (s) => s.tasks.map((t) => t.id).join("");

test("merge: newest edit wins per task, both new tasks survive", () => {
  const a = S([T("x", 5, { text: "new" }), T("a", 1)]);
  const b = S([T("x", 3, { text: "old" }), T("b", 2)]);
  const m = merge(a, b);
  assert.equal(m.tasks.find((t) => t.id === "x").text, "new");
  assert.deepEqual(ids(m).split("").sort(), ["a", "b", "x"]);
});

test("merge: delete beats an older edit, a newer edit beats the delete", () => {
  const gone = merge(S([T("x", 2)]), S([], { x: 5 }));
  assert.equal(gone.tasks.length, 0);
  const back = merge(S([T("x", 9)]), S([], { x: 5 }));
  assert.equal(back.tasks.length, 1);
});

test("merge: newer ou sets the order, unknown tasks go on top", () => {
  const a = S([T("1", 1), T("2", 1), T("3", 1)], {}, 10);
  const b = S([T("n", 1), T("3", 1), T("2", 1), T("1", 1)], {}, 5);
  assert.equal(ids(merge(a, b)), "n123");
  assert.equal(ids(merge(b, a)), "n123"); // same result from either side
});

test("normalize: drops malformed tasks and tombstones", () => {
  const s = normalize({ tasks: [{ id: "a", text: "ok" }, { id: 1, text: "x" }, null, { id: "b", text: " " }], tomb: { a: "x", b: 3 } });
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(s.tomb, { b: 3 });
  assert.equal(s.ou, 0);
});

test("code: 22 chars, parses from a link, rejects junk", () => {
  const c = newCode();
  assert.equal(c.length, 22);
  assert.equal(parseCode(`https://x.github.io/braindump/#sync=${c}`), c);
  assert.equal(parseCode(" " + c + " "), c);
  assert.equal(parseCode("short"), null);
});

test("crypto: round trip, wrong key fails", async () => {
  const a = await derive(newCode()), b = await derive(newCode());
  const text = await encrypt(a.key, { hi: "there" });
  assert.deepEqual(await decrypt(a.key, text), { hi: "there" });
  await assert.rejects(decrypt(b.key, text));
});

// Two devices talk to the real Worker code through an in-memory KV.
function fakeWorker() {
  const kv = new Map();
  const env = {
    BLOBS: {
      async getWithMetadata(k) { const e = kv.get(k); return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null }; },
      async put(k, value, { metadata }) { kv.set(k, { value, metadata }); },
    },
  };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  return kv;
}

test("two devices converge through the Worker", async () => {
  const kv = fakeWorker();
  const code = newCode();
  let phone = S([T("p", 1)]);
  let laptop = S([T("l", 2)]);
  phone = await sync(code, phone);         // creates the blob
  laptop = await sync(code, laptop);       // merges
  phone = await sync(code, phone);         // sees the laptop task
  assert.deepEqual(ids(phone).split("").sort(), ["l", "p"]);
  assert.equal(ids(phone).length, 2);
  laptop = { ...laptop, tasks: [], tomb: { ...laptop.tomb, l: 9, p: 9 } }; // laptop deletes both
  laptop = await sync(code, laptop);
  phone = await sync(code, phone);
  assert.equal(phone.tasks.length, 0);
  assert.equal(kv.size, 1);
  for (const { value } of kv.values()) assert.ok(!value.includes("\"p\""), "stored blob is not plaintext");
});

test("Worker: bad path 404, stale If-Match 412, oversize 413", async () => {
  fakeWorker();
  const key = "a".repeat(64), w = { "X-Write-Key": "b".repeat(64) };
  assert.equal((await fetch(API + "nope")).status, 404);
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "x" })).status, 204);
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "y" })).status, 412);
  assert.equal((await fetch(API + key, { method: "PUT", headers: w, body: "z".repeat(300 * 1024) })).status, 413);
});

test("Worker: weak ETag (W/\"1\", as Cloudflare sends after compression) still matches", async () => {
  fakeWorker();
  const key = "d".repeat(64), w = { "X-Write-Key": "b".repeat(64) };
  await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "x" });
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": 'W/"1"' }, body: "y" })).status, 204);
});

test("Worker: writes need the write key the first PUT stored", async () => {
  fakeWorker();
  const key = "c".repeat(64);
  const put = (w) => fetch(API + key, { method: "PUT", headers: w ? { "X-Write-Key": w } : {}, body: "x" });
  assert.equal((await put(null)).status, 401);
  assert.equal((await put("d".repeat(64))).status, 204);
  assert.equal((await put("e".repeat(64))).status, 403); // someone who only knows the address
  assert.equal((await put("d".repeat(64))).status, 204);
  assert.equal((await fetch(API + key)).status, 200); // reads stay open to anyone with the address
});
