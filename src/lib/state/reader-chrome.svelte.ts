class ReaderChromeState {
	outlineOpen = $state(true);
	bookmarksOpen = $state(false);
	menuOpen = $state(false);

	closeTransientPanels(): void {
		this.bookmarksOpen = false;
		this.menuOpen = false;
	}
}

export const readerChrome = new ReaderChromeState();
