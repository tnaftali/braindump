// One-off: make the VAPID key pair for push reminders.
//   node vapid-keys.mjs          writes .vapid.jwk (the private key, git-ignored) and prints the public key
// Then: npx wrangler secret put VAPID_JWK < .vapid.jwk     and paste the public key into VAPID_PUBLIC in ../sync.js
import { writeFileSync } from "node:fs";
import { publicKey } from "./push.js";

const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
writeFileSync(new URL("./.vapid.jwk", import.meta.url), JSON.stringify(jwk), { mode: 0o600 });
console.log("public key:", publicKey(jwk));
