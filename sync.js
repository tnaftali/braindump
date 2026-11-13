// Sync client. The sync code is the secret: its hash is the blob's address, another hash is the AES-GCM
// key. The server only ever sees an address and encrypted bytes.
import { merge, normalize, sig } from "./logic.js";

export const API = "https://task-capture.tobias-naftali-337.workers.dev/b/";
export const PUSH_API = API.replace(/b\/$/, "p/");
export const VAPID_PUBLIC = "BM1hN6UAO61NsXgvAaIJwOVho1CCDvJ0RO9gBrfllkDNmONowgG0GYwd3chTCa9uzZAyMM2xaGd_6v7MxZKD1us"; // the Worker holds the private half (VAPID_JWK)
const enc = new TextEncoder();

const b64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

// 128 random bits as 22 URL-safe characters.
export const newCode = () => b64(crypto.getRandomValues(new Uint8Array(16))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const validCode = (c) => /^[A-Za-z0-9_-]{22}$/.test(c);
// Accepts a bare code or a link with #sync=<code>.
export const parseCode = (s) => {
  const c = s.trim().replace(/^.*#sync=/, "");
  return validCode(c) ? c : null;
};

// Three unrelated hashes of the code: the address, the write key and the encryption key.
// Knowing the address (all the server and its logs see) reveals neither of the others.
export async function derive(code) {
  if (!globalThis.crypto?.subtle) throw new Error("encryption needs HTTPS or localhost");
  const hex = async (s) => [...(await sha(s))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = await sha("key:" + code), key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id: await hex("id:" + code), wk: await hex("w:" + code), ck: await hex("c:" + code), key, raw };
}

// Quick capture: the Worker keeps an inbox. A Shortcut, bookmarklet or curl POSTs text to the capture URL (its own key, which cannot read or write the tasks); the app pulls the inbox on sync.
export const INBOX_API = API.replace(/b\/$/, "i/");
export async function captureUrl(code) {
  const { id, wk, ck } = await derive(code);
  const res = await fetch(INBOX_API + id, { method: "PUT", headers: { "X-Write-Key": wk }, body: ck });
  if (res.status !== 204) throw new Error(`capture ${res.status}`);
  return `${INBOX_API}${id}?k=${ck}`;
}
export async function pullInbox(code) { // [{ id, text }]
  const { id, wk } = await derive(code);
  const res = await fetch(INBOX_API + id, { headers: { "X-Write-Key": wk }, cache: "no-store" });
  if (res.status !== 200) throw new Error(`inbox ${res.status}`);
  return res.json();
}
export async function ackInbox(code, n) {
  const { id, wk } = await derive(code);
  await fetch(`${INBOX_API}${id}?n=${n}`, { method: "DELETE", headers: { "X-Write-Key": wk } });
}

export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64(out);
}

export async function decrypt(key, text) {
  const raw = unb64(text);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) }, key, raw.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Reminders: send this device's push subscription and the reminders due soon ([{ k: task id, at: ms, t: title }]).
// The server learns the times only: each title is encrypted with the data key. Returns the raw key bytes: the service worker needs them to read a push, and iOS Safari is unreliable at storing a CryptoKey.
export async function putReminders(code, sub, rem, off = false) {
  const { id, wk, key, raw } = await derive(code);
  const body = JSON.stringify({ sub, off, rem: await Promise.all(rem.map(async (r) => ({ k: r.k, at: r.at, b: await encrypt(key, { t: r.t.slice(0, 140), c: r.c?.slice(0, 140), v: r.v?.slice(0, 80) }) }))) });
  const res = await fetch(PUSH_API + id, { method: "PUT", headers: { "X-Write-Key": wk }, body });
  if (res.status !== 204) throw new Error(`reminders ${res.status}`);
  return raw;
}

// Pull, merge, push if the merge changed anything. Returns the merged side. Throws on failure.
// A 412 means another device pushed first, so pull again and redo the merge.
export async function sync(code, local) {
  const { id, wk, key } = await derive(code);
  for (let i = 0; i < 3; i++) {
    const res = await fetch(API + id, { cache: "no-store" });
    let etag = '"0"', remote = null;
    if (res.status === 200) {
      etag = res.headers.get("ETag");
      remote = normalize(await decrypt(key, await res.text()));
    } else if (res.status !== 404) throw new Error(`GET ${res.status}`);
    const state = remote ? merge(local, remote) : local;
    if (remote && sig(state) === sig(remote)) return state;
    const put = await fetch(API + id, { method: "PUT", headers: { "If-Match": etag, "X-Write-Key": wk }, body: await encrypt(key, state) });
    if (put.status === 204) return state;
    if (put.status !== 412) throw new Error(`PUT ${put.status}`);
  }
  throw new Error("busy");
}
