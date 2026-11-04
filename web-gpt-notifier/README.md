# Web GPT Notifier

Send ntfy completion notices for ChatGPT conversations open in Paseo Desktop. No agent prompts, OpenAI API key, or changes to Paseo or another notifier plugin are needed.

## Install

```sh
paseo plugin install github:klin02/paseo-plugins:web-gpt-notifier
```

Install on the daemon your Desktop is connected to. Its client contribution runs on Desktop; its server contribution publishes to ntfy from that daemon. Both must be Paseo 0.14.x. No npm install or build step is required for Git installation.

Open **Settings → Web GPT Notifier**, enter the ntfy server, topic, and optional token, save, and send a test notice. These values are stored only in the host's local Paseo settings. The source intentionally ships with an empty topic. Do not add real destinations, tokens, local settings, or production logs to this repository.

Open ChatGPT in Paseo's built-in browser. Monitoring starts automatically while the plugin is loaded. The settings screen shows desktop presence and the number of ChatGPT tabs detected. Computer receivers can subscribe at their ntfy server's web app or install its PWA.

## Detection and delivery

The client reads only `https://chatgpt.com` webviews in its own Desktop window, including resident inactive panes. A first completed page establishes a baseline. A captured submission followed by a changed message, or observed generation, arms the monitor; it waits for generation to stop and the latest answer to remain unchanged for 1.8 seconds. Manual stop clicks and visible generation errors suppress success. Navigation resets the baseline, except when a new chat acquires its conversation URL.

The browser returns message identifiers and hashes, not prompt or reply text. The daemon receives a completion ID, conversation title and URL, then publishes a fixed notice with a link to that conversation. It retries transient errors and stores the newest 1,000 delivered IDs under `$PASEO_HOME/plugin-data/web-gpt-notifier/` (default `~/.paseo/plugin-data/web-gpt-notifier/`). Topic and token are not stored in the delivery file. Ambiguous HTTP failures may result in duplicate notices.

The plugin borrows Paseo 0.14's resident `webview[data-paseo-browser-id]` interface and native `getURL` / `executeJavaScript` methods. This is an internal desktop interface; recheck it before widening the version range. No external browser extension is installed. Closing Desktop stops monitoring; frozen pages can delay their own detection. DOM heuristics cannot prove server-side success and can miss a complete generation/regeneration occurring entirely between observations without a visible prompt change.

The detection design is informed by [ChatGPT Response Complete Notifier](https://github.com/ramhaidar/ChatGPT-Response-Complete-Notifier), with independent implementation for Paseo and direct ntfy delivery.

## Develop

```sh
npm install
npm run typecheck --workspace @klin02/paseo-web-gpt-notifier
npm test --workspace @klin02/paseo-web-gpt-notifier
```

Tests execute the guest snapshot script against DOM fixtures, simulate resident and frozen webviews, and exercise ntfy delivery against a local HTTP server. They are separate from validation on a logged-in ChatGPT page in a real Desktop client.
