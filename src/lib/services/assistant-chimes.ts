/**
 * Tiny synthesized earcons for the voice assistant's push-to-talk states —
 * no audio assets, just two-blip WebAudio figures. First call happens inside
 * a user gesture, so the context is allowed to start.
 */

export type ChimeKind = 'listen' | 'release' | 'handsFreeOn' | 'handsFreeOff';

const FIGURES: Record<ChimeKind, number[]> = {
	/** Rising: the microphone is now open. */
	listen: [660, 880],
	/** Falling: released, the question is on its way. */
	release: [880, 660],
	/** Rising triple: hands-free conversation engaged. */
	handsFreeOn: [660, 880, 1100],
	/** Single low: back to hold-to-talk. */
	handsFreeOff: [440]
};

let context: AudioContext | undefined;

export function playChime(kind: ChimeKind): void {
	try {
		context ??= new AudioContext();
		if (context.state === 'suspended') void context.resume();
		const start = context.currentTime + 0.01;
		FIGURES[kind].forEach((frequency, step) => {
			const at = start + step * 0.085;
			const oscillator = context!.createOscillator();
			const gain = context!.createGain();
			oscillator.type = 'sine';
			oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0, at);
			gain.gain.linearRampToValueAtTime(0.055, at + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.001, at + 0.08);
			oscillator.connect(gain).connect(context!.destination);
			oscillator.start(at);
			oscillator.stop(at + 0.09);
		});
	} catch {
		// A blocked or missing audio context only costs the earcon.
	}
}
