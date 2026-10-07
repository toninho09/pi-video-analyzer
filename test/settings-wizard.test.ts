import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { defaultSettings, loadSettings, saveSettings, settingsFilePath } from "../lib/settings.ts";
import { runSettingsWizard } from "../lib/settings-wizard.ts";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(path.join(tmpdir(), "pi-video-wizard-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function model(id: string, api: Api = "openai-completions"): Model<Api> {
	return { id, api, provider: "test-provider", name: id } as Model<Api>;
}

function wizardContext(all: Model<Api>[], available: Model<Api>[], answers: (string | undefined)[] = []) {
	const notifications: string[] = [];
	const selections: string[][] = [];
	const prompts: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "rpc",
		modelRegistry: {
			getAll: () => all,
			getAvailable: () => available,
			hasConfiguredAuth: (candidate: Model<Api>) => available.includes(candidate),
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			input: async (title: string) => {
				prompts.push(title);
				assert.ok(answers.length > 0, `Unexpected input prompt: ${title}`);
				return answers.shift();
			},
			select: async (_title: string, options: string[]) => {
				selections.push(options);
				assert.ok(options.length > 0, "Must not show an empty selection");
				return options[0];
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, selections, prompts };
}

test("wizard only lists available Pi models with compatible APIs", async () => {
	const available = [model("responses", "openai-responses"), model("chat"), model("native", "google-generative-ai")];
	const all = [...available, model("not-logged-in")];
	const { ctx, selections } = wizardContext(all, available, ["", ""]);

	await runSettingsWizard(ctx);

	assert.deepEqual(selections, [["test-provider / chat", "test-provider / responses"]]);
	assert.equal(loadSettings().modelId, "chat");
});

test("wizard asks the user to log in when no compatible models are available", async () => {
	const native = model("native", "google-generative-ai");
	const { ctx, notifications, selections, prompts } = wizardContext([model("not-logged-in"), native], [native]);

	await runSettingsWizard(ctx);

	assert.ok(notifications.some((message) => message.includes("/login")));
	assert.deepEqual(selections, []);
	assert.deepEqual(prompts, []);
	assert.equal(existsSync(settingsFilePath()), false);
});

function manyModels(): Model<Api>[] {
	return [...Array.from({ length: 30 }, (_, i) => model(`video-${i}`)), model("target")];
}

test("RPC search retries after no matches and too many matches", async () => {
	const models = manyModels();
	const { ctx, notifications, selections, prompts } = wizardContext(models, models, [
		"zzzzz-no-match",
		"",
		"target",
		"",
		"",
	]);

	await runSettingsWizard(ctx);

	assert.ok(notifications.some((message) => message.includes("No models match")));
	assert.ok(notifications.some((message) => message.includes("31 matches")));
	assert.deepEqual(selections, [["test-provider / target"]]);
	assert.equal(prompts.filter((title) => title === "Search models (fuzzy match)").length, 3);
	assert.deepEqual(loadSettings(), { ...defaultSettings(), provider: "test-provider", modelId: "target" });
});

test("RPC search can be cancelled after no matches without changing saved settings", async () => {
	const settings = { ...defaultSettings(), provider: "test-provider", modelId: "target" };
	saveSettings(settings);
	const models = manyModels();
	const { ctx, selections, prompts } = wizardContext(models, models, ["zzzzz-no-match", undefined]);

	await runSettingsWizard(ctx);

	assert.equal(prompts.length, 2);
	assert.deepEqual(selections, []);
	assert.deepEqual(loadSettings(), settings);
});

function tuiContext(dialogKeys: string[][]) {
	const models = [model("alpha"), model("beta")];
	const { ctx, notifications } = wizardContext(models, models);
	Object.assign(ctx, { mode: "tui" });
	initTheme("dark", false);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const renders: string[] = [];
	ctx.ui.custom = (factory) => new Promise((resolve, reject) => {
		Promise.resolve(factory({ requestRender() {} } as TUI, theme, getKeybindings() as KeybindingsManager, resolve))
			.then((component) => {
				renders.push(stripVTControlCharacters(component.render(100).join("\n")));
				const keys = dialogKeys.shift();
				assert.ok(keys, "Unexpected custom dialog");
				for (const key of keys) component.handleInput?.(key);
				component.dispose?.();
			})
			.catch(reject);
	});
	return { ctx, notifications, renders };
}

test("TUI wizard preserves the saved model and pre-fills both numeric settings", async () => {
	const settings = { provider: "test-provider", modelId: "beta", maxVideoMb: 25, timeoutSeconds: 60 };
	saveSettings(settings);
	const { ctx, renders } = tuiContext([["\r"], ["\r"], ["\r"]]);
	await runSettingsWizard(ctx);
	assert.deepEqual(loadSettings(), settings);
	assert.match(renders[1], /> 25/);
	assert.match(renders[2], /> 60/);
});

test("TUI wizard supports editing and blank input through Pi's input component", async () => {
	const { ctx } = tuiContext([["beta", "\r"], ["\u0005", "\u0015", "30", "\r"], ["\u0005", "\u0015", "\r"]]);
	await runSettingsWizard(ctx);
	assert.deepEqual(loadSettings(), {
		...defaultSettings(), provider: "test-provider", modelId: "beta", maxVideoMb: 30,
	});
});

test("TUI cancellation after invalid numeric input leaves settings untouched", async () => {
	const settings = { ...defaultSettings(), provider: "test-provider", modelId: "beta" };
	saveSettings(settings);
	const { ctx, notifications } = tuiContext([["\r"], ["\u0005", "\u0015", "999", "\r"], ["\u001b"]]);
	await runSettingsWizard(ctx);
	assert.ok(notifications.some((message) => message.includes("Invalid value")));
	assert.deepEqual(loadSettings(), settings);
});

test("RPC numeric input retries invalid values without clamping user answers", async () => {
	const models = [model("video")];
	const { ctx, notifications } = wizardContext(models, models, ["0", "351", "1.5", "abc", "25", "4", "3601", "90"]);
	await runSettingsWizard(ctx);
	assert.equal(notifications.filter((message) => message.includes("Invalid value")).length, 6);
	assert.equal(loadSettings().maxVideoMb, 25);
	assert.equal(loadSettings().timeoutSeconds, 90);
});

test("wizard can replace corrupt settings with defaults and a selected model", async () => {
	writeFileSync(settingsFilePath(), "{ broken");
	const models = [model("video")];
	const { ctx, notifications } = wizardContext(models, models, ["", ""]);
	await runSettingsWizard(ctx);
	assert.ok(notifications.some((message) => message.includes("Starting from defaults")));
	assert.deepEqual(loadSettings(), { ...defaultSettings(), provider: "test-provider", modelId: "video" });
});
