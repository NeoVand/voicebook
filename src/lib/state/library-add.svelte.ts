import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { appState } from '$lib/state/app-state.svelte';

/**
 * The app-wide "add to library" surface. The paste and URL dialogs and the
 * hidden file picker are rendered once in the layout (LibraryAddOverlays),
 * so the sidebar's plus menu — and the library page's buttons — can start an
 * import from any page, not just the library.
 */
class LibraryAddState {
	pasteOpen = $state(false);
	urlOpen = $state(false);

	/** Registered by the overlays component: opens the hidden file input. */
	private filePicker: (() => void) | null = null;

	registerFilePicker(picker: (() => void) | null): void {
		this.filePicker = picker;
	}

	pickFiles(): void {
		this.filePicker?.();
	}

	openPaste(): void {
		this.pasteOpen = true;
	}

	openUrl(): void {
		this.urlOpen = true;
	}

	/** Import picked or dropped files and open a single import in the reader. */
	async addFiles(files: File[]): Promise<void> {
		const imported = await appState.importFiles(files);
		if (files.length === 1 && imported[0]) {
			await goto(resolve(`/read?document=${encodeURIComponent(imported[0].id)}`));
		}
	}
}

export const libraryAdd = new LibraryAddState();
