// Dumb encrypted-blob store. The client hashes its sync code to get the key and encrypts the
// body, so the server sees only opaque bytes. GET/PUT /b/<64 hex>. ETag = version counter.
const ORIGINS = ["https://tnaftali.github.io", "http://localhost:8000", "http://localhost:8731"];
const MAX = 256 * 1024;

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
      if (want !== null && want !== `"${cur}"`) return reply("conflict", 412, { ETag: `"${cur}"` });
      await env.BLOBS.put(key, body, { metadata: { v: cur + 1, w } });
      return reply(null, 204, { ETag: `"${cur + 1}"` });
    }

    return reply("method not allowed", 405);
  },
};
