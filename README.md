# Tasks

A quick-capture task list that lives on your phone. Offline, private, no account.

Type a thought, press Enter, done. Paste a URL (a PR, a doc) and it becomes a chip. Drag `⋮⋮` to reorder. Tap the circle to finish a task.

**Open the app:** https://tnaftali.github.io/braindump/

## Install

- **iPhone:** open the link in Safari, then Share → Add to Home Screen.
- **Android:** open it in Chrome, then Install app.
- **Desktop Chrome/Edge:** use the install icon in the address bar.

## Your data

Tasks stay in your browser (`localStorage`). Nothing leaves the device unless you turn on sync. The browser can wipe this storage, so use **Export** and **Import** at the bottom of the list for backups.

## Sync (optional)

Tap **Sync** → **Turn on sync**. The app makes a random 128-bit sync code. On your other device, open the link from **Copy link**, or paste the code under Sync → Join.

- The code is the secret. Its hash is the address of your data, and another hash is the AES-GCM key. The server stores only encrypted bytes and cannot read your tasks.
- Anyone with the code can read and edit your tasks. There is no recovery: lose every device and the code, lose the synced copy.
- Merge: the newest edit wins per task, deletes are remembered for 90 days, and a reorder from the device that reordered last wins. Device clocks decide "newest".
- Backend: a Cloudflare Worker with one KV namespace (`worker/`). Free plan: 1,000 writes and 100,000 reads a day. Over the limit, sync fails and the app keeps working locally.

Deploy the Worker yourself: `cd worker && npx wrangler kv namespace create BLOBS`, put the id in `wrangler.toml`, then `npx wrangler deploy`. Set `API` in `sync.js` to your Worker URL and add your Pages origin to `ORIGINS` in `worker/index.js`.

## Reminders (optional)

Give a task a date and a time. Type it ("call Sam tomorrow 3pm") or use the time picker in the task sheet. With reminders on, the phone gets a notification at that time, even with the app closed. They need sync, and on iPhone the app must be opened from its Home Screen icon.

- Sync dialog → **Turn on reminders**. **Send a test** checks the whole path.
- The Worker sends a Web Push from a cron job that runs every minute. It learns the due times only: each title is encrypted with your data key, and the service worker decrypts it on the phone.
- One-time setup: `cd worker && node vapid-keys.mjs`, paste the printed public key into `VAPID_PUBLIC` in `sync.js`, then `npx wrangler secret put VAPID_JWK < .vapid.jwk` and `npx wrangler deploy`. `.vapid.jwk` is git-ignored: keep it private.

## Develop

Plain HTML, CSS and JavaScript. No build step, no dependencies.

```sh
python3 -m http.server 8000   # http://localhost:8000
node --test                   # logic, merge, crypto and Worker tests
```

GitHub Pages deploys `main` as-is. After you change app files, bump `VERSION` in `sw.js` so installed copies drop the old cache. Without a bump, a change shows up on the second launch.
