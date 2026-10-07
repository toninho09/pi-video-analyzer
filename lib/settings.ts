/**
 * Settings for pi-video-analyser, persisted globally in Pi's agent directory
 * (~/.pi/agent/pi-video-analyser.json by default, same convention as presets.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface VideoAnalyserSettings {
	/** pi provider id, e.g. "openai" or "openrouter". */
	provider: string;
	/** Model id within the provider. */
	modelId: string;
	/** Hard cap on video file size, in megabytes. */
	maxVideoMb: number;
	/** Request timeout for the analysis call, in seconds. */
	timeoutSeconds: number;
}

export const DEFAULT_MAX_VIDEO_MB = 50;
export const DEFAULT_TIMEOUT_SECONDS = 300;

// The video travels as a base64 string inside the JSON body, and V8 caps
// strings at ~512M chars (~384 MB of raw video); 350 MB leaves room for the
// rest of the request.
export const MAX_VIDEO_MB_RANGE: readonly [number, number] = [1, 350];
export const TIMEOUT_SECONDS_RANGE: readonly [number, number] = [5, 3600];

/** Resolved on each call so PI_CODING_AGENT_DIR is honoured. */
export function settingsFilePath(): string {
	return path.join(getAgentDir(), "pi-video-analyser.json");
}

export function defaultSettings(): VideoAnalyserSettings {
	return {
		provider: "",
		modelId: "",
		maxVideoMb: DEFAULT_MAX_VIDEO_MB,
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	};
}

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Load settings; a missing file yields defaults. Throws when the file exists
 * but cannot be read or parsed, so a broken config never passes silently.
 */
export function loadSettings(): VideoAnalyserSettings {
	const file = settingsFilePath();
	if (!existsSync(file)) {
		return defaultSettings();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf-8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${file}: ${reason}. Fix it or re-run /pi-video-analyser:settings.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${file} must contain a JSON object. Fix it or re-run /pi-video-analyser:settings.`);
	}
	const raw = parsed as Record<string, unknown>;
	return {
		provider: typeof raw.provider === "string" ? raw.provider : "",
		modelId: typeof raw.modelId === "string" ? raw.modelId : "",
		maxVideoMb: clampInt(raw.maxVideoMb, MAX_VIDEO_MB_RANGE, DEFAULT_MAX_VIDEO_MB),
		timeoutSeconds: clampInt(raw.timeoutSeconds, TIMEOUT_SECONDS_RANGE, DEFAULT_TIMEOUT_SECONDS),
	};
}

export function saveSettings(settings: VideoAnalyserSettings): void {
	const file = settingsFilePath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}
