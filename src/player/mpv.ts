import type { Subprocess } from "bun";
import type { Player, PlayerEvents, PlayerStatus, Track } from "../types.ts";
import { assertPlaybackDeps, findBinary } from "../deps.ts";

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
};

type IpcResponse = {
  error?: string;
  data?: unknown;
  request_id?: number;
  event?: string;
  reason?: string;
  name?: string;
};


/**
 * Only one ytmtui-owned mpv may play at a time, across all ytmtui processes.
 * Every instance is identifiable by its ytmtui socket path argument, so kill
 * any surviving ones (from other CLI/TUI invocations) and sweep stale sockets.
 */
async function killOtherInstances(): Promise<void> {
  const pkill = Bun.spawn({
    cmd: ["pkill", "-f", "input-ipc-server=/tmp/ytmtui-mpv-"],
    stdout: "ignore",
    stderr: "ignore",
  });
  await pkill.exited;
  const rm = Bun.spawn({
    cmd: ["sh", "-c", "rm -f /tmp/ytmtui-mpv-*.sock"],
    stdout: "ignore",
    stderr: "ignore",
  });
  await rm.exited;
}

class MpvPlayer implements Player {
  private proc: Subprocess | null = null;
  private socket: import("bun").Socket<undefined> | null = null;
  private socketPath: string | null = null;

  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private recvBuffer = "";

  private listeners = new Map<keyof PlayerEvents, Set<(...args: never[]) => void>>();

  private currentTrack: Track | undefined;
  private state: PlayerStatus["state"] = "stopped";
  private positionSec: number | undefined;
  private durationSec: number | undefined;
  private volume = 100;

  private disposed = false;

  on<K extends keyof PlayerEvents>(event: K, cb: PlayerEvents[K]): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (...args: never[]) => void);
  }

  private emit<K extends keyof PlayerEvents>(
    event: K,
    ...args: Parameters<PlayerEvents[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as (...a: unknown[]) => void)(...args);
      } catch {
        // never let a listener throw break the player
      }
    }
  }

  private emitStatus(): void {
    this.emit("statusChange", this.buildStatus());
  }

  private buildStatus(): PlayerStatus {
    return {
      state: this.state,
      track: this.currentTrack,
      positionSec: this.positionSec,
      durationSec: this.durationSec,
      volume: this.volume,
    };
  }

  async play(track: Track): Promise<void> {
    if (this.disposed) throw new Error("Player has been disposed");

    // Tear down any existing playback before starting fresh, and stop any
    // mpv started by other ytmtui processes — one song at a time, globally.
    await this.teardown();
    await killOtherInstances();

    let bin: string;
    try {
      assertPlaybackDeps();
      bin = findBinary("mpv")!;
    } catch (e) {
      const err = e as Error;
      this.emit("error", err);
      throw err;
    }

    this.currentTrack = track;
    this.state = "loading";
    this.positionSec = 0;
    this.durationSec = undefined;
    this.emitStatus();

    const socketPath = `/tmp/ytmtui-mpv-${process.pid}-${Date.now()}.sock`;
    this.socketPath = socketPath;

    const mediaTitle = `${track.title} — ${track.artist}`;
    const url = `https://www.youtube.com/watch?v=${track.videoId}`;

    try {
      this.proc = Bun.spawn({
        cmd: [
          bin,
          "--no-video",
          "--no-terminal",
          // Audio-only, fast startup: prefer m4a (no remux), never fetch video
          // streams, skip playlist probing and cover-art decoding.
          "--ytdl-format=bestaudio[ext=m4a]/bestaudio/best",
          "--ytdl-raw-options=no-playlist=",
          "--audio-display=no",
          "--cache=yes",
          "--demuxer-readahead-secs=10",
          `--input-ipc-server=${socketPath}`,
          `--force-media-title=${mediaTitle}`,
          `--volume=${this.volume}`,
          url,
        ],
        stdout: "ignore",
        stderr: "ignore",
        onExit: (_proc, _exitCode, _signalCode, error) => {
          if (error) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
          }
          // If mpv dies unexpectedly while we still thought we were playing,
          // reflect the stopped state.
          if (!this.disposed && this.state !== "stopped") {
            this.state = "stopped";
            this.emitStatus();
          }
        },
      });
    } catch (e) {
      const err = new Error(
        `Failed to start mpv (${(e as Error).message}). Install it with: brew install mpv yt-dlp`,
      );
      this.emit("error", err);
      throw err;
    }

    try {
      await this.connectWithRetry(socketPath);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.emit("error", err);
      await this.teardown();
      throw err;
    }

    // Observe properties so we can push status updates and detect track end.
    this.send(["observe_property", 1, "pause"]);
    this.send(["observe_property", 2, "time-pos"]);
    this.send(["observe_property", 3, "duration"]);
    this.send(["observe_property", 4, "volume"]);

    this.state = "playing";
    this.emitStatus();
  }

  private async connectWithRetry(socketPath: string): Promise<void> {
    const deadline = Date.now() + 5000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      // Bail out early if mpv already exited.
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error("mpv exited before its IPC socket became available");
      }
      try {
        const socket = await Bun.connect<undefined>({
          unix: socketPath,
          socket: {
            data: (_s, data) => this.onSocketData(data),
            close: () => this.onSocketClose(),
            error: (_s, err) => {
              this.emit("error", err instanceof Error ? err : new Error(String(err)));
            },
          },
        });
        this.socket = socket;
        return;
      } catch (e) {
        lastErr = e;
        await Bun.sleep(50);
      }
    }
    throw new Error(
      `Timed out connecting to mpv IPC socket at ${socketPath}` +
        (lastErr ? `: ${(lastErr as Error).message}` : ""),
    );
  }

  private onSocketData(data: Buffer): void {
    this.recvBuffer += data.toString("utf8");
    let idx: number;
    while ((idx = this.recvBuffer.indexOf("\n")) !== -1) {
      const line = this.recvBuffer.slice(0, idx).trim();
      this.recvBuffer = this.recvBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: IpcResponse;
      try {
        msg = JSON.parse(line) as IpcResponse;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: IpcResponse): void {
    if (typeof msg.request_id === "number" && this.pending.has(msg.request_id)) {
      const pending = this.pending.get(msg.request_id)!;
      this.pending.delete(msg.request_id);
      if (msg.error && msg.error !== "success") {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.data);
      }
      return;
    }

    if (msg.event === "property-change") {
      this.handlePropertyChange(msg);
      return;
    }

    if (msg.event === "end-file") {
      // reason "eof" => natural completion; others are stop/quit/error.
      if (msg.reason === "eof") {
        this.state = "stopped";
        this.emitStatus();
        this.emit("trackEnd");
      }
      return;
    }
  }

  private handlePropertyChange(msg: IpcResponse): void {
    switch (msg.name) {
      case "pause":
        if (typeof msg.data === "boolean") {
          if (this.state !== "stopped" && this.state !== "loading") {
            this.state = msg.data ? "paused" : "playing";
          }
        }
        this.emitStatus();
        break;
      case "time-pos":
        if (typeof msg.data === "number") {
          this.positionSec = msg.data;
          if (this.state === "loading") this.state = "playing";
        }
        this.emitStatus();
        break;
      case "duration":
        if (typeof msg.data === "number") this.durationSec = msg.data;
        this.emitStatus();
        break;
      case "volume":
        if (typeof msg.data === "number") this.volume = msg.data;
        this.emitStatus();
        break;
    }
  }

  private onSocketClose(): void {
    this.socket = null;
    // Reject any in-flight requests; the socket is gone.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("mpv IPC socket closed"));
    }
    this.pending.clear();
  }

  /** Fire-and-forget IPC command. */
  private send(command: unknown[]): void {
    if (!this.socket) return;
    const payload = JSON.stringify({ command }) + "\n";
    try {
      this.socket.write(payload);
    } catch {
      // socket may have closed underneath us
    }
  }

  /** IPC command with response correlation via request_id. */
  private request(command: unknown[]): Promise<unknown> {
    if (!this.socket) {
      return Promise.reject(new Error("Not connected to mpv"));
    }
    const id = ++this.requestId;
    const payload = JSON.stringify({ command, request_id: id }) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.write(payload);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      // Guard against a hung request.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("mpv IPC request timed out"));
        }
      }, 3000);
    });
  }

  async togglePause(): Promise<void> {
    if (!this.socket) return;
    this.send(["cycle", "pause"]);
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.currentTrack = undefined;
    this.positionSec = undefined;
    this.durationSec = undefined;
    this.state = "stopped";
    this.emitStatus();
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, volume));
    this.volume = clamped;
    if (this.socket) {
      this.send(["set_property", "volume", clamped]);
    }
    this.emitStatus();
  }

  async seek(seconds: number): Promise<void> {
    if (!this.socket) return;
    this.send(["seek", seconds, "relative"]);
  }

  async getStatus(): Promise<PlayerStatus> {
    if (!this.socket) {
      return this.buildStatus();
    }
    const safeGet = async (prop: string): Promise<unknown> => {
      try {
        return await this.request(["get_property", prop]);
      } catch {
        return undefined;
      }
    };

    const [pause, timePos, duration, vol] = await Promise.all([
      safeGet("pause"),
      safeGet("time-pos"),
      safeGet("duration"),
      safeGet("volume"),
    ]);

    if (typeof timePos === "number") this.positionSec = timePos;
    if (typeof duration === "number") this.durationSec = duration;
    if (typeof vol === "number") this.volume = vol;
    if (typeof pause === "boolean" && this.state !== "stopped") {
      this.state = pause ? "paused" : "playing";
    }

    return this.buildStatus();
  }

  /** Quit mpv, close the socket, and remove the socket file. */
  private async teardown(): Promise<void> {
    // Ask mpv to quit gracefully.
    if (this.socket) {
      this.send(["quit"]);
    }

    const proc = this.proc;
    if (proc) {
      const exited = proc.exited;
      // Give mpv a brief window to quit on its own, then force-kill.
      const killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }, 500);
      try {
        await exited;
      } catch {
        // ignore
      } finally {
        clearTimeout(killTimer);
      }
    }

    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    // Reject any leftover pending requests.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Playback stopped"));
    }
    this.pending.clear();
    this.recvBuffer = "";

    if (this.socketPath) {
      try {
        await Bun.file(this.socketPath).unlink?.();
      } catch {
        // socket file may already be gone
      }
      this.socketPath = null;
    }

    this.proc = null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.teardown();
    this.currentTrack = undefined;
    this.state = "stopped";
    this.listeners.clear();
  }
}

export function createMpvPlayer(): Player {
  return new MpvPlayer();
}
