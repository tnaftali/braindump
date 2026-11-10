// Web Push sender: RFC 8291 (aes128gcm payload) and RFC 8292 (VAPID). WebCrypto only, so it runs in a Worker and in Node.
const enc = new TextEncoder();

export const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// Encrypt `text` for one subscription ({ keys: { p256dh, auth } }). `as` (key pair) and `salt` are random unless a test pins them.
export async function encryptPayload(sub, text, { as, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  as ??= await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(text), Uint8Array.of(2)))); // 0x02 ends the last record
  return cat(salt, Uint8Array.of(0, 0, 0x10, 0, asPub.length), asPub, ct); // header: salt, record size 4096, key length, sender key
}

// The public key the browser subscribes with: the uncompressed point (0x04, x, y) of the private JWK.
export const publicKey = (jwk) => b64u(cat(Uint8Array.of(4), unb64u(jwk.x), unb64u(jwk.y)));

async function vapid(endpoint, jwk, subject) {
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const seg = (o) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${seg({ typ: "JWT", alg: "ES256" })}.${seg({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned))); // raw r||s, as JWT wants
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey(jwk)}`;
}

// POST one message. Returns the HTTP status: 201 sent, 404 or 410 the subscription is gone.
export async function sendPush(sub, text, jwk, subject = "https://tnaftali.github.io/tasks/") {
  return (await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high", Authorization: await vapid(sub.endpoint, jwk, subject) },
    body: await encryptPayload(sub, text),
  })).status;
}
