#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { Track } from "./types";

const HELP = `ytmtui - YouTube Music TUI & CLI

Usage:
  ytmtui                          Launch the interactive TUI
  ytmtui -q <query> [opts]        Search and print a results table
  ytmtui search <query> [opts]    Same as -q
  ytmtui play <query...>          Search and play the first result
  ytmtui play --id <videoId>      Play a known video id directly

Options:
  -q, --query <query>   Search query
  -n, --limit <count>   Max number of results (default 10)
      --json            Output raw JSON (Track[]); errors as {"error": "..."}
      --play <index>    With -q, play the given 1-based result index
      --id <videoId>    With 'play', play a specific video id
  -h, --help            Show this help
      --version         Show version

Environment:
  YTMTUI_API_KEY        YouTube Data API key (required for search/play).
                        YT_API_KEY is also accepted.

Examples:
  ytmtui -q "daft punk" -n 5
  ytmtui search "lofi beats" --json
  ytmtui play "rick astley never gonna give you up"
  ytmtui -q "queen" --play 2
`;

/** Whether stdout is a TTY (controls ANSI usage; we stay color-free regardless). */
const isTty = Boolean(process.stdout.isTTY);

function fail(message: string, json: boolean): never {
  if (json) {
    process.stderr.write(JSON.stringify({ error: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(1);
}

/** Normalize an ISO 8601 (PT#H#M#S) or already-humanized duration to m:ss. */
function formatDuration(duration?: string): string {
  if (!duration) return "";
  const iso = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!iso) return duration; // already humanized like "3:45"
  const h = Number(iso[1] ?? 0);
  const m = Number(iso[2] ?? 0);
  const s = Number(iso[3] ?? 0);
  const mm = h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}`;
  return `${mm}:${String(s).padStart(2, "0")}`;
}

function printTable(tracks: Track[]): void {
  const header = ["#", "TITLE", "ARTIST", "DURATION", "VIDEOID"];
  const rows = tracks.map((t, i) => [
    String(i + 1),
    t.title ?? "",
    t.artist ?? "",
    formatDuration(t.duration),
    t.videoId ?? "",
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col]!.length)),
  );
  const render = (cells: string[]) =>
    cells.map((c, col) => c.padEnd(widths[col]!)).join("  ").trimEnd();
  const lines = [render(header), ...rows.map(render)];
  process.stdout.write(lines.join("\n") + "\n");
  void isTty; // reserved: no ANSI colors are emitted in any mode
}

function resolveApiKey(): string | undefined {
  return process.env.YTMTUI_API_KEY || process.env.YT_API_KEY || undefined;
}

async function doSearch(query: string, limit: number | undefined): Promise<Track[]> {
  const { searchTracks } = await import("./search");
  return searchTracks(query, {
    maxResults: limit,
    apiKey: resolveApiKey(),
  });
}

async function playTrack(track: Track, json: boolean): Promise<void> {
  const { createMpvPlayer } = await import("./player/mpv");
  let player;
  try {
    player = createMpvPlayer();
  } catch (err) {
    fail(`could not start player: ${(err as Error).message}`, json);
  }

  let disposed = false;
  const shutdown = async (code: number) => {
    if (!disposed) {
      disposed = true;
      try {
        await player!.dispose();
      } catch {
        // ignore dispose errors on shutdown
      }
    }
    process.exit(code);
  };

  player!.on("trackEnd", () => void shutdown(0));
  player!.on("error", (err: Error) => fail(err.message, json));
  process.on("SIGINT", () => void shutdown(0));

  try {
    await player!.play(track);
  } catch (err) {
    await player!.dispose().catch(() => {});
    fail(`playback failed: ${(err as Error).message}`, json);
  }

  if (json) {
    process.stdout.write(JSON.stringify(track) + "\n");
  } else {
    process.stdout.write(`Playing: ${track.title} — ${track.artist}\n`);
  }
  // Keep the process alive until trackEnd or SIGINT.
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      query: { type: "string", short: "q" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
      play: { type: "string" },
      id: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });

  const json = Boolean(values.json);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values.version) {
    const pkg = (await import("../package.json", { with: { type: "json" } }))
      .default as { version?: string };
    process.stdout.write(`${pkg.version ?? "0.0.0"}\n`);
    return;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isFinite(n) || n <= 0) fail(`invalid limit: ${values.limit}`, json);
    limit = Math.floor(n);
  }

  const subcommand = positionals[0];
  const rest = positionals.slice(1);

  // play subcommand
  if (subcommand === "play") {
    if (!resolveApiKey() && !values.id) {
      fail("missing API key: set YTMTUI_API_KEY (or YT_API_KEY)", json);
    }
    if (values.id) {
      const track: Track = {
        videoId: values.id,
        title: values.id,
        artist: "unknown",
      };
      await playTrack(track, json);
      return;
    }
    const query = rest.join(" ").trim();
    if (!query) fail("play requires a <query> or --id <videoId>", json);
    const results = await doSearch(query, limit);
    if (results.length === 0) fail(`no results for: ${query}`, json);
    await playTrack(results[0]!, json);
    return;
  }

  // Determine query: --query/-q, or `search <query>` positional.
  let query = values.query;
  if (subcommand === "search") {
    const positionalQuery = rest.join(" ").trim();
    if (positionalQuery) query = positionalQuery;
  }

  // No query and no recognized subcommand -> launch TUI.
  if (query === undefined) {
    if (subcommand !== undefined && subcommand !== "search") {
      fail(`unknown command: ${subcommand}`, json);
    }
    if (subcommand === "search") {
      fail("search requires a <query>", json);
    }
    const { runTui } = await import("./tui");
    await runTui();
    return;
  }

  if (!resolveApiKey()) {
    fail("missing API key: set YTMTUI_API_KEY (or YT_API_KEY)", json);
  }

  const results = await doSearch(query, limit);

  // --play <index> combined with -q/search: play that 1-based result.
  if (values.play !== undefined) {
    const idx = Number(values.play);
    if (!Number.isInteger(idx) || idx < 1) fail(`invalid --play index: ${values.play}`, json);
    if (results.length === 0) fail(`no results for: ${query}`, json);
    const track = results[idx - 1];
    if (!track) fail(`--play index out of range: ${idx} (got ${results.length} results)`, json);
    await playTrack(track, json);
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(results) + "\n");
    return;
  }

  if (results.length === 0) fail(`no results for: ${query}`, json);
  printTable(results);
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
