export function generationPlan(
	segmentCount: number,
	currentIndex: number,
	bufferSize = 3,
	generateAll = false
): number[] {
	const count = Math.max(0, Math.trunc(segmentCount));
	if (!count) return [];
	const current = Math.max(0, Math.min(Math.trunc(currentIndex), count - 1));
	const forwardCount = generateAll ? count : Math.max(1, Math.trunc(bufferSize) + 1);
	const plan: number[] = [];
	for (let index = current; index < Math.min(count, current + forwardCount); index += 1)
		plan.push(index);
	if (generateAll) {
		for (let index = 0; index < current; index += 1) plan.push(index);
	}
	return plan;
}
