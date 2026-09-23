// Records the preview clips for GPT-Live's own voices. OpenAI's speech
// endpoint rejects them, so the only way to hear one is a Live session: each
// voice gets a short session over WebSocket, is asked to say the preview line,
// and its audio is encoded to a small MP3 under static/voice-previews/.
//
// Usage: OPENAI_API_KEY=sk-... node scripts/record-live-voice-previews.mjs [voice ...]
// (falls back to VITE_DEV_OPENAI_API_KEY in .env). Needs ffmpeg. Costs about
// $0.02 per voice at GPT-Live's per-minute rate.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const LINES = {
	en: 'Hi! I read along with you — ask me anything about the page, and I can point at the parts I mention.',
	pt: 'Oi! Eu leio junto com você — pergunte qualquer coisa sobre a página, e eu mostro as partes que menciono.'
};
const VOICES = {
	gleam: 'en',
	meridian: 'en',
	vesper: 'en',
	willow: 'en',
	stone: 'en',
	quartz: 'en',
	ripple: 'en',
	delta: 'en',
	cinder: 'en',
	beacon: 'en',
	bossa: 'pt',
	tempo: 'pt'
};
const RATE = 24_000;
const OUT = new URL('../static/voice-previews/', import.meta.url).pathname;

function apiKey() {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
	return (env.match(/^VITE_DEV_OPENAI_API_KEY\s*=\s*"?([^"\n]+)"?/m) || [])[1]?.trim();
}

function wav(pcm) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVEfmt ', 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function record(voice, line, key) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
			headers: { Authorization: `Bearer ${key}` }
		});
		const chunks = [];
		let transcript = '';
		// Output audio flows continuously, silence included — the end of the
		// line shows in the transcript going quiet.
		let lastWords = 0;
		let pump;
		const finish = (error) => {
			clearInterval(pump);
			clearTimeout(deadline);
			try {
				ws.send(JSON.stringify({ type: 'session.close' }));
			} catch {
				// Already gone.
			}
			setTimeout(() => ws.close(), 500);
			if (error) reject(error);
			else resolve({ pcm: Buffer.concat(chunks), transcript: transcript.trim() });
		};
		const deadline = setTimeout(() => finish(new Error(`${voice}: timed out`)), 30_000);
		ws.on('open', () => {
			ws.send(
				JSON.stringify({
					type: 'session.start',
					session: {
						model: 'gpt-live-1',
						instructions:
							'You are a warm, friendly reading companion. Speak naturally, at an unhurried pace.',
						audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice } }
					}
				})
			);
		});
		ws.on('message', (raw) => {
			const event = JSON.parse(raw.toString());
			if (process.env.DEBUG && !/audio\.delta|usage/.test(event.type)) {
				console.log('  event', event.type, JSON.stringify(event).slice(0, 200));
			}
			if (event.type === 'session.started') {
				// Input audio drives the session clock: keep silence flowing.
				pump = setInterval(() => {
					ws.send(
						JSON.stringify({
							type: 'session.input_audio.append',
							audio: Buffer.alloc((RATE / 10) * 2).toString('base64')
						})
					);
					if (lastWords && Date.now() - lastWords > 1500) finish();
				}, 100);
				ws.send(
					JSON.stringify({
						type: 'session.instructions.append',
						delegation_id: null,
						content: `Immediately say the following exactly and in full, then stop and listen: ${line}`
					})
				);
			} else if (event.type === 'session.output_audio.delta') {
				chunks.push(Buffer.from(event.delta, 'base64'));
			} else if (event.type === 'session.output_transcript.delta') {
				transcript += event.delta;
				lastWords = Date.now();
			} else if (event.type === 'error') {
				finish(new Error(`${voice}: ${JSON.stringify(event.error)}`));
			}
		});
		ws.on('error', (error) => finish(error));
	});
}

/** Words of the transcript that are not in the line — a paraphrase shows up
 * here and the clip is recorded again. */
function stray(transcript, line) {
	const words = (text) =>
		text
			.toLowerCase()
			.normalize('NFKD')
			.match(/\p{L}+/gu) ?? [];
	const expected = new Set(words(line));
	return words(transcript).filter((word) => !expected.has(word));
}

const key = apiKey();
if (!key) throw new Error('Set OPENAI_API_KEY (or VITE_DEV_OPENAI_API_KEY in .env).');
mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VOICES);
for (const voice of wanted) {
	const line = LINES[VOICES[voice] ?? 'en'];
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		let recorded;
		try {
			recorded = await record(voice, line, key);
		} catch (error) {
			console.log(`${voice} attempt ${attempt}: ${error.message}, retrying`);
			continue;
		}
		const { pcm, transcript } = recorded;
		const extra = stray(transcript, line);
		if (!pcm.length || extra.length > 1) {
			console.log(
				`${voice} attempt ${attempt}: off script (${JSON.stringify(transcript)}), retrying`
			);
			continue;
		}
		const temp = join(tmpdir(), `${voice}.wav`);
		writeFileSync(temp, wav(pcm));
		const target = join(OUT, `${voice}.mp3`);
		execFileSync('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-i',
			temp,
			// Trim leading and trailing silence, even out loudness across the
			// voices, then a small mono MP3.
			'-af',
			'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,loudnorm=I=-18:TP=-2:LRA=11',
			'-ar',
			String(RATE),
			'-ac',
			'1',
			'-b:a',
			'48k',
			target
		]);
		rmSync(temp);
		console.log(`${voice}: ${(pcm.length / 2 / RATE).toFixed(1)} s → ${target} (“${transcript}”)`);
		break;
	}
}
