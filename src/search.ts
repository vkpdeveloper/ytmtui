import type { Track, SearchOptions } from "./types.ts";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/**
 * Resolve the YouTube Data API key from options or environment.
 * Order: opts.apiKey -> YTMTUI_API_KEY -> YT_API_KEY.
 */
function resolveApiKey(opts?: SearchOptions): string {
  const key = opts?.apiKey ?? process.env.YTMTUI_API_KEY ?? process.env.YT_API_KEY;
  if (!key) {
    throw new Error(
      "No YouTube API key found. Set the YTMTUI_API_KEY environment variable " +
        "(or pass { apiKey } to searchTracks). You can create a key at " +
        "https://console.cloud.google.com/ with the YouTube Data API v3 enabled.",
    );
  }
  return key;
}

/**
 * Decode the common HTML entities that the YouTube Data API returns in text
 * fields (e.g. titles). Handles numeric decimal/hex entities plus the named
 * entities &amp; &quot; &lt; &gt; &#39;. Runs &amp; last-ish via a two-pass so
 * double-encoded values like "&amp;#39;" resolve correctly.
 */
export function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&quot;": '"',
    "&apos;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&#39;": "'",
    "&nbsp;": " ",
  };

  const decodeOnce = (s: string): string =>
    s
      // Numeric entities: decimal (&#39;) and hex (&#x27;)
      .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
        String.fromCodePoint(parseInt(hex, 16)),
      )
      // Named entities
      .replace(/&(?:amp|quot|apos|lt|gt|nbsp|#39);/g, (m) => named[m] ?? m);

  // Two passes so that double-encoded sequences ("&amp;#39;" -> "&#39;" -> "'")
  // are fully decoded.
  const once = decodeOnce(input);
  return once === input ? once : decodeOnce(once);
}

/**
 * Convert an ISO 8601 duration (as returned by the YouTube API, e.g. "PT3M45S"
 * or "PT1H2M3S") into a human display string like "3:45" or "1:02:03".
 * Returns undefined for values that cannot be parsed.
 */
export function formatIso8601Duration(iso: string): string | undefined {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return undefined;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0) + days * 24;
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);

  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

interface SearchApiItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
}

interface SearchApiResponse {
  items?: SearchApiItem[];
  error?: YouTubeApiError;
}

interface VideosApiItem {
  id?: string;
  contentDetails?: { duration?: string };
}

interface VideosApiResponse {
  items?: VideosApiItem[];
  error?: YouTubeApiError;
}

interface YouTubeApiError {
  code?: number;
  message?: string;
  errors?: Array<{ reason?: string; message?: string }>;
}

/**
 * Turn a YouTube API error payload (or a non-OK HTTP response) into a readable
 * Error with the API's reason string when available.
 */
async function toApiError(res: Response, context: string): Promise<Error> {
  let apiErr: YouTubeApiError | undefined;
  try {
    const body = (await res.json()) as { error?: YouTubeApiError };
    apiErr = body.error;
  } catch {
    // ignore body parse failures; fall back to status text
  }
  return buildApiError(apiErr, res.status, res.statusText, context);
}

function buildApiError(
  apiErr: YouTubeApiError | undefined,
  status: number,
  statusText: string,
  context: string,
): Error {
  const reason = apiErr?.errors?.[0]?.reason;
  const message = apiErr?.message ?? statusText;

  let hint = "";
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    hint = " The daily YouTube Data API quota has been exceeded; try again later or use a different key.";
  } else if (
    reason === "keyInvalid" ||
    reason === "badRequest" ||
    reason === "forbidden" ||
    status === 400 ||
    status === 403
  ) {
    hint = " Check that YTMTUI_API_KEY is a valid YouTube Data API v3 key with the API enabled.";
  }

  const reasonPart = reason ? ` [${reason}]` : "";
  return new Error(
    `YouTube API ${context} failed (HTTP ${status})${reasonPart}: ${message}.${hint}`,
  );
}

/**
 * Fetch ISO 8601 durations for a batch of video ids via the videos endpoint,
 * returning a map of videoId -> raw ISO duration string.
 */
async function fetchDurations(
  ids: string[],
  apiKey: string,
): Promise<Map<string, string>> {
  const durations = new Map<string, string>();
  if (ids.length === 0) return durations;

  const params = new URLSearchParams({
    part: "contentDetails",
    id: ids.join(","),
    key: apiKey,
  });

  const res = await fetch(`${VIDEOS_URL}?${params.toString()}`);
  if (!res.ok) {
    throw await toApiError(res, "video details request");
  }

  const data = (await res.json()) as VideosApiResponse;
  if (data.error) {
    throw buildApiError(data.error, res.status, res.statusText, "video details request");
  }

  for (const item of data.items ?? []) {
    if (item.id && item.contentDetails?.duration) {
      durations.set(item.id, item.contentDetails.duration);
    }
  }
  return durations;
}

/**
 * Search YouTube (Music category) for tracks matching `query`.
 *
 * Performs a search.list request restricted to music videos, then a batched
 * videos.list request to enrich each result with its duration.
 */
export async function searchTracks(
  query: string,
  opts?: SearchOptions,
): Promise<Track[]> {
  const apiKey = resolveApiKey(opts);
  const maxResults = opts?.maxResults ?? 10;

  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoCategoryId: "10", // Music
    maxResults: String(maxResults),
    q: query,
    key: apiKey,
  });

  const res = await fetch(`${SEARCH_URL}?${searchParams.toString()}`);
  if (!res.ok) {
    throw await toApiError(res, "search request");
  }

  const data = (await res.json()) as SearchApiResponse;
  if (data.error) {
    throw buildApiError(data.error, res.status, res.statusText, "search request");
  }

  const items = data.items ?? [];

  const tracks: Track[] = [];
  for (const item of items) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;
    const snippet = item.snippet ?? {};
    tracks.push({
      videoId,
      title: decodeHtmlEntities(snippet.title ?? ""),
      artist: decodeHtmlEntities(snippet.channelTitle ?? ""),
      thumbnailUrl: snippet.thumbnails?.medium?.url,
      publishedAt: snippet.publishedAt,
    });
  }

  const durations = await fetchDurations(
    tracks.map((t) => t.videoId),
    apiKey,
  );

  for (const track of tracks) {
    const iso = durations.get(track.videoId);
    if (iso) {
      track.duration = formatIso8601Duration(iso) ?? iso;
    }
  }

  return tracks;
}
