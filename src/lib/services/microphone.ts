/** The reader's microphone, with the processing a voice conversation needs:
 * echo cancellation keeps the assistant from hearing itself on speakers. In
 * development, a fake microphone can stand in (services/fake-microphone.ts). */
export async function acquireMicrophone(): Promise<MediaStream> {
	if (import.meta.env.DEV) {
		const fake = await import('./fake-microphone');
		if (fake.fakeMicrophoneRequested()) return fake.fakeMicrophoneStream();
	}
	return navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true }
	});
}
