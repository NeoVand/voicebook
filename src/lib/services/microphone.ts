/** The reader's microphone, with the processing a voice conversation needs:
 * echo cancellation keeps the assistant from hearing itself on speakers. */
export async function acquireMicrophone(): Promise<MediaStream> {
	return navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true }
	});
}
