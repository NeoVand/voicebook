/**
 * GPT-Live transport. Like every premium path, the browser talks to OpenAI
 * directly with the reader's own key: one POST creates the session with its
 * whole configuration — the voice's prompt, the brain it delegates to with
 * that brain's instructions (up to 1 MiB of characters: the document or its
 * map) and tools — and trades the WebRTC offer for an answer. Audio rides the
 * media tracks; JSON events ride the `oai-events` data channel. The HTTP
 * request starts the session, so no `session.start` is ever sent.
 */

export class LiveError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'LiveError';
	}
}

function errorMessage(status: number, data: unknown): string {
	const detail =
		(data as { error?: { message?: string } })?.error?.message ??
		(data as { message?: string })?.message ??
		'';
	if (status === 401 || status === 403) {
		return 'The OpenAI API key was rejected. Check it under Settings → LLM.';
	}
	if (status === 404) {
		return `This OpenAI account cannot use GPT-Live yet${detail ? ` (${detail})` : '.'}`;
	}
	if (status === 429) {
		return 'OpenAI is rate limiting this key right now. Try again in a moment.';
	}
	return `GPT-Live could not start (${status})${detail ? `: ${detail}` : '.'}`;
}

export interface LiveBrainConfig {
	model: string;
	instructions: string;
	tools: readonly object[];
	effort: string;
}

export interface LiveSessionConfig {
	model: string;
	/** The voice's own prompt — at most 16,384 tokens, fixed for the session. */
	instructions: string;
	voice: string;
	/** Earlier conversation to continue from. */
	input?: readonly object[];
	brain: LiveBrainConfig;
}

/** The POST body's `session`. Exported for tests. */
export function liveSessionBody(config: LiveSessionConfig): Record<string, unknown> {
	return {
		model: config.model,
		instructions: config.instructions,
		...(config.input?.length ? { input: config.input } : {}),
		audio: { output: { voice: config.voice } },
		delegation: {
			type: 'responses',
			responses: {
				model: config.brain.model,
				instructions: config.brain.instructions,
				tools: config.brain.tools,
				tool_choice: 'auto',
				parallel_tool_calls: true,
				reasoning: { effort: config.brain.effort }
			}
		}
	};
}

export interface LiveConnection {
	sessionId: string;
	send(event: Record<string, unknown>): void;
	/** End gracefully: `session.close`, then wait for `session.closed` (final
	 * usage) before releasing the connection — or give up after a while. */
	close(timeoutMs?: number): Promise<void>;
}

export interface LiveConnectOptions {
	apiKey: string;
	session: LiveSessionConfig;
	/** Absent for a listen-only session. */
	microphone?: MediaStream;
	/** Plays the voice. */
	audio: HTMLAudioElement;
	/** The voice's audio as a stream, for measuring when it speaks. */
	onRemoteStream?(stream: MediaStream): void;
	onEvent(event: Record<string, unknown>): void;
	/** Fired once when the connection ends without being asked to. */
	onClosed(): void;
	signal?: AbortSignal;
}

const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
/** A brief network hiccup can drop a connection to "disconnected" and back. */
const DISCONNECT_GRACE_MS = 5_000;

/** Open the session and resolve once the event channel is usable. */
export async function connectLive(options: LiveConnectOptions): Promise<LiveConnection> {
	const peer = new RTCPeerConnection();
	let open = false;
	let released = false;
	let closedByServer: (() => void) | undefined;
	let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
	const release = () => {
		if (released) return;
		released = true;
		clearTimeout(disconnectTimer);
		channel.close();
		peer.close();
	};
	const notifyClosed = () => {
		const wasOpen = open;
		open = false;
		release();
		if (wasOpen) options.onClosed();
	};

	if (options.microphone) {
		for (const track of options.microphone.getAudioTracks()) {
			peer.addTrack(track, options.microphone);
		}
	} else {
		peer.addTransceiver('audio', { direction: 'recvonly' });
	}
	peer.ontrack = (event) => {
		const stream = event.streams[0] ?? new MediaStream([event.track]);
		options.audio.srcObject = stream;
		options.onRemoteStream?.(stream);
	};
	peer.onconnectionstatechange = () => {
		const state = peer.connectionState;
		if (state === 'failed' || state === 'closed') notifyClosed();
		else if (state === 'disconnected') {
			clearTimeout(disconnectTimer);
			disconnectTimer = setTimeout(() => {
				if (peer.connectionState === 'disconnected') notifyClosed();
			}, DISCONNECT_GRACE_MS);
		} else if (state === 'connected') clearTimeout(disconnectTimer);
	};

	// The event channel must exist before the offer is made.
	const channel = peer.createDataChannel('oai-events');
	channel.onmessage = (message) => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(message.data as string) as Record<string, unknown>;
		} catch {
			return;
		}
		if (event.type === 'session.closed') closedByServer?.();
		options.onEvent(event);
	};
	channel.onclose = notifyClosed;

	let sessionId: string;
	try {
		await peer.setLocalDescription(await peer.createOffer());
		await iceGathered(peer, options.signal);
		const response = await post(
			LIVE_SESSIONS_URL,
			options.apiKey,
			JSON.stringify({
				session: liveSessionBody(options.session),
				transport: { type: 'webrtc', sdp: peer.localDescription?.sdp ?? '' }
			}),
			options.signal
		);
		const data = (await response.json().catch(() => ({}))) as {
			session?: { id?: string };
			transport?: { sdp?: string };
		};
		if (!response.ok) throw new LiveError(errorMessage(response.status, data), response.status);
		const answer = data.transport?.sdp;
		if (!answer) throw new LiveError('GPT-Live returned no connection answer.');
		sessionId = data.session?.id ?? '';
		await peer.setRemoteDescription({ type: 'answer', sdp: answer });
		await waitForChannel(channel, options.signal);
		open = true;
	} catch (error) {
		release();
		throw error;
	}

	return {
		sessionId,
		send(event) {
			if (channel.readyState === 'open') channel.send(JSON.stringify(event));
		},
		async close(timeoutMs = 3_000) {
			// Deliberate teardown is not a connection loss: silence onClosed.
			const wasOpen = open;
			open = false;
			if (wasOpen && channel.readyState === 'open') {
				const finalized = new Promise<void>((resolve) => {
					closedByServer = resolve;
					setTimeout(resolve, timeoutMs);
				});
				channel.send(JSON.stringify({ type: 'session.close' }));
				await finalized;
			}
			release();
		}
	};
}

/** The offer goes out whole: wait for ICE gathering, but never for long —
 * a slow candidate is not worth a stalled start. */
function iceGathered(peer: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
	if (peer.iceGatheringState === 'complete') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const done = () => {
			clearTimeout(timeout);
			peer.removeEventListener('icegatheringstatechange', onChange);
			signal?.removeEventListener('abort', onAbort);
		};
		const onChange = () => {
			if (peer.iceGatheringState !== 'complete') return;
			done();
			resolve();
		};
		const onAbort = () => {
			done();
			reject(new LiveError('The request was cancelled.'));
		};
		const timeout = setTimeout(() => {
			done();
			resolve();
		}, 3_000);
		peer.addEventListener('icegatheringstatechange', onChange);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function waitForChannel(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
	if (channel.readyState === 'open') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new LiveError('The GPT-Live connection timed out.')),
			15_000
		);
		const settle = (result: () => void) => () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', onAbort);
			result();
		};
		const onAbort = settle(() => reject(new LiveError('The request was cancelled.')));
		channel.onopen = settle(resolve);
		channel.onerror = settle(() =>
			reject(new LiveError('The GPT-Live event channel failed to open.'))
		);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function post(
	url: string,
	apiKey: string,
	body: string,
	signal?: AbortSignal
): Promise<Response> {
	// The brain's prompt can carry a whole document: allow for the upload.
	const timeout = AbortSignal.timeout(30_000);
	try {
		return await fetch(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
			body,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
	} catch (error) {
		if (signal?.aborted) throw new LiveError('The request was cancelled.');
		if (timeout.aborted) throw new LiveError('OpenAI did not answer in time.');
		throw new LiveError(
			error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
		);
	}
}
