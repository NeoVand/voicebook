import type { ModelDescriptor, VoiceDescriptor } from './types';

const supertonicVoices: VoiceDescriptor[] = [
	...['F1', 'F2', 'F3', 'F4', 'F5'].map((id, index) => ({
		id,
		name: `Studio ${index + 1}`,
		language: 'Multilingual',
		gender: 'Female'
	})),
	...['M1', 'M2', 'M3', 'M4', 'M5'].map((id, index) => ({
		id,
		name: `Narrator ${index + 1}`,
		language: 'Multilingual',
		gender: 'Male'
	}))
];

export const MODEL_CATALOG: ModelDescriptor[] = [
	{
		id: 'supertonic-3',
		name: 'Supertonic 3',
		repository: 'Supertone/supertonic-3',
		revision: '3cadd1ee6394adea1bd021217a0e650ede09a323',
		license: 'OpenRAIL-M',
		licenseUrl: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
		description:
			'The latest multilingual Supertone engine, with 31 languages and ten studio voices.',
		sizeMb: 415,
		languages: [
			'English',
			'Korean',
			'Japanese',
			'Arabic',
			'Bulgarian',
			'Czech',
			'Danish',
			'German',
			'Greek',
			'Spanish',
			'Estonian',
			'Finnish',
			'French',
			'Hindi',
			'Croatian',
			'Hungarian',
			'Indonesian',
			'Italian',
			'Lithuanian',
			'Latvian',
			'Dutch',
			'Polish',
			'Portuguese',
			'Romanian',
			'Russian',
			'Slovak',
			'Slovenian',
			'Swedish',
			'Turkish',
			'Ukrainian',
			'Vietnamese'
		],
		voices: supertonicVoices,
		defaultVoice: 'F1',
		supportsWebGpu: true,
		supportsWasm: true,
		nativeTiming: 'none',
		voiceCloning: false
	}
];

export function getModel(id: ModelDescriptor['id']): ModelDescriptor {
	const model = MODEL_CATALOG.find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Unknown model: ${id}`);
	return model;
}
