import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  InputRenderableEvents,
  SelectRenderableEvents,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import type { SelectOption } from "@opentui/core";
import type { Track, Player, PlayerStatus } from "./types.ts";
import { searchTracks } from "./search.ts";
import { createMpvPlayer } from "./player/mpv.ts";

// --- Theme (minimal, tasteful) ---
const COLOR_BORDER = "#3a3a3a";
const COLOR_BORDER_FOCUS = "#5f87ff";
const COLOR_ACCENT = "#5f87ff";
const COLOR_TEXT = "#c6c6c6";
const COLOR_DIM = "#6c6c6c";
const COLOR_ERROR = "#ff5f5f";
const COLOR_BG = "#1c1c1c";
const COLOR_SELECTED_BG = "#303a5a";

function fmtTime(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "--:--";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function rowLabel(track: Track): string {
  const dur = track.duration ? `  [${track.duration}]` : "";
  return `${track.title} — ${track.artist}${dur}`;
}

export async function runTui(): Promise<void> {
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false, // handled manually so we can dispose the player first
    targetFps: 30,
  });

  const player: Player = createMpvPlayer();

  // Track UI/player state locally so the status bar and polling stay consistent.
  let focusTarget: "search" | "list" = "search";
  let volume = 50;
  let lastStatus: PlayerStatus = { state: "stopped", volume };
  let statusMessage = "";
  let disposed = false;

  // --- Layout: root column ---
  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    backgroundColor: COLOR_BG,
  });

  // Top: search input box
  const searchBox = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR_BORDER_FOCUS,
    title: " ytmtui ",
    titleAlignment: "left",
    titleColor: COLOR_ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLOR_BG,
  });
  const input = new InputRenderable(renderer, {
    placeholder: "Search YouTube Music…",
    placeholderColor: COLOR_DIM,
    textColor: COLOR_TEXT,
    focusedTextColor: COLOR_TEXT,
    backgroundColor: COLOR_BG,
    focusedBackgroundColor: COLOR_BG,
  });
  searchBox.add(input);

  // Middle: results list (Select scrolls internally)
  const listBox = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR_BORDER,
    title: " Results ",
    titleColor: COLOR_DIM,
    flexGrow: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLOR_BG,
  });
  const list = new SelectRenderable(renderer, {
    flexGrow: 1,
    options: [],
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    backgroundColor: COLOR_BG,
    focusedBackgroundColor: COLOR_BG,
    textColor: COLOR_TEXT,
    focusedTextColor: COLOR_TEXT,
    selectedBackgroundColor: COLOR_SELECTED_BG,
    selectedTextColor: COLOR_ACCENT,
  });
  listBox.add(list);

  // Bottom: status bar
  const statusBox = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR_BORDER,
    height: 3,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLOR_BG,
  });
  const statusText = new TextRenderable(renderer, {
    content: "",
    fg: COLOR_TEXT,
    bg: COLOR_BG,
  });
  statusBox.add(statusText);

  root.add(searchBox);
  root.add(listBox);
  root.add(statusBox);
  renderer.root.add(root);

  // --- Status bar rendering ---
  function renderStatus(): void {
    if (statusMessage) {
      statusText.fg = COLOR_ERROR;
      statusText.content = statusMessage;
      return;
    }
    statusText.fg = COLOR_TEXT;

    const st = lastStatus;
    let icon = "⏹";
    if (st.state === "playing") icon = "▶";
    else if (st.state === "paused") icon = "⏸";
    else if (st.state === "loading") icon = "…";

    const vol = st.volume ?? volume;

    if (!st.track) {
      statusText.content = `${icon}  (nothing playing)      vol ${vol}%   ·   / search  ␣ pause  +/- vol  q quit`;
      return;
    }

    const pos = fmtTime(st.positionSec);
    const dur = fmtTime(st.durationSec);
    statusText.content = `${icon}  ${st.track.title} — ${st.track.artist}   ${pos}/${dur}   vol ${vol}%`;
  }

  function setMessage(msg: string): void {
    statusMessage = msg;
    renderStatus();
  }
  function clearMessage(): void {
    if (statusMessage) {
      statusMessage = "";
      renderStatus();
    }
  }

  // --- Focus management ---
  function focusSearch(): void {
    focusTarget = "search";
    input.focus();
    searchBox.borderColor = COLOR_BORDER_FOCUS;
    listBox.borderColor = COLOR_BORDER;
  }
  function focusList(): void {
    if (list.options.length === 0) return;
    focusTarget = "list";
    list.focus();
    listBox.borderColor = COLOR_BORDER_FOCUS;
    searchBox.borderColor = COLOR_BORDER;
  }

  // --- Player events ---
  player.on("statusChange", (status: PlayerStatus) => {
    lastStatus = status;
    if (status.volume !== undefined) volume = status.volume;
    clearMessage();
    renderStatus();
  });
  player.on("error", (err: Error) => {
    setMessage(`Player error: ${err.message}`);
  });
  player.on("trackEnd", () => {
    lastStatus = { ...lastStatus, state: "stopped", positionSec: 0 };
    renderStatus();
  });

  // --- Search flow ---
  let searching = false;
  async function doSearch(): Promise<void> {
    const query = input.value.trim();
    if (!query || searching) return;
    searching = true;
    setMessage(`Searching "${query}"…`);
    try {
      const tracks = await searchTracks(query);
      const options: SelectOption[] = tracks.map((t) => ({
        name: rowLabel(t),
        description: "",
        value: t,
      }));
      list.options = options;
      clearMessage();
      if (options.length === 0) {
        setMessage(`No results for "${query}".`);
      } else {
        focusList();
        renderStatus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage(`Search failed: ${msg}`);
    } finally {
      searching = false;
    }
  }

  input.on(InputRenderableEvents.ENTER, () => {
    void doSearch();
  });

  // --- List selection -> play ---
  list.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    const track = option?.value as Track | undefined;
    if (!track) return;
    clearMessage();
    void player.play(track).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage(`Playback failed: ${msg}`);
    });
  });

  // --- Volume ---
  async function changeVolume(delta: number): Promise<void> {
    volume = Math.max(0, Math.min(100, volume + delta));
    try {
      await player.setVolume(volume);
    } catch {
      /* ignore volume errors */
    }
    lastStatus = { ...lastStatus, volume };
    renderStatus();
  }

  // --- Quit / cleanup ---
  async function quit(): Promise<void> {
    if (disposed) return;
    disposed = true;
    clearInterval(pollTimer);
    try {
      await player.dispose();
    } catch {
      /* ignore */
    }
    renderer.destroy();
    process.exit(0);
  }

  // --- Global key handling ---
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Always-available quit
    if (key.ctrl && key.name === "c") {
      void quit();
      return;
    }

    // While typing in the search box, let the Input own all other keys.
    if (focusTarget === "search") {
      if (key.name === "escape") focusList();
      return;
    }

    const seq = key.sequence;
    switch (true) {
      case key.name === "q":
        void quit();
        break;
      case key.name === "space" || seq === " ":
        clearMessage();
        void player.togglePause().catch(() => {});
        break;
      case seq === "+" || seq === "=":
        void changeVolume(5);
        break;
      case seq === "-" || seq === "_":
        void changeVolume(-5);
        break;
      case seq === "/":
        focusSearch();
        break;
      default:
        break; // arrows / enter handled by the focused Select
    }
  });

  // --- Poll position once per second, only while playing ---
  const pollTimer = setInterval(() => {
    if (lastStatus.state !== "playing") return;
    player
      .getStatus()
      .then((status) => {
        lastStatus = status;
        if (status.volume !== undefined) volume = status.volume;
        renderStatus();
      })
      .catch(() => {});
  }, 1000);

  // Initial state
  focusSearch();
  renderStatus();

  // Keep the process alive until quit() calls process.exit.
  await new Promise<void>(() => {});
}
