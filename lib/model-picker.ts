import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

interface ModelPickerOptions {
	items: SelectItem[];
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	done: (id: string | undefined) => void;
	initialSelectedId?: string;
	subtitle: string;
}

/** Add fuzzy search to Pi's list; delegate navigation, scrolling and selection. */
export function createModelPicker({
	items,
	theme,
	keybindings,
	tui,
	done,
	initialSelectedId,
	subtitle,
}: ModelPickerOptions) {
	const input = new Input();
	let closed = false;
	const finish = (value?: string) => {
		if (closed) return;
		closed = true;
		done(value);
	};
	const createList = (matches: SelectItem[]) => {
		const list = new SelectList(matches, 10, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: () => theme.fg("muted", "  No matching models"),
		});
		list.onSelect = (item) => finish(item.value);
		list.onCancel = () => finish();
		return list;
	};
	let list = createList(items);
	list.setSelectedIndex(items.findIndex((item) => item.value === initialSelectedId));
	input.onSubmit = () => {
		const selected = list.getSelectedItem();
		if (selected) finish(selected.value);
	};

	return {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		handleInput(data) {
			if (closed) return;
			if (
				(["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
					.some((action) => keybindings.matches(data, action))
			) {
				list.handleInput(data);
			} else {
				const previous = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== previous) {
					const query = input.getValue().trim();
					list = createList(
						query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`) : items,
					);
				}
			}
			tui.requestRender();
		},
		render(width) {
			const text = (value: string) => new Text(value, 0, 0).render(width);
			const selected = list.getSelectedItem();
			return [
				"",
				...text(theme.fg("accent", theme.bold("Model for video analysis"))),
				...text(theme.fg("muted", subtitle)),
				"",
				...input.render(width),
				"",
				...list.render(width),
				// Keep the selected model readable even when list columns are truncated.
				...text(theme.fg("muted", [selected?.label, selected?.description].filter(Boolean).join("\n"))),
				"",
				...text(theme.fg("dim", "  Type to search · ↑/↓ navigate · Enter select · Esc cancel")),
				"",
			].map((line) => truncateToWidth(line, width));
		},
		invalidate() {
			input.invalidate();
			list.invalidate();
		},
	} satisfies Component & Focusable;
}
