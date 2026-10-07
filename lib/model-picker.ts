/**
 * Searchable picker component for TUI dialogs: a fuzzy-filtered list with a
 * type-to-search input, following the same pattern as Pi's built-in model
 * selector (Input + fuzzyFilter + keybinding navigation).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	type KeybindingsManager,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";

export interface PickerItem {
	/** Unique key returned on selection. */
	id: string;
	/** Primary line shown in the list, e.g. "openrouter / google/gemini-2.5-flash". */
	label: string;
	/** Optional secondary line shown for the highlighted item, e.g. the model's display name. */
	detail?: string;
	/** Extra short badges appended to the label, e.g. "current" or "no auth". */
	badges?: string[];
	/** Text the fuzzy filter matches against (label + detail + badges by default). */
	searchText?: string;
}

export interface SearchPickerOptions {
	items: PickerItem[];
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	/** Resolves the dialog with the selected item id, or undefined on cancel. */
	done: (id: string | undefined) => void;
	/** Item highlighted initially (defaults to the first). */
	initialSelectedId?: string;
	/** Title shown above the search input. */
	title?: string;
	/** Dim line shown below the title, e.g. a summary of current settings. */
	subtitle?: string;
}

const MAX_VISIBLE = 10;

export class SearchPickerComponent extends Container {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly done: (id: string | undefined) => void;
	private readonly allItems: PickerItem[];
	private readonly searchTextOf: (item: PickerItem) => string;

	private readonly searchInput: Input;
	private readonly listContainer = new Container();
	private readonly detailText: Text;

	private filtered: PickerItem[];
	private selectedIndex = 0;
	private closed = false;

	constructor(options: SearchPickerOptions) {
		super();

		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.tui = options.tui;
		this.done = options.done;
		this.allItems = options.items;
		this.searchTextOf = (item) =>
			item.searchText ?? [item.label, item.detail, ...(item.badges ?? [])].filter(Boolean).join(" ");

		this.addChild(new Spacer(1));
		if (options.title) {
			this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 0, 0));
		}
		if (options.subtitle) {
			this.addChild(new Text(this.theme.fg("muted", options.subtitle), 0, 0));
		}
		if (options.title || options.subtitle) {
			this.addChild(new Spacer(1));
		}

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.confirm();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.addChild(this.listContainer);
		this.detailText = new Text("", 0, 0);
		this.addChild(this.detailText);

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", "  Type to search · ↑/↓ navigate · Enter select · Esc cancel"), 0, 0));
		this.addChild(new Spacer(1));

		this.filtered = this.allItems;
		const initial =
			options.initialSelectedId !== undefined
				? this.filtered.findIndex((item) => item.id === options.initialSelectedId)
				: 0;
		this.selectedIndex = Math.max(0, initial);
		this.updateList();
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.close();
			this.done(undefined);
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	private confirm(): void {
		const selected = this.filtered[this.selectedIndex];
		if (!selected) return;
		this.close();
		this.done(selected.id);
	}

	private close(): void {
		this.closed = true;
	}

	private filter(query: string): void {
		const trimmed = query.trim();
		this.filtered = trimmed
			? fuzzyFilter(this.allItems, trimmed, this.searchTextOf)
			: this.allItems;
		// Top row highlights the best match while searching; otherwise keep the
		// initial position clamped to the restored list length.
		this.selectedIndex = trimmed
			? 0
			: Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		const theme = this.theme;
		this.listContainer.clear();

		const total = this.filtered.length;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, total);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
			const badges = (item.badges ?? []).map((badge) => theme.fg("muted", ` · ${badge}`)).join("");
			this.listContainer.addChild(new Text(`${cursor}${label}${badges}`, 0, 0));
		}

		if (total === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			this.detailText.setText("");
			return;
		}

		if (startIndex > 0 || endIndex < total) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 0, 0));
		}

		const selected = this.filtered[this.selectedIndex];
		this.detailText.setText(
			selected?.detail ? theme.fg("muted", `  ${selected.detail}`) : "",
		);
	}
}
