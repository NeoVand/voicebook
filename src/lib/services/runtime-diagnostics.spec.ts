import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	beginRuntimeOperation,
	finishRuntimeOperation,
	recoverInterruptedRuntimeOperation
} from './runtime-diagnostics';

class MemoryStorage implements Storage {
	private values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return Array.from(this.values.keys())[index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

describe('runtime diagnostics', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', new MemoryStorage());
	});

	it('recovers an operation that was active when the previous page ended', () => {
		beginRuntimeOperation('speech-generation', { characters: 42, backend: 'webgpu' });
		const interruption = recoverInterruptedRuntimeOperation();

		expect(interruption).toMatchObject({
			operation: 'speech-generation',
			detail: { characters: 42, backend: 'webgpu' }
		});
		expect(recoverInterruptedRuntimeOperation()).toBeNull();
	});

	it('does not report an operation that completed normally', () => {
		const id = beginRuntimeOperation('model-load', { modelId: 'supertonic-3' });
		finishRuntimeOperation(id, 'completed');

		expect(recoverInterruptedRuntimeOperation()).toBeNull();
	});
});
