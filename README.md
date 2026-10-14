# opencode-github-copilot-usage

An [OpenCode](https://opencode.ai) V2 plugin that shows your GitHub Copilot usage, in AI credits and percentage, right in the TUI.

```
Copilot 2,000/15,000 cr · 13.3%
```

## Features

- Usage line below the prompt footer, shown only while a GitHub Copilot model is selected.
- Colour changes as you approach your limit: muted below 75%, warning from 75%, error from 90%.
- Refreshes every 15 seconds and shortly after each completed turn.
- `/copilot` slash command (also in the command palette) with full details: account, plan, billing type, used/remaining, overage, and reset date.
- Uses the GitHub Copilot login already stored in OpenCode. No extra token needed. GitHub Enterprise logins are supported.

## Requirements

- OpenCode V2 (tested with `2.0.28`), or OpenCode V1 `1.18.29` or newer.
- GitHub Copilot connected in OpenCode.

## Install

### OpenCode V2

```sh
opencode plugin add opencode-github-copilot-usage
```

Or add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-github-copilot-usage"],
}
```

### OpenCode V1

```sh
opencode plugin opencode-github-copilot-usage --global
```

Or add it to `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["opencode-github-copilot-usage"]
}
```

On V1 the plugin runs only in the TUI. It reads the Copilot login from OpenCode's `auth.json` and calls GitHub directly. The usage line appears at the bottom of a session when that session's latest message used a GitHub Copilot model.

## Options

V2 (`opencode.jsonc`):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-github-copilot-usage",
      "options": {
        // Poll interval in seconds (minimum 5, default 15)
        "interval": 15,
      },
    },
  ],
}
```

V1 (`tui.json`):

```json
{
  "plugin": [["opencode-github-copilot-usage", { "interval": 15 }]]
}
```

## How it works

- **V2:** the server plugin resolves the active `github-copilot` credential and calls `GET https://api.github.com/copilot_internal/user`, then exposes the parsed result through an RPC (`copilot-usage.get`). The TUI plugin polls that RPC and renders the footer line and the `/copilot` dialog.
- **V1:** the `./tui` entry exports a V1 `tui` function next to the V2 `setup`. It reads the GitHub token from `auth.json` and calls the same endpoint itself.

> [!NOTE]
> `copilot_internal/user` is an undocumented GitHub endpoint and may change without notice. Figures can lag slightly behind actual usage.

## Development

```sh
npm install
npm run typecheck
```

To test a local checkout, uninstall the npm package first. Both register the same plugin ID.

### OpenCode V2

A config path such as `"plugins": ["D:/path/to/checkout"]` is not loaded, and OpenCode doesn't follow symlinks or junctions in the plugins folder. Instead, create a small loader folder in the global plugins directory:

```text
~/.config/opencode/plugins/copilot-usage-dev/
├── package.json
├── index.ts
└── tui.ts
```

`package.json`:

```json
{
  "name": "copilot-usage-dev",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./tui": "./tui.ts"
  }
}
```

`index.ts`:

```ts
export { default } from "/absolute/path/to/opencode-github-copilot-usage/src/index.ts"
```

`tui.ts`:

```ts
export { default } from "/absolute/path/to/opencode-github-copilot-usage/src/tui.tsx"
```

On Windows, use a drive path such as `D:/development/opencode-github-copilot-usage/src/index.ts`.

OpenCode doesn't watch the checkout. After editing, run `opencode service restart` and reopen the TUI. Restarting the service also stops running sessions.

Check that the plugin loaded:

```sh
opencode api get /api/plugin
opencode api post /api/rpc/copilot-usage/get --data '{"input":{"refresh":true}}'
```

In Git Bash on Windows, prefix these with `MSYS_NO_PATHCONV=1` so the API paths aren't rewritten.

When you're done, delete the loader folder and reinstall the package:

```sh
rm -rf ~/.config/opencode/plugins/copilot-usage-dev
opencode plugin add opencode-github-copilot-usage
```

### OpenCode V1

Point `~/.config/opencode/tui.json` at the TUI file directly:

```json
{
  "plugin": ["/absolute/path/to/opencode-github-copilot-usage/src/tui.tsx"]
}
```

## Releasing

Releases follow [semver](https://semver.org). While on `0.x`, fixes bump the patch version and new features or breaking changes bump the minor version. Breaking changes include renamed options, a changed plugin ID or RPC shape, and dropped OpenCode version support.

```sh
npm version patch          # or minor; runs typecheck, commits, and tags vX.Y.Z
git push --follow-tags
```

Pushing the tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml). It checks the tag matches `package.json`, type-checks, stages the package on npm through trusted publishing, and creates a GitHub release. Approve the staged package on npmjs.com to make it public.

Pre-releases (`npm version prerelease --preid beta`) are staged under the `beta` dist-tag, so `latest` is unchanged.

## License

MIT
