import type { ListenedRange } from '$lib/domain/types';

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

export function mergeListenedRange(
	ranges: ListenedRange[],
	start: number,
	end: number,
	joinDistance = 0.2
): ListenedRange[] {
	const nextStart = safeDuration(Math.min(start, end));
	const nextEnd = safeDuration(Math.max(start, end));
	const candidates =
		nextEnd > nextStart ? [...ranges, { start: nextStart, end: nextEnd }] : [...ranges];
	const ordered = candidates
		.map((range) => ({
			start: safeDuration(Math.min(range.start, range.end)),
			end: safeDuration(Math.max(range.start, range.end))
		}))
		.filter((range) => range.end > range.start)
		.sort((left, right) => left.start - right.start);
	const merged: ListenedRange[] = [];
	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end + Math.max(0, joinDistance))
			previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

export function listenedDuration(ranges: ListenedRange[], duration: number): number {
	const limit = safeDuration(duration);
	return mergeListenedRange(ranges, 0, 0).reduce((total, range) => {
		const start = Math.min(limit, range.start);
		const end = Math.min(limit, range.end);
		return total + Math.max(0, end - start);
	}, 0);
}
