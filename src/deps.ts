/**
 * Preflight checks for external binaries ytmtui needs at runtime (mpv, yt-dlp),
 * with per-distro install instructions in error messages.
 */
import { readFileSync } from "node:fs";

const EXTRA_PATHS = [
  "/opt/homebrew/bin", // macOS Apple Silicon Homebrew
  "/usr/local/bin", // macOS Intel Homebrew / manual installs
  "/usr/bin", // Linux distro packages
];

export function findBinary(name: string): string | null {
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const dir of EXTRA_PATHS) {
    const candidate = `${dir}/${name}`;
    if (Bun.which(name, { PATH: dir })) return candidate;
  }
  return null;
}

type Distro = "macos" | "arch" | "debian" | "linux-other";

function detectDistro(): Distro {
  if (process.platform === "darwin") return "macos";
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const lower = osRelease.toLowerCase();
    if (lower.includes("arch") || lower.includes("manjaro") || lower.includes("endeavouros")) {
      return "arch";
    }
    if (lower.includes("ubuntu") || lower.includes("debian") || lower.includes("mint") || lower.includes("pop")) {
      return "debian";
    }
  } catch {
    // /etc/os-release missing — generic linux
  }
  return "linux-other";
}

function installHint(missing: string[], distro: Distro): string {
  const pkgs = missing.join(" ");
  switch (distro) {
    case "macos":
      return `brew install ${pkgs}`;
    case "arch":
      return `sudo pacman -S ${pkgs}   (requires sudo)`;
    case "debian":
      return `sudo apt install ${pkgs}   (requires sudo)`;
    case "linux-other":
      return `install via your distro's package manager, e.g. sudo apt install ${pkgs} / sudo pacman -S ${pkgs}   (requires sudo)`;
  }
}

/**
 * Throws a readable Error listing every missing playback dependency and the
 * exact install command for the detected OS/distro. No-op when all present.
 *
 * Note: mpv invokes yt-dlp itself to resolve YouTube streams, so both must
 * be present even though ytmtui only spawns mpv.
 */
export function assertPlaybackDeps(): void {
  const missing: string[] = [];
  if (!findBinary("mpv")) missing.push("mpv");
  if (!findBinary("yt-dlp")) missing.push("yt-dlp");
  if (missing.length === 0) return;

  const distro = detectDistro();
  throw new Error(
    `missing required package${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
      `Install with: ${installHint(missing, distro)}`,
  );
}
