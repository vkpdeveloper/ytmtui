# ytmtui — Agent Skill

Play YouTube Music from the terminal. Search via YouTube Data API v3, playback via mpv (audio-only, system media controls included). This document teaches an LLM agent everything needed to operate ytmtui.

## Prerequisites

- `bun`, `mpv`, `yt-dlp` installed (`brew install mpv yt-dlp`).
- Env var `YTMTUI_API_KEY` (or `YT_API_KEY`) set to a YouTube Data API v3 key. A `.env` in the project root works when running via `bun run`/`bun dev` from the project directory.
- Run as `ytmtui` if `bun link`ed globally, otherwise `bun run src/index.ts` from the project root. All examples below use `ytmtui`.

## CLI usage (preferred for agents)

### Search

```bash
ytmtui -q "<query>"            # human-readable table
ytmtui -q "<query>" --json     # machine-readable — USE THIS
ytmtui -q "<query>" -n 5       # limit results (default 10)
ytmtui search "<query>"        # alias for -q
```

`--json` prints exactly one JSON document on stdout — an array of Track objects:

```json
[
  {
    "videoId": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "artist": "Rick Astley",
    "duration": "3:33",
    "thumbnailUrl": "https://i.ytimg.com/...",
    "publishedAt": "2009-10-25T06:57:33Z"
  }
]
```

### Play

```bash
ytmtui play "<query>"          # search, play first result
ytmtui play --id <videoId>     # play a known video id (no search, no API quota)
ytmtui -q "<query>" --play 2   # search, play the 2nd result (1-based)
```

- `play` blocks until the track ends (exit 0) or Ctrl+C/SIGINT (exit 0). To play in the background, run it as a background process and kill it (SIGINT/SIGTERM) to stop.
- **Single-song policy**: starting any new `ytmtui` playback automatically kills any previous ytmtui playback, even from a different process/terminal. The superseded process exits 0 on its own. To switch songs, just issue a new `play` — no cleanup needed.
- Recommended agent flow: search with `--json`, pick a `videoId`, then `ytmtui play --id <videoId>` (saves API quota; search costs 100 units, id-playback costs 0).

### Errors & exit codes

- Success: exit 0. Any error: exit 1.
- Errors go to stderr. With `--json`, stderr carries `{"error": "<message>"}`.
- Common errors: `missing API key: set YTMTUI_API_KEY`, `no results for query`, quota exceeded (YouTube default: 10,000 units/day ≈ 100 searches), `mpv not found`.

### Misc

```bash
ytmtui --help      # full usage
ytmtui --version   # version string
```

## TUI usage

`ytmtui` with no arguments opens the interactive TUI.

Layout: search input (top) → results list (middle) → player status bar (bottom: ▶/⏸ icon, track, position/duration, volume).

| Key | Context | Action |
| --- | --- | --- |
| type + `Enter` | search box | run search, focus results |
| `↑`/`↓` + `Enter` | results list | select and play highlighted track |
| `Space` | list focused | toggle play/pause |
| `+` / `-` | list focused | volume ±5 |
| `/` | anywhere | focus search box |
| `Esc` | search box | jump to results list |
| `q` / `Ctrl+C` | anywhere | quit (stops playback) |

## Playback behavior (both modes)

- Audio-only mpv stream (m4a preferred), no video download — starts in ~2-4s.
- macOS media keys / Now Playing widget control playback automatically; track title and artist are shown there.
- Volume range 0–100.

## Environment reference

| Variable | Purpose |
| --- | --- |
| `YTMTUI_API_KEY` | YouTube Data API v3 key (primary) |
| `YT_API_KEY` | fallback if `YTMTUI_API_KEY` unset |
