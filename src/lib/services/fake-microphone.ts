/**
 * Development-only stand-in microphone: a MediaStream fed from WebAudio, so
 * the voice assistant can be driven with no microphone at all — from the
 * browser console or an automated test. `say(text)` synthesizes the words
 * with OpenAI's speech endpoint (the dev key) and plays them into the stream;
 * `play(url)` plays a recording. Between clips the stream carries silence,
 * like a quiet room. Enabled with `?fakeMic` in the address or
 * localStorage 'voicebook:fake-mic' = '1'. Never part of a production build:
 * microphone.ts only imports it behind `import.meta.env.DEV`.
 */

interface FakeMicrophoneApi {
	say(text: string, voice?: string): Promise<void>;
	play(source: string | Blob): Promise<void>;
	/** A clip is playing into the stream. */
	readonly speaking: boolean;
}

declare global {
	interface Window {
		voicebookFakeMic?: FakeMicrophoneApi;
	}
}

let context: AudioContext | undefined;
let destination: MediaStreamAudioDestinationNode | undefined;
let playing = 0;

export function fakeMicrophoneRequested(): boolean {
	try {
		return (
			new URL(window.location.href).searchParams.has('fakeMic') ||
			window.localStorage.getItem('voicebook:fake-mic') === '1'
		);
	} catch {
		return false;
	}
}

/** A real microphone always hears a little room noise. An idle WebAudio
 * graph produces no frames at all — WebRTC then sends no packets, and
 * GPT-Live's session clock (which the voice's speech runs on) stops. */
const NOISE_FLOOR = 0.0003;

function graph(): { context: AudioContext; destination: MediaStreamAudioDestinationNode } {
	if (!context || !destination || context.state === 'closed') {
		context = new AudioContext({ sampleRate: 24_000 });
		destination = context.createMediaStreamDestination();
		const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
		const samples = noise.getChannelData(0);
		for (let index = 0; index < samples.length; index += 1) {
			samples[index] = (Math.random() * 2 - 1) * NOISE_FLOOR;
		}
		const room = context.createBufferSource();
		room.buffer = noise;
		room.loop = true;
		room.connect(destination);
		room.start();
	}
	if (context.state === 'suspended') void context.resume().catch(() => undefined);
	return { context, destination };
}

/** The stream the assistant receives instead of the microphone's. Every call
 * returns a fresh stream on the same graph, so a stopped session's tracks
 * never silence the next one. */
export function fakeMicrophoneStream(): MediaStream {
	const { destination: node } = graph();
	return new MediaStream(node.stream.getAudioTracks().map((track) => track.clone()));
}

async function playBuffer(bytes: ArrayBuffer): Promise<void> {
	const { context: audio, destination: node } = graph();
	const buffer = await audio.decodeAudioData(bytes);
	const source = audio.createBufferSource();
	source.buffer = buffer;
	source.connect(node);
	playing += 1;
	await new Promise<void>((resolve) => {
		source.onended = () => resolve();
		source.start();
	});
	playing -= 1;
}

async function say(text: string, voice = 'ash'): Promise<void> {
	const apiKey = import.meta.env.VITE_DEV_OPENAI_API_KEY;
	if (!apiKey) throw new Error('The fake microphone speaks with the dev OpenAI key (.env).');
	const response = await fetch('https://api.openai.com/v1/audio/speech', {
		method: 'POST',
		headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'wav' })
	});
	if (!response.ok) throw new Error(`Speech synthesis failed (${response.status}).`);
	await playBuffer(await response.arrayBuffer());
}

async function play(source: string | Blob): Promise<void> {
	const bytes =
		typeof source === 'string'
			? await (await fetch(source)).arrayBuffer()
			: await source.arrayBuffer();
	await playBuffer(bytes);
}

if (typeof window !== 'undefined') {
	window.voicebookFakeMic = {
		say,
		play,
		get speaking() {
			return playing > 0;
		}
	};
}
