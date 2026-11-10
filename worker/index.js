// Dumb encrypted-blob store. The client hashes its sync code to get the key and encrypts the
// body, so the server sees only opaque bytes. GET/PUT /b/<64 hex>. ETag = version counter.
import { sendPush } from "./push.js";

const ORIGINS = ["https://tnaftali.github.io", "http://localhost:8000", "http://localhost:8731"];
const MAX = 256 * 1024;
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/; // the Worker POSTs to a client-supplied URL, so only real push services
const LATE = 3600e3; // a reminder this far past due is not worth sending

// Reminders: `p:<id>` holds { subs: { endpoint: sub }, rem: [{ k, at, b }] }; `idx` maps id -> the earliest due time, so the cron job reads one key.
// `b` is the title, encrypted by the client: the server sees times only. shortcut: idx is read-modify-write, so two racing writers can lose an entry; the next upload restores it.
const getJSON = async (env, k) => JSON.parse((await env.BLOBS.get(k)) ?? "{}");
async function setNext(env, id, rem) {
  const idx = await getJSON(env, "idx");
  if (rem.length) idx[id] = Math.min(...rem.map((r) => r.at)); else delete idx[id];
  await env.BLOBS.put("idx", JSON.stringify(idx));
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "If-Match, Content-Type, X-Write-Key",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...cors, ...extra } });

    if (req.method === "OPTIONS") return reply(null, 204);
    const pm = new URL(req.url).pathname.match(/^\/p\/([0-9a-f]{64})$/);
    if (pm) { // PUT /p/<id>: this device's push subscription and the reminders due, replacing the old list
      if (req.method !== "PUT") return reply("method not allowed", 405);
      const id = pm[1], { metadata } = await env.BLOBS.getWithMetadata(id);
      if (!metadata?.w || metadata.w !== req.headers.get("X-Write-Key")) return reply("forbidden", 403); // only someone who holds the sync code
      const text = await req.text();
      if (text.length > 64 * 1024) return reply("too large", 413);
      let j;
      try { j = JSON.parse(text); } catch { return reply("bad json", 400); }
      const { endpoint, keys } = j.sub ?? {};
      let host = "";
      try { const u = new URL(endpoint); host = u.protocol === "https:" ? u.hostname : ""; } catch {}
      if (!PUSH_HOSTS.test(host) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return reply("bad subscription", 400);
      const cur = await getJSON(env, "p:" + id), subs = cur.subs ?? {};
      if (j.off) delete subs[endpoint]; else subs[endpoint] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
      const rem = j.off || !Array.isArray(j.rem) ? [] : j.rem.filter((r) => typeof r?.k === "string" && Number.isFinite(r.at) && typeof r.b === "string").slice(0, 100).map((r) => ({ k: r.k.slice(0, 64), at: r.at, b: r.b.slice(0, 2000) }));
      if (Object.keys(subs).length) await env.BLOBS.put("p:" + id, JSON.stringify({ subs, rem })); else await env.BLOBS.delete("p:" + id);
      await setNext(env, id, Object.keys(subs).length ? rem : []);
      return reply(null, 204);
    }
    const m = new URL(req.url).pathname.match(/^\/b\/([0-9a-f]{64})$/);
    if (!m) return reply("not found", 404);
    const key = m[1];

    if (req.method === "GET") {
      const { value, metadata } = await env.BLOBS.getWithMetadata(key);
      if (value === null) return reply("not found", 404);
      return reply(value, 200, { ETag: `"${metadata?.v ?? 0}"`, "Content-Type": "text/plain" });
    }

    if (req.method === "PUT") {
      // The address (key) is not enough to write: the first PUT stores a hash-derived write key, later PUTs must repeat it.
      const w = req.headers.get("X-Write-Key") ?? "";
      if (!/^[0-9a-f]{64}$/.test(w)) return reply("write key required", 401);
      if (Number(req.headers.get("Content-Length")) > MAX) return reply("too large", 413);
      const body = await req.text();
      if (body.length > MAX) return reply("too large", 413);
      const { metadata } = await env.BLOBS.getWithMetadata(key);
      if (metadata?.w && metadata.w !== w) return reply("forbidden", 403);
      const cur = metadata?.v ?? 0;
      const want = req.headers.get("If-Match"); // shortcut: KV has no atomic CAS, so a race can slip through; the client merges on the next sync
      // Cloudflare turns the ETag weak (W/"1") when it compresses the body, so accept both forms.
      if (want !== null && want.replace(/^W\//, "") !== `"${cur}"`) return reply("conflict", 412, { ETag: `"${cur}"` });
      await env.BLOBS.put(key, body, { metadata: { v: cur + 1, w } });
      return reply(null, 204, { ETag: `"${cur + 1}"` });
    }

    return reply("method not allowed", 405);
  },

  // Cron, every minute: send the reminders that came due.
  async scheduled(_event, env) {
    if (!env.VAPID_JWK) return console.warn("VAPID_JWK is not set; no reminders sent");
    const jwk = JSON.parse(env.VAPID_JWK), now = Date.now(), idx = await getJSON(env, "idx");
    for (const id of Object.keys(idx).filter((i) => idx[i] <= now)) {
      const rec = await getJSON(env, "p:" + id), subs = rec.subs ?? {}, rem = rec.rem ?? [];
      for (const r of rem.filter((x) => x.at <= now && now - x.at < LATE)) {
        for (const [ep, sub] of Object.entries(subs)) {
          const status = await sendPush(sub, JSON.stringify({ k: r.k, b: r.b }), jwk).catch(() => 0);
          if (status === 404 || status === 410) delete subs[ep]; // the device unsubscribed
        }
      }
      const rest = rem.filter((r) => r.at > now);
      if (Object.keys(subs).length) await env.BLOBS.put("p:" + id, JSON.stringify({ subs, rem: rest })); else await env.BLOBS.delete("p:" + id);
      await setNext(env, id, Object.keys(subs).length ? rest : []);
    }
  },
};
