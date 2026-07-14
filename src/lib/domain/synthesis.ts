export const MIN_GENERATION_STEPS = 2;
export const MAX_GENERATION_STEPS = 16;
export const DEFAULT_GENERATION_STEPS = 10;

export const GENERATION_STEP_OPTIONS = Array.from(
	{ length: MAX_GENERATION_STEPS - MIN_GENERATION_STEPS + 1 },
	(_, index) => MIN_GENERATION_STEPS + index
);

export function normalizeGenerationSteps(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) return DEFAULT_GENERATION_STEPS;
	return Math.max(MIN_GENERATION_STEPS, Math.min(MAX_GENERATION_STEPS, Math.round(numeric)));
}
