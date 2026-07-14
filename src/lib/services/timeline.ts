export interface TimelinePosition {
	index: number;
	offset: number;
}

function safeDuration(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function timelineDuration(durations: number[]): number {
	return durations.reduce((sum, duration) => sum + safeDuration(duration), 0);
}

export function absoluteTimelinePosition(
	durations: number[],
	index: number,
	offset: number
): number {
	if (!durations.length) return 0;
	const safeIndex = Math.max(0, Math.min(Math.trunc(index), durations.length - 1));
	const before = durations
		.slice(0, safeIndex)
		.reduce((sum, duration) => sum + safeDuration(duration), 0);
	return before + Math.max(0, Math.min(safeDuration(offset), safeDuration(durations[safeIndex])));
}

export function timelineProgress(durations: number[], index: number, offset: number): number {
	const total = timelineDuration(durations);
	return total ? absoluteTimelinePosition(durations, index, offset) / total : 0;
}

export function locateTimelinePosition(
	durations: number[],
	absoluteSeconds: number
): TimelinePosition {
	if (!durations.length) return { index: 0, offset: 0 };
	let remaining = Math.max(0, Math.min(safeDuration(absoluteSeconds), timelineDuration(durations)));
	for (let index = 0; index < durations.length; index += 1) {
		const duration = safeDuration(durations[index]);
		if (remaining <= duration || index === durations.length - 1) {
			return { index, offset: Math.min(remaining, duration) };
		}
		remaining -= duration;
	}
	return { index: durations.length - 1, offset: safeDuration(durations.at(-1) ?? 0) };
}
