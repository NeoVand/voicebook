import { describe, expect, it } from 'vitest';
import { sequenceDiagramCompatibilitySource } from './mermaid';

describe('Mermaid compatibility', () => {
	it('escapes prose semicolons in sequence messages without changing other diagrams', () => {
		expect(
			sequenceDiagramCompatibilitySource(
				[
					'sequenceDiagram',
					'  participant A as Reader',
					'  A->>B: recording notice;<br/>continue locally',
					'  Note over A,B: first clause; second clause'
				].join('\n')
			)
		).toContain('recording notice#59;<br/>continue locally');
		expect(sequenceDiagramCompatibilitySource('flowchart LR\n  A --> B;')).toBe(
			'flowchart LR\n  A --> B;'
		);
	});
});
