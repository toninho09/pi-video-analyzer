import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { defaultSettings, loadSettings, saveSettings, settingsFilePath } from "../lib/settings.ts";

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-video-analyser-agent-"));
});

test("settings live in PI_CODING_AGENT_DIR", () => {
	assert.equal(settingsFilePath(), path.join(process.env.PI_CODING_AGENT_DIR!, "pi-video-analyser.json"));
});

test("a missing file yields defaults", () => {
	assert.deepEqual(loadSettings(), defaultSettings());
});

test("saved settings round-trip", () => {
	const settings = { provider: "openrouter", modelId: "google/gemini-2.5-flash", maxVideoMb: 20, timeoutSeconds: 60 };
	saveSettings(settings);
	assert.deepEqual(loadSettings(), settings);
	assert.ok(readFileSync(settingsFilePath(), "utf-8").endsWith("}\n"));
});

test("out-of-range numbers are clamped, non-numbers fall back to defaults", () => {
	writeFileSync(
		settingsFilePath(),
		JSON.stringify({ provider: "p", modelId: "m", maxVideoMb: 9999, timeoutSeconds: "soon" }),
	);
	const settings = loadSettings();
	assert.equal(settings.maxVideoMb, 350);
	assert.equal(settings.timeoutSeconds, defaultSettings().timeoutSeconds);
});

test("a corrupt file throws instead of silently resetting", () => {
	writeFileSync(settingsFilePath(), "{ not json");
	assert.throws(() => loadSettings(), /Could not read .*pi-video-analyser\.json/);
	writeFileSync(settingsFilePath(), "[]");
	assert.throws(() => loadSettings(), /must contain a JSON object/);
});
