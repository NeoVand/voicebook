class ReaderChromeState {
	/** Contents starts closed — the document is the point. */
	outlineOpen = $state(false);
	menuOpen = $state(false);
	documentZoom = $state(1);

	get zoomPercent(): number {
		return Math.round(this.documentZoom * 100);
	}

	get documentCanvasWidth(): number {
		return Math.round(900 * this.documentZoom);
	}

	hydratePreferences(): void {
		if (typeof window === 'undefined') return;
		const stored = Number(window.localStorage.getItem('voicebook:document-zoom'));
		if (Number.isFinite(stored) && stored >= 0.8 && stored <= 1.6) this.documentZoom = stored;
	}

	setDocumentZoom(value: number): void {
		// 1% resolution — the zoom control is a near-continuous slider.
		this.documentZoom = Math.round(Math.min(1.6, Math.max(0.8, value)) * 100) / 100;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:document-zoom', String(this.documentZoom));
		}
	}

	resetZoom(): void {
		this.setDocumentZoom(1);
	}

	closeTransientPanels(): void {
		this.menuOpen = false;
	}
}

export const readerChrome = new ReaderChromeState();
