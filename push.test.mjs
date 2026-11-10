import test from "node:test";
import assert from "node:assert/strict";
import { b64u, unb64u, encryptPayload, publicKey } from "./worker/push.js";
import worker from "./worker/index.js";

// RFC 8291 appendix A: the sender's key and salt are pinned, so the output must match the RFC byte for byte.
test("encryptPayload: matches the RFC 8291 example", async () => {
  const asPub = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33)) };
  const as = {
    publicKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw" }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
  };
  const sub = { keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
  const out = await encryptPayload(sub, "When I grow up, I want to be a watermelon", { as, salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw") });
  const header = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const cipher = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"; // separate base64 strings: 86 bytes is not a multiple of 3
  const want = [...unb64u(header), ...unb64u(cipher)];
  assert.deepEqual([...out], want);
});

// A Worker with an in-memory KV and a fake push service.
async function setup() {
  const kv = new Map(), pushed = [];
  const env = {
    BLOBS: {
      async getWithMetadata(k) { const e = kv.get(k); return { value: e?.value ?? null, metadata: e?.metadata ?? null }; },
      async get(k) { return kv.get(k)?.value ?? null; },
      async put(k, value, o) { kv.set(k, { value, metadata: o?.metadata }); },
      async delete(k) { kv.delete(k); },
    },
  };
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  env.VAPID_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
  globalThis.fetch = async (url, init) => { pushed.push({ url, init }); return new Response(null, { status: 201 }); };
  const id = "a".repeat(64), wk = "b".repeat(64);
  kv.set(id, { value: "blob", metadata: { v: 1, w: wk } });
  const put = (body, key = wk, path = id) => worker.fetch(new Request(`https://w/p/${path}`, { method: "PUT", headers: { "X-Write-Key": key }, body: JSON.stringify(body) }), env);
  return { env, kv, pushed, sub, put, id };
}

test("Worker /p: needs the write key and a real push host", async () => {
  const { put, sub } = await setup();
  assert.equal((await put({ sub, rem: [] }, "c".repeat(64))).status, 403);
  assert.equal((await put({ sub: { ...sub, endpoint: "https://evil.example/x" }, rem: [] })).status, 400);
  assert.equal((await put({ sub: { ...sub, endpoint: "http://fcm.googleapis.com/x" }, rem: [] })).status, 400);
  assert.equal((await put({ sub, rem: [] })).status, 204);
});

test("Worker cron: sends due reminders once, keeps future ones", async () => {
  const { env, put, sub, pushed, kv, id } = await setup();
  const t = Date.now();
  await put({ sub, rem: [{ k: "t1", at: t - 1000, b: "x" }, { k: "t2", at: t + 3600e3, b: "y" }] });
  assert.equal(JSON.parse(kv.get("idx").value)[id], t - 1000);
  await worker.scheduled({}, env);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].url, sub.endpoint);
  assert.match(pushed[0].init.headers.Authorization, /^vapid t=.+, k=.+$/);
  await worker.scheduled({}, env);
  assert.equal(pushed.length, 1); // t1 is gone, t2 is not due
  assert.equal(JSON.parse(kv.get("p:" + id).value).rem.length, 1);
});

test("Worker cron: a reminder far past due is skipped; a gone subscription is removed", async () => {
  const { env, put, sub, pushed, kv, id } = await setup();
  await put({ sub, rem: [{ k: "old", at: Date.now() - 2 * 3600e3, b: "x" }] });
  await worker.scheduled({}, env);
  assert.equal(pushed.length, 0);
  await put({ sub, rem: [{ k: "t", at: Date.now() - 1000, b: "x" }] });
  globalThis.fetch = async () => new Response(null, { status: 410 });
  await worker.scheduled({}, env);
  assert.equal(kv.has("p:" + id), false);
  assert.equal(JSON.parse(kv.get("idx").value)[id], undefined);
});

test("publicKey: uncompressed P-256 point, 65 bytes", async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  assert.equal(unb64u(publicKey(await crypto.subtle.exportKey("jwk", privateKey))).length, 65);
});
