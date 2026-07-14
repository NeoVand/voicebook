import {
	AudioBufferSource,
	BufferTarget,
	Output,
	WebMOutputFormat,
	canEncodeAudio
} from 'mediabunny';

export interface EncodedAudio {
	blob: Blob;
	mimeType: string;
}

function wavBlob(audio: Float32Array, sampleRate: number): Blob {
	const buffer = new ArrayBuffer(44 + audio.length * 2);
	const view = new DataView(buffer);
	const write = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index += 1)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	write(0, 'RIFF');
	view.setUint32(4, 36 + audio.length * 2, true);
	write(8, 'WAVE');
	write(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, 'data');
	view.setUint32(40, audio.length * 2, true);
	for (let index = 0; index < audio.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, audio[index]));
		view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}
	return new Blob([buffer], { type: 'audio/wav' });
}

export async function encodeAudio(audio: Float32Array, sampleRate: number): Promise<EncodedAudio> {
	try {
		if (
			typeof AudioEncoder === 'undefined' ||
			!(await canEncodeAudio('opus', { numberOfChannels: 1, sampleRate: 48_000, bitrate: 64_000 }))
		) {
			throw new Error('Opus encoding is unavailable.');
		}
		const audioBuffer = new AudioBuffer({ length: audio.length, numberOfChannels: 1, sampleRate });
		audioBuffer.copyToChannel(new Float32Array(audio), 0);
		const target = new BufferTarget();
		const output = new Output({ format: new WebMOutputFormat(), target });
		const source = new AudioBufferSource({
			codec: 'opus',
			bitrate: 64_000,
			transform: { sampleRate: 48_000, numberOfChannels: 1 }
		});
		output.addAudioTrack(source);
		await output.start();
		await source.add(audioBuffer);
		await output.finalize();
		if (!target.buffer) throw new Error('The Opus encoder returned no data.');
		return {
			blob: new Blob([target.buffer], { type: 'audio/webm;codecs=opus' }),
			mimeType: 'audio/webm;codecs=opus'
		};
	} catch {
		const blob = wavBlob(audio, sampleRate);
		return { blob, mimeType: blob.type };
	}
}

export async function decodeAudio(context: BaseAudioContext, blob: Blob): Promise<AudioBuffer> {
	return context.decodeAudioData(await blob.arrayBuffer());
}

export async function audioVariantKey(parts: string[]): Promise<string> {
	const bytes = new TextEncoder().encode(parts.join('\u001f'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
