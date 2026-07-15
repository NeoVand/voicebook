import { describe, expect, it } from 'vitest';
import {
	absoluteTimelinePosition,
	listenedDuration,
	locateTimelinePosition,
	mergeListenedRange,
	timelineDuration,
	timelineProgress
} from './timeline';

describe('global playback timeline', () => {
	it('computes total, absolute, and relative positions', () => {
		const durations = [5, 10, 15];
		expect(timelineDuration(durations)).toBe(30);
		expect(absoluteTimelinePosition(durations, 1, 4)).toBe(9);
		expect(timelineProgress(durations, 1, 4)).toBe(0.3);
	});

	it('locates seeks and clamps corrupt values safely', () => {
		expect(locateTimelinePosition([5, 10, 15], 8)).toEqual({ index: 1, offset: 3 });
		expect(locateTimelinePosition([5, 10, 15], 999)).toEqual({ index: 2, offset: 15 });
		expect(locateTimelinePosition([5, Number.NaN, -3], -2)).toEqual({ index: 0, offset: 0 });
		expect(locateTimelinePosition([], 4)).toEqual({ index: 0, offset: 0 });
		expect(timelineProgress([], 4, 4)).toBe(0);
		expect(absoluteTimelinePosition([], 4, 4)).toBe(0);
		expect(absoluteTimelinePosition([5], 99, 99)).toBe(5);
	});

	it('merges listened ranges without treating skipped audio as heard', () => {
		let ranges = mergeListenedRange([], 4, 7);
		ranges = mergeListenedRange(ranges, 6.9, 9);
		ranges = mergeListenedRange(ranges, 1, 2);
		expect(ranges).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 9 }
		]);
		expect(listenedDuration(ranges, 8)).toBe(5);
		expect(mergeListenedRange(ranges, Number.NaN, Number.NaN)).toEqual(ranges);
	});
});
