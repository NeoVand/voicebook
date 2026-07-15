import {
	AudioBufferSource,
	BufferTarget,
	Mp3OutputFormat,
	Output,
	canEncodeAudio
} from 'mediabunny';

export interface Mp3ExportPart {
	load: () => Promise<Blob>;
}

export interface Mp3ExportOptions {
	title: string;
	parts: Mp3ExportPart[];
	context: BaseAudioContext;
	onProgress?: (progress: number) => void;
}

let mp3EncoderReady: Promise<void> | undefined;

async function ensureMp3Encoder(): Promise<void> {
	mp3EncoderReady ??= (async () => {
		if (await canEncodeAudio('mp3')) return;
		const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
		registerMp3Encoder();
		if (!(await canEncodeAudio('mp3', { numberOfChannels: 1, sampleRate: 44_100 })))
			throw new Error('MP3 encoding is unavailable in this browser.');
	})();
	await mp3EncoderReady;
}

export async function encodeDocumentMp3({
	title,
	parts,
	context,
	onProgress
}: Mp3ExportOptions): Promise<Blob> {
	if (!parts.length) throw new Error('This document has no prepared audio to export.');
	await ensureMp3Encoder();

	const target = new BufferTarget();
	const output = new Output({ format: new Mp3OutputFormat(), target });
	const source = new AudioBufferSource({
		codec: 'mp3',
		bitrate: 128_000,
		transform: { sampleRate: 44_100, numberOfChannels: 1 }
	});
	output.addAudioTrack(source);
	output.setMetadataTags({ title, artist: 'Voicebook' });

	try {
		await output.start();
		for (const [index, part] of parts.entries()) {
			const buffer = await context.decodeAudioData(await (await part.load()).arrayBuffer());
			await source.add(buffer);
			onProgress?.((index + 1) / parts.length);
		}
		await output.finalize();
	} catch (error) {
		if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel();
		throw error;
	}

	if (!target.buffer) throw new Error('The MP3 encoder returned no audio data.');
	return new Blob([target.buffer], { type: 'audio/mpeg' });
}

export function mp3Filename(title: string): string {
	const withoutReservedCharacters = title.normalize('NFKC').replace(/[\\/:*?"<>|]/g, ' ');
	const withoutControlCharacters = Array.from(withoutReservedCharacters, (character) =>
		(character.codePointAt(0) ?? 0) < 32 ? ' ' : character
	).join('');
	const safeTitle = withoutControlCharacters.replace(/\s+/g, ' ').trim().slice(0, 120);
	return `${safeTitle || 'Voicebook document'}.mp3`;
}
