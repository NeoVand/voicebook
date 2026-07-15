export type RuntimeOperation = 'model-load' | 'speech-generation';

interface ActiveRuntimeOperation {
	id: string;
	operation: RuntimeOperation;
	startedAt: number;
	detail?: Record<string, string | number | boolean | undefined>;
}

interface RuntimeEvent {
	timestamp: number;
	type: string;
	message: string;
}

export interface InterruptedRuntimeOperation extends ActiveRuntimeOperation {
	ageMs: number;
}

const ACTIVE_OPERATION_KEY = 'voicebook:runtime-active-operation';
const RUNTIME_EVENTS_KEY = 'voicebook:runtime-events';
const MAX_EVENTS = 24;
const MAX_INTERRUPTION_AGE_MS = 24 * 60 * 60 * 1_000;

function storageAvailable(): boolean {
	return typeof localStorage !== 'undefined';
}

function parseJson<T>(value: string | null, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	if (!storageAvailable()) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Diagnostics must never interfere with playback or installation.
	}
}

export function recordRuntimeEvent(type: string, message: string): void {
	if (!storageAvailable()) return;
	const events = parseJson<RuntimeEvent[]>(localStorage.getItem(RUNTIME_EVENTS_KEY), []);
	events.push({ timestamp: Date.now(), type, message: message.slice(0, 500) });
	writeJson(RUNTIME_EVENTS_KEY, events.slice(-MAX_EVENTS));
}

export function beginRuntimeOperation(
	operation: RuntimeOperation,
	detail?: ActiveRuntimeOperation['detail']
): string {
	const marker: ActiveRuntimeOperation = {
		id: crypto.randomUUID(),
		operation,
		startedAt: Date.now(),
		detail
	};
	writeJson(ACTIVE_OPERATION_KEY, marker);
	recordRuntimeEvent(operation, 'started');
	return marker.id;
}

export function finishRuntimeOperation(
	id: string,
	outcome: 'completed' | 'failed',
	message = ''
): void {
	if (!storageAvailable()) return;
	const active = parseJson<ActiveRuntimeOperation | null>(
		localStorage.getItem(ACTIVE_OPERATION_KEY),
		null
	);
	if (active?.id === id) localStorage.removeItem(ACTIVE_OPERATION_KEY);
	recordRuntimeEvent(active?.operation ?? 'runtime', `${outcome}${message ? `: ${message}` : ''}`);
}

export function recoverInterruptedRuntimeOperation(): InterruptedRuntimeOperation | null {
	if (!storageAvailable()) return null;
	const active = parseJson<ActiveRuntimeOperation | null>(
		localStorage.getItem(ACTIVE_OPERATION_KEY),
		null
	);
	localStorage.removeItem(ACTIVE_OPERATION_KEY);
	if (!active) return null;
	const ageMs = Date.now() - active.startedAt;
	if (ageMs < 0 || ageMs > MAX_INTERRUPTION_AGE_MS) return null;
	recordRuntimeEvent(active.operation, 'previous page ended before the operation completed');
	return { ...active, ageMs };
}

export function runtimeDiagnosticsReport(): string {
	const events = storageAvailable()
		? parseJson<RuntimeEvent[]>(localStorage.getItem(RUNTIME_EVENTS_KEY), [])
		: [];
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	const lines = [
		'Voicebook local runtime diagnostics',
		`Created: ${new Date().toISOString()}`,
		`User agent: ${navigator.userAgent}`,
		`Platform: ${navigator.platform || 'unknown'}`,
		`Logical processors: ${navigator.hardwareConcurrency || 'unknown'}`,
		`Device memory hint: ${memory ? `${memory} GB` : 'unavailable'}`,
		`Visibility: ${document.visibilityState}`,
		'',
		'Recent runtime events:'
	];
	if (!events.length) lines.push('- None recorded');
	for (const event of events) {
		lines.push(`- ${new Date(event.timestamp).toISOString()} [${event.type}] ${event.message}`);
	}
	return lines.join('\n');
}
