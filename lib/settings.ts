/**
 * Settings for pi-video-analyser, persisted globally at
 * ~/.pi/agent/pi-video-analyser.json (same convention as presets.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

export const MAX_VIDEO_MB_RANGE: readonly [number, number] = [1, 500];
export const TIMEOUT_SECONDS_RANGE: readonly [number, number] = [5, 3600];

const SETTINGS_DIR = path.join(homedir(), ".pi", "agent");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "pi-video-analyser.json");

function defaults(): VideoAnalyserSettings {
	return {
		provider: "",
		modelId: "",
		maxVideoMb: DEFAULT_MAX_VIDEO_MB,
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	};
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return Math.round(parsed);
}

/** Load settings; missing or corrupt files fall back to defaults. */
export function loadSettings(): VideoAnalyserSettings {
	try {
		if (!existsSync(SETTINGS_FILE)) {
			return defaults();
		}
		const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) {
			return defaults();
		}
		const raw = parsed as Record<string, unknown>;
		return {
			provider: typeof raw.provider === "string" ? raw.provider : "",
			modelId: typeof raw.modelId === "string" ? raw.modelId : "",
			maxVideoMb: clampInt(raw.maxVideoMb, ...MAX_VIDEO_MB_RANGE, DEFAULT_MAX_VIDEO_MB),
			timeoutSeconds: clampInt(raw.timeoutSeconds, ...TIMEOUT_SECONDS_RANGE, DEFAULT_TIMEOUT_SECONDS),
		};
	} catch {
		return defaults();
	}
}

export function saveSettings(settings: VideoAnalyserSettings): void {
	mkdirSync(SETTINGS_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

export function settingsFilePath(): string {
	return SETTINGS_FILE;
}
