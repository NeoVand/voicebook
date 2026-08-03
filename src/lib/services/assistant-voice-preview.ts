/**
 * Short spoken samples of the assistant's voices, so the picker is more than
 * a list of names. The realtime voice ids are also valid on OpenAI's speech
 * endpoint, which is far cheaper than opening a realtime session: one small
 * MP3 per voice, fetched with the user's own key and cached for the session.
 * One preview plays at a time; starting another (or the same one again)
 * stops the current playback.
 */

const PREVIEW_TEXT =
	'Hi! I read along with you — ask me anything about the page, and I can point at the parts I mention.';

const PREVIEW_MODEL = 'gpt-4o-mini-tts';

const sampleCache = new Map<string, Blob>();

let audio: HTMLAudioElement | null = null;
let playingVoice: string | null = null;
let objectUrl: string | null = null;

export class VoicePreviewError extends Error {}

function stopAudio(): void {
	if (audio) {
		audio.pause();
		audio.src = '';
	}
	if (objectUrl) {
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	}
	playingVoice = null;
}

/** Stop whatever preview is playing (leaving the picker, closing settings). */
export function stopVoicePreview(): void {
	stopAudio();
}

async function fetchSample(voice: string, apiKey: string): Promise<Blob> {
	const cached = sampleCache.get(voice);
	if (cached) return cached;
	const response = await fetch('https://api.openai.com/v1/audio/speech', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: PREVIEW_MODEL,
			voice,
			input: PREVIEW_TEXT,
			response_format: 'mp3'
		})
	});
	if (!response.ok) {
		let detail = '';
		try {
			const body = (await response.json()) as { error?: { message?: string } };
			detail = body.error?.message ?? '';
		} catch {
			// Non-JSON error body; the status alone will have to do.
		}
		throw new VoicePreviewError(
			detail || `The voice sample could not be fetched (HTTP ${response.status}).`
		);
	}
	const blob = await response.blob();
	sampleCache.set(voice, blob);
	return blob;
}

/**
 * Play a voice's sample. Resolves once playback has STARTED (so a picker can
 * swap its loading state for a playing one) with a `finished` promise that
 * settles when the sample ends or is replaced. Calling for the voice that is
 * already sounding stops it and resolves null.
 */
export async function previewAssistantVoice(
	voice: string,
	apiKey: string
): Promise<{ finished: Promise<void> } | null> {
	if (playingVoice === voice) {
		stopAudio();
		return null;
	}
	stopAudio();
	const blob = await fetchSample(voice, apiKey);
	audio ??= new Audio();
	objectUrl = URL.createObjectURL(blob);
	audio.src = objectUrl;
	playingVoice = voice;
	await audio.play();
	const element = audio;
	const finished = new Promise<void>((resolve) => {
		const done = () => {
			element.removeEventListener('ended', done);
			element.removeEventListener('pause', done);
			if (playingVoice === voice) stopAudio();
			resolve();
		};
		element.addEventListener('ended', done);
		element.addEventListener('pause', done);
	});
	return { finished };
}
