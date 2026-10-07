/**
 * Interactive wizard behind /pi-video-analyser:settings: pick a model, then
 * the size limit and timeout, and persist them.
 */

import { type ExtensionCommandContext, ExtensionInputComponent } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type SelectItem } from "@earendil-works/pi-tui";
import { createModelPicker } from "./model-picker.ts";
import {
	defaultSettings,
	loadSettings,
	MAX_VIDEO_MB_RANGE,
	saveSettings,
	settingsFilePath,
	TIMEOUT_SECONDS_RANGE,
	type VideoAnalyserSettings,
} from "./settings.ts";

/** pi APIs whose providers expose an OpenAI-compatible chat-completions endpoint we can call directly. */
const COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

/** With more candidates than this, non-TUI sessions must search before selecting. */
const DIRECT_SELECT_LIMIT = 30;

/** Unique picker key for a provider/model pair. */
function modelKey(provider: string, modelId: string): string {
	return `${provider}\0${modelId}`;
}

export async function runSettingsWizard(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/pi-video-analyser:settings needs an interactive session.", "error");
		return;
	}

	let settings: VideoAnalyserSettings;
	try {
		settings = loadSettings();
	} catch (error) {
		// Saving below overwrites the broken file with valid settings.
		ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Starting from defaults.`, "warning");
		settings = defaultSettings();
	}

	const models = ctx.modelRegistry
		.getAvailable()
		.filter((model) => COMPATIBLE_APIS.has(model.api))
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

	if (models.length === 0) {
		ctx.ui.notify("No authenticated OpenAI-compatible models available. Use /login to sign in first.", "error");
		return;
	}

	const currentId =
		settings.provider && settings.modelId ? modelKey(settings.provider, settings.modelId) : undefined;
	const items: SelectItem[] = models.map((model) => {
		const value = modelKey(model.provider, model.id);
		return {
			value,
			label: `${model.provider} / ${model.id}${currentId === value ? " (current)" : ""}`,
			description: model.name,
		};
	});

	const currentSummary =
		settings.provider && settings.modelId
			? `Current: ${settings.provider}/${settings.modelId} · max ${settings.maxVideoMb} MB · timeout ${settings.timeoutSeconds}s`
			: "Current: not configured";

	const chosenId = await pickModel(ctx, items, currentId, currentSummary);
	if (chosenId === undefined) return;
	const chosenModel = models.find((m) => modelKey(m.provider, m.id) === chosenId);
	if (!chosenModel) return;

	const maxVideoMb = await askInteger(ctx, "Max video size in MB", MAX_VIDEO_MB_RANGE, settings.maxVideoMb);
	if (maxVideoMb === undefined) return;
	const timeoutSeconds = await askInteger(
		ctx,
		"Request timeout in seconds",
		TIMEOUT_SECONDS_RANGE,
		settings.timeoutSeconds,
	);
	if (timeoutSeconds === undefined) return;

	saveSettings({
		provider: chosenModel.provider,
		modelId: chosenModel.id,
		maxVideoMb,
		timeoutSeconds,
	});
	ctx.ui.notify(
		`Saved: ${chosenModel.provider}/${chosenModel.id}, max ${maxVideoMb} MB, timeout ${timeoutSeconds}s → ${settingsFilePath()}`,
		"info",
	);
}

async function pickModel(
	ctx: ExtensionCommandContext,
	items: SelectItem[],
	currentId: string | undefined,
	currentSummary: string,
): Promise<string | undefined> {
	if (ctx.mode === "tui") {
		// Searchable picker with type-to-filter (same pattern as /model).
		return ctx.ui.custom(
			(tui, theme, keybindings, done) =>
				createModelPicker({
					items,
					theme,
					keybindings,
					tui,
					done,
					initialSelectedId: currentId,
					subtitle: currentSummary,
				}),
		);
	}

	// RPC fallback: search with a text prompt, then pick from the matches.
	ctx.ui.notify(currentSummary, "info");
	while (true) {
		let matches = items;
		if (items.length > DIRECT_SELECT_LIMIT) {
			const query = await ctx.ui.input("Search models (fuzzy match)", "e.g. gemini");
			if (query === undefined) return undefined;
			matches = query.trim() ? fuzzyFilter(items, query.trim(), (item) => item.label) : items;
			if (matches.length === 0) {
				ctx.ui.notify(`No models match "${query.trim()}".`, "warning");
				continue;
			}
			if (matches.length > DIRECT_SELECT_LIMIT) {
				ctx.ui.notify(`${matches.length} matches — refine the search.`, "warning");
				continue;
			}
		}
		const chosen = await ctx.ui.select("Model for video analysis", matches.map((item) => item.label));
		return matches.find((item) => item.label === chosen)?.value;
	}
}

/**
 * Ask for an integer in range. TUI pre-fills the current value (ctx.ui.input
 * only takes a placeholder, so TUI uses a custom dialog); an empty answer keeps
 * the current value. Invalid input re-asks; only an explicit cancel aborts.
 */
async function askInteger(
	ctx: ExtensionCommandContext,
	title: string,
	range: readonly [number, number],
	current: number,
): Promise<number | undefined> {
	const fullTitle = `${title} (${range[0]}-${range[1]}, empty keeps ${current})`;
	while (true) {
		const raw =
			ctx.mode === "tui"
				? await ctx.ui.custom<string | undefined>(
						(tui, _theme, _keybindings, done) =>
							new ExtensionInputComponent(fullTitle, undefined, done, () => done(undefined), {
								tui,
								initialValue: String(current),
							}),
					)
				: await ctx.ui.input(fullTitle, String(current));
		if (raw === undefined) return undefined;
		const trimmed = raw.trim();
		if (trimmed === "") return current;
		const parsed = Number(trimmed);
		if (Number.isInteger(parsed) && parsed >= range[0] && parsed <= range[1]) {
			return parsed;
		}
		ctx.ui.notify(
			`Invalid value for "${title}": "${trimmed}" — expected an integer between ${range[0]} and ${range[1]}.`,
			"error",
		);
	}
}
