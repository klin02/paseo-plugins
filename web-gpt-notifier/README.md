# Web GPT Notifier

Show ChatGPT task activity in Paseo Desktop, send native completion notifications, and optionally publish completion notices to ntfy. No agent prompts, OpenAI API key, or changes to Paseo or another notifier plugin are needed.

## Install

```sh
paseo plugin install github:klin02/paseo-plugins:web-gpt-notifier
```

Install on the daemon your Desktop is connected to. Its client contribution runs on Desktop; its server contribution publishes to ntfy from that daemon. Desktop and daemon can each be Paseo 0.14.x or 0.15.x. No npm install or build step is required for Git installation.

Native Desktop notifications and task activity work with no ntfy topic. Allow Paseo notifications in your operating system. To enable ntfy too, open **Settings → Web GPT Notifier**, enter the server, topic, and optional token, save, and send a test notice. These values are stored only in the host's local Paseo settings. The source intentionally ships with an empty topic. Do not add real destinations, tokens, local settings, or production logs to this repository.

Open ChatGPT in Paseo's built-in browser. Monitoring starts automatically while the plugin is loaded. The **Web GPT** sidebar item shows conversation names and task states; running tasks spin and completed replies show a green check. When no reply is running, the sidebar shows a green check with the completed count and workspace headers show a green check for completed replies. Starting a reply updates activity without a notification; native and ntfy notices are sent only after the reply completes. Each workspace with a local ChatGPT tab gets a **GPT** header indicator and running count. Click a task or a native notification to return to its original tab. The settings screen shows desktop presence and the number of ChatGPT tabs detected. Computer receivers can subscribe at their ntfy server's web app or install its PWA.

## Detection and delivery

Activity and native notifications belong to the computer/window observing each task. Two computers connected to the same daemon monitor their own browser tabs; native notices are emitted locally and ntfy completion IDs are deduplicated by the shared daemon. Activity is kept in client memory and closing a tab removes its row. A completed historical page starts as idle after reload.

The client supports both current `data-conversation-role` message containers and older message/turn attributes. The client reads only `https://chatgpt.com` webviews in its own Desktop window, including resident inactive panes. A first completed page establishes a baseline. A captured submission followed by a changed message, or observed generation, arms the monitor; it waits for generation to stop and the latest answer to remain unchanged for 1.8 seconds. Manual stop clicks and visible generation errors suppress success. Navigation resets the baseline, except when a new chat acquires its conversation URL.

The browser returns message identifiers and hashes, not prompt or reply text. The daemon receives a completion ID, conversation title and URL, then publishes a fixed notice with a link to that conversation. It retries transient errors and stores the newest 1,000 delivered IDs under `$PASEO_HOME/plugin-data/web-gpt-notifier/` (default `~/.paseo/plugin-data/web-gpt-notifier/`). Topic and token are not stored in the delivery file. Ambiguous HTTP failures may result in duplicate notices.

The plugin borrows Paseo 0.14/0.15's native notification, browser focus, workspace-tab selector, and resident `webview[data-paseo-browser-id]` interface and native `getURL` / `executeJavaScript` methods. These are internal desktop interfaces; recheck it before widening the version range. The resident webview and plugin evaluation implementations are identical in the official 0.14.0 and 0.15.0 tags. No external browser extension is installed. Closing Desktop stops monitoring; frozen pages and background window timer throttling can delay detection. The stability check needs two observations after generation ends, so a throttled window can report completion later than an active one. DOM heuristics cannot prove server-side success and can miss a complete generation/regeneration occurring entirely between observations without a visible prompt change.

The detection design is informed by [ChatGPT Response Complete Notifier](https://github.com/ramhaidar/ChatGPT-Response-Complete-Notifier), with independent implementation for Paseo and direct ntfy delivery.

## Develop

```sh
npm install
npm run typecheck --workspace @klin02/paseo-web-gpt-notifier
npm test --workspace @klin02/paseo-web-gpt-notifier
```

Tests cover task states, workspace indicators, themes, compact layouts, original-tab navigation, native notification deduplication, ntfy stalls and later turns. They execute the guest snapshot script against DOM fixtures, simulate resident and frozen webviews, and exercise ntfy delivery against a local HTTP server. They are separate from validation on a logged-in ChatGPT page in a real Desktop client.
