# ytmtui

YouTube Music in your terminal — a TUI built with [OpenTUI](https://opentui.com/), plus an agent-friendly CLI.

Search via the YouTube Data API v3 (API key only, no sign-in), playback via `mpv` (audio-only). macOS media keys / Now Playing work out of the box through mpv.

## Requirements

- [Bun](https://bun.sh)
- `mpv` and `yt-dlp` (`brew install mpv yt-dlp`)
- A [YouTube Data API v3 key](https://console.cloud.google.com/apis/credentials), exported as `YTMTUI_API_KEY` (or `YT_API_KEY`)

## Install

```bash
bun install
bun link   # optional: makes `ytmtui` available globally
```

## Usage

```bash
ytmtui                          # interactive TUI
ytmtui -q "daft punk" -n 5      # search, print results table
ytmtui search "lofi beats" --json   # machine-readable output for agents/LLMs
ytmtui play "never gonna give you up"   # search and play first result
ytmtui play --id dQw4w9WgXcQ    # play a known video id
ytmtui -q "queen" --play 2      # search, play result #2
```

### TUI keys

| Key | Action |
| --- | --- |
| `Enter` (search box) | Search |
| `Enter` (list) | Play selected |
| `Space` | Play/pause |
| `+` / `-` | Volume up/down |
| `/` | Focus search |
| `q` / `Ctrl+C` | Quit |

### Agent-friendly

`--json` prints a single JSON `Track[]` document on stdout (errors go to stderr as `{"error": "..."}`), so LLM agents and scripts can search and play without ever opening the TUI.

## Development

```bash
bun dev   # run with watch
```
