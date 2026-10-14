# opencode-github-copilot-usage

An [OpenCode](https://opencode.ai) V2 plugin that shows your GitHub Copilot usage, in AI credits and percentage, right in the TUI.

```
Copilot 30,890/40,000 cr · 77.6%
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

To try a local checkout, point OpenCode at the directory:

```jsonc
{
  "plugins": ["D:/path/to/opencode-github-copilot-usage"],
}
```

## License

MIT
