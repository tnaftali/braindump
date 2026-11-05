// Sync client. The sync code is the secret: its hash is the blob's address, another hash is the AES-GCM
// key. The server only ever sees an address and encrypted bytes.
import { merge, normalize, sig } from "./logic.js";

export const API = "https://braindump-sync.tobias-naftali-337.workers.dev/b/";
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
  const hex = async (s) => [...(await sha(s))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", await sha("key:" + code), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id: await hex("id:" + code), wk: await hex("w:" + code), key };
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
