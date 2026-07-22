export interface Track {
  videoId: string;
  title: string;
  artist: string; // channel title
  duration?: string; // ISO 8601 (PT3M45S) or humanized "3:45"
  thumbnailUrl?: string;
  publishedAt?: string;
}

export interface SearchOptions {
  maxResults?: number; // default 10
  apiKey?: string; // falls back to env YTMTUI_API_KEY / YT_API_KEY
}

export interface PlayerStatus {
  state: "playing" | "paused" | "stopped" | "loading";
  track?: Track;
  positionSec?: number;
  durationSec?: number;
  volume?: number; // 0-100
}

export interface PlayerEvents {
  statusChange: (status: PlayerStatus) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

// Contract implemented by src/player/mpv.ts
export interface Player {
  play(track: Track): Promise<void>;
  togglePause(): Promise<void>;
  stop(): Promise<void>;
  setVolume(volume: number): Promise<void>; // 0-100
  getStatus(): Promise<PlayerStatus>;
  seek(seconds: number): Promise<void>; // relative
  on<K extends keyof PlayerEvents>(event: K, cb: PlayerEvents[K]): void;
  dispose(): Promise<void>;
}
