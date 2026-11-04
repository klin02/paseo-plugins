Web GPT Notifier monitors ChatGPT replies in Paseo's desktop browser and sends completion notices to ntfy. Computer and phone subscribers can receive the same notice. It does not use a coding agent or call an AI API.

Open the plugin's settings on the connected host, enter your ntfy server and topic, and save. An access token is optional for servers that require one. The destination and token are stored in that host's local Paseo settings; they are not included in the plugin source. Use the test action to check delivery.

Requires Paseo Desktop and daemon 0.14.x or 0.15.x. Keep Desktop running with the ChatGPT tabs open. Resident tabs in other workspaces of the same window are monitored too. External Chrome or Edge tabs, unopened conversations, and mobile browsers are outside its monitoring scope.

The plugin observes generation controls and waits for the answer to stop changing. Existing completed history is ignored. Manual stops and visible generation errors suppress success notices. This is a page-based heuristic, so ChatGPT interface changes can require an update. It uses an internal Paseo desktop webview interface and limits compatibility to 0.14.x and 0.15.x.

Only the conversation title, link, and a fixed completion message are sent through the host to ntfy. Reply text is hashed inside the browser page and is not forwarded. A bounded local list of delivered identifiers prevents repeat notices across clients and restarts. Transient delivery failures are retried; a lost HTTP acknowledgement can still cause a duplicate. The plugin shows monitor presence and delivery status in its settings.
