# Paseo plugins

Personal Paseo plugins, organized as one package directory per plugin. Each plugin contains its own `paseo-plugin.json`, runtime entries, `OVERVIEW.md`, source and tests.

| Plugin | Purpose | Git install source |
| --- | --- | --- |
| [File Bridge](./file-bridge) | Windows ↔ SSH server files, one active desktop worker | `github:klin02/paseo-plugins:file-bridge` |

## Install

In **Settings → Plugins** on the intended daemon, add the Git source shown above. Install File Bridge on both the Windows local daemon and its Linux coordinator. The plugin backend runs on that daemon's machine.

CLI equivalent:

```sh
paseo plugin install github:klin02/paseo-plugins:file-bridge
```

Use `paseo plugin update file-bridge` to fetch later versions. Local checkout installation also works: `paseo plugin install /absolute/path/to/paseo-plugins/file-bridge`. No npm install or build step is needed for Git installation; helper assets are checked in and the daemon compiles the plugin entries.

## Develop

```sh
npm install
npm run typecheck
npm test
```

The repository uses npm workspaces without a build framework. See each plugin's README for platform requirements and verification boundaries.
