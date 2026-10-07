/**
 * Pre-filled text input dialog for TUI extensions: title + Input seeded with
 * the current value, following the same pattern as SearchPickerComponent.
 * (ctx.ui.input only accepts a placeholder, not an initial value.)
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

export interface InputDialogOptions {
	/** Title shown above the input. */
	title: string;
	/** Value pre-filled in the input, e.g. the current setting. */
	initialValue: string;
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	/** Resolves the dialog with the entered value, or undefined on cancel. */
	done: (value: string | undefined) => void;
}

export class InputDialogComponent extends Container {
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly done: (value: string | undefined) => void;
	private readonly input: Input;
	private closed = false;

	constructor(options: InputDialogOptions) {
		super();

		this.keybindings = options.keybindings;
		this.tui = options.tui;
		this.done = options.done;

		this.addChild(new Spacer(1));
		this.addChild(new Text(options.theme.fg("accent", options.theme.bold(options.title)), 0, 0));
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(options.initialValue);
		this.input.onSubmit = () => this.confirm();
		this.input.onEscape = () => {
			this.close();
			this.done(undefined);
		};
		this.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(new Text(options.theme.fg("dim", "  Enter confirm · Esc cancel"), 0, 0));
		this.addChild(new Spacer(1));
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.close();
			this.done(undefined);
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	private confirm(): void {
		if (this.closed) return;
		const value = this.input.getValue();
		this.close();
		this.done(value);
	}

	private close(): void {
		this.closed = true;
	}
}
