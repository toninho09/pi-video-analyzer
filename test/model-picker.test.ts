import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	getKeybindings,
	KeybindingsManager,
	type SelectItem,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createModelPicker } from "../lib/model-picker.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const items: SelectItem[] = [
	{ value: "p/a", label: "provider / alpha", description: "First model" },
	{ value: "p/b", label: "provider / beta (current)", description: "Gemini Flash" },
];

function picker(options: { items?: SelectItem[]; initialSelectedId?: string } = {}) {
	const results: (string | undefined)[] = [];
	const component = createModelPicker({
		items,
		theme,
		keybindings: getKeybindings(),
		tui: { requestRender() {} } as TUI,
		done: (value) => results.push(value),
		subtitle: "Current: provider/beta",
		...options,
	});
	return { component, results };
}

test("picker initially selects the saved model and completes only once", () => {
	const { component, results } = picker({ initialSelectedId: "p/b" });
	assert.match(component.render(80).join("\n"), /→.*beta \(current\)/);
	component.handleInput("\r");
	component.handleInput("\r");
	assert.deepEqual(results, ["p/b"]);
});

for (const query of ["prv bta", "gem flsh"]) {
	test(`picker fuzzy-searches provider, model id and display name: ${query}`, () => {
		const { component, results } = picker();
		component.handleInput(query);
		component.handleInput("\r");
		assert.deepEqual(results, ["p/b"]);
	});
}

test("no matches cannot be confirmed; clearing the query restores the list", () => {
	const { component, results } = picker();
	component.handleInput("zzzzzz");
	assert.match(component.render(80).join("\n"), /No matching models/);
	component.handleInput("\u001b[B");
	component.handleInput("\r");
	assert.deepEqual(results, []);
	component.handleInput("\u0015"); // Ctrl+U
	component.handleInput("\r");
	assert.deepEqual(results, ["p/a"]);
});

test("navigation wraps and scrolls through all models", () => {
	const many = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `model ${i}` }));
	const { component, results } = picker({ items: many });
	component.handleInput("\u001b[A"); // Up wraps to last
	const lines = component.render(80).join("\n");
	assert.match(lines, /→ model 19/);
	assert.match(lines, /20\/20/);
	assert.doesNotMatch(lines, /model 0\n/);
	component.handleInput("\u001b[B");
	component.handleInput("\r");
	assert.deepEqual(results, ["0"]);
});

test("picker uses configured navigation bindings", (t) => {
	const previous = getKeybindings();
	t.after(() => setKeybindings(previous));
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n" }));
	const { component, results } = picker();
	component.handleInput("\u000e");
	component.handleInput("\r");
	assert.deepEqual(results, ["p/b"]);
});

test("picker cancellation works even with no matches", () => {
	const { component, results } = picker();
	component.handleInput("zzzzzz");
	component.handleInput("\u001b");
	assert.deepEqual(results, [undefined]);
});

test("picker keeps full model details, forwards focus and respects narrow terminal widths", () => {
	const selected = { value: "long", label: "provider / model-with-a-long-identifier", description: "Display name" };
	const { component } = picker({ items: [selected] });
	assert.ok(component.render(80).join("\n").includes(selected.label));
	assert.ok(component.render(20).join("\n").includes(selected.description));
	component.focused = true;
	assert.ok(component.render(80).some((line) => line.includes(CURSOR_MARKER)));
	component.focused = false;
	assert.ok(component.render(80).every((line) => !line.includes(CURSOR_MARKER)));
	for (const query of ["", "zzzzzz"]) {
		component.handleInput(query);
		for (const width of [10, 20, 40]) {
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
		}
	}
});
