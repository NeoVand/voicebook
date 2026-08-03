import { describe, expect, it } from 'vitest';
import { WebResearchError, parseWebResearchResponse, webResearchRequestBody } from './web-research';

describe('webResearchRequestBody', () => {
	it('asks for speakable sentences with the built-in search tool', () => {
		const body = webResearchRequestBody('gpt-5.6-luna', 'What is new in RLHF?');
		expect(body.model).toBe('gpt-5.6-luna');
		expect(body.input).toBe('What is new in RLHF?');
		expect(body.tools).toEqual([{ type: 'web_search' }]);
		expect(String(body.instructions)).toContain('three to five plain sentences');
		expect(body.max_output_tokens).toBeGreaterThan(0);
	});
});

describe('parseWebResearchResponse', () => {
	const payload = {
		status: 'completed',
		output: [
			{ type: 'reasoning' },
			{ type: 'web_search_call', status: 'completed' },
			{
				type: 'message',
				status: 'completed',
				content: [
					{
						type: 'output_text',
						text: 'The prize recognized neural-network foundations.\nIt went to Hopfield and Hinton.',
						annotations: [
							{
								type: 'url_citation',
								title: 'The Nobel Prize in Physics 2024',
								url: 'https://www.nobelprize.org/prizes/physics/2024/summary/?utm_source=openai&utm_medium=x'
							},
							{
								type: 'url_citation',
								title: 'Duplicate with tracking',
								url: 'https://www.nobelprize.org/prizes/physics/2024/summary/?utm_source=other'
							},
							{ type: 'file_citation', url: 'https://ignored.example' }
						]
					}
				]
			}
		]
	};

	it('joins the text, strips tracking params, and dedupes citations', () => {
		const finding = parseWebResearchResponse(payload);
		expect(finding.text).toBe(
			'The prize recognized neural-network foundations. It went to Hopfield and Hinton.'
		);
		expect(finding.citations).toEqual([
			{
				title: 'The Nobel Prize in Physics 2024',
				url: 'https://www.nobelprize.org/prizes/physics/2024/summary/'
			}
		]);
	});

	it('falls back to the url as a citation title', () => {
		const finding = parseWebResearchResponse({
			output: [
				{
					type: 'message',
					content: [
						{
							type: 'output_text',
							text: 'Answer.',
							annotations: [{ type: 'url_citation', url: 'https://example.org/a' }]
						}
					]
				}
			]
		});
		expect(finding.citations[0]).toEqual({
			title: 'https://example.org/a',
			url: 'https://example.org/a'
		});
	});

	it('names truncation when the response was cut off before answering', () => {
		// Measured live: reasoning + search turns count against max_output_tokens,
		// so a tight budget yields status 'incomplete' with no message item.
		expect(() =>
			parseWebResearchResponse({
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' },
				output: [{ type: 'reasoning' }, { type: 'web_search_call' }]
			})
		).toThrow(/ran long/);
		expect(() =>
			parseWebResearchResponse({ status: 'incomplete', output: [{ type: 'reasoning' }] })
		).toThrow('The web search did not finish.');
	});

	it('throws a readable error when no answer came back', () => {
		expect(() => parseWebResearchResponse({ output: [{ type: 'web_search_call' }] })).toThrow(
			WebResearchError
		);
		expect(() =>
			parseWebResearchResponse({ error: { message: 'The model is overloaded.' }, output: [] })
		).toThrow('The model is overloaded.');
	});
});
