# Brain Dump

A quick-capture task list that lives on your phone. Offline, private, no account.

Type a thought, press Enter, done. Paste a URL (a PR, a doc) and it becomes a chip. Drag `⋮⋮` to reorder. Tap the circle to finish a task.

**Open the app:** https://tnaftali.github.io/braindump/

## Install

- **iPhone:** open the link in Safari, then Share → Add to Home Screen.
- **Android:** open it in Chrome, then Install app.
- **Desktop Chrome/Edge:** use the install icon in the address bar.

## Your data

Tasks stay in your browser (`localStorage`). Nothing is sent anywhere. The browser can wipe this storage, and it does not sync between devices. Use **Export** and **Import** at the bottom of the list for backups and moving devices.

## Develop

Plain HTML, CSS and JavaScript. No build step, no dependencies.

```sh
python3 -m http.server 8000   # http://localhost:8000
node --test                   # logic tests
```

GitHub Pages deploys `main` as-is. After you change app files, bump `VERSION` in `sw.js` so installed copies drop the old cache. Without a bump, a change shows up on the second launch.
