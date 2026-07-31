/**
 * OpenAI Realtime API transport for the voice assistant. Like every premium
 * path, requests go directly from this browser to the provider with the
 * user's own key: the key mints a short-lived client secret, and the secret
 * authenticates a WebRTC peer connection that carries microphone audio up,
 * assistant audio down, and JSON events over a data channel.
 */

export class RealtimeError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'RealtimeError';
	}
}

function errorMessage(status: number, data: unknown, model: string): string {
	const detail =
		(data as { error?: { message?: string } })?.error?.message ??
		(data as { message?: string })?.message ??
		'';
	if (status === 401 || status === 403) {
		return 'The OpenAI API key was rejected. Check it under Settings → LLM.';
	}
	if (status === 404) {
		return `This OpenAI account cannot use ${model} yet${detail ? ` (${detail})` : '.'}`;
	}
	if (status === 429) {
		return 'OpenAI is rate limiting this key right now. Try again in a moment.';
	}
	return `OpenAI request failed (${status})${detail ? `: ${detail}` : '.'}`;
}

export interface RealtimeSessionConfig {
	model: string;
	voice: string;
	/** session.reasoning.effort — 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'. */
	effort?: string;
	/** Baked into the minted session: the HTTP body has no size ceiling,
	 * unlike data-channel messages (~64–256 KB), so a whole book fits. */
	instructions?: string;
	tools?: readonly object[];
}

/** Mint the ephemeral client secret that authenticates the WebRTC call. */
export async function mintRealtimeSecret(
	apiKey: string,
	config: RealtimeSessionConfig,
	signal?: AbortSignal
): Promise<string> {
	const response = await post(
		'https://api.openai.com/v1/realtime/client_secrets',
		{ authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		JSON.stringify({
			session: {
				type: 'realtime',
				model: config.model,
				...(config.effort ? { reasoning: { effort: config.effort } } : {}),
				...(config.instructions ? { instructions: config.instructions } : {}),
				...(config.tools?.length ? { tools: config.tools, tool_choice: 'auto' } : {}),
				audio: { output: { voice: config.voice } }
			}
		}),
		signal
	);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new RealtimeError(errorMessage(response.status, data, config.model), response.status);
	}
	const secret = ((await response.json()) as { value?: string }).value;
	if (!secret) throw new RealtimeError('OpenAI returned no client secret.');
	return secret;
}

export interface RealtimeChannel {
	send(event: Record<string, unknown>): void;
	close(): void;
}

export interface RealtimeConnectOptions {
	secret: string;
	model: string;
	microphone: MediaStream;
	/** Receives the assistant's audio track. */
	audio: HTMLAudioElement;
	onEvent(event: Record<string, unknown>): void;
	/** Fired once when the connection ends for any reason after connecting. */
	onClosed(): void;
	signal?: AbortSignal;
}

/** Open the WebRTC call and resolve once the event channel is usable. */
export async function connectRealtime(options: RealtimeConnectOptions): Promise<RealtimeChannel> {
	const peer = new RTCPeerConnection();
	let open = false;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		channel.close();
		peer.close();
	};
	const notifyClosed = () => {
		const wasOpen = open;
		open = false;
		close();
		if (wasOpen) options.onClosed();
	};

	for (const track of options.microphone.getTracks()) peer.addTrack(track, options.microphone);
	peer.ontrack = (event) => {
		options.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
	};
	peer.onconnectionstatechange = () => {
		if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) notifyClosed();
	};

	const channel = peer.createDataChannel('oai-events');
	channel.onmessage = (event) => {
		try {
			options.onEvent(JSON.parse(event.data as string) as Record<string, unknown>);
		} catch {
			// Non-JSON frames carry nothing we use.
		}
	};
	channel.onclose = notifyClosed;

	try {
		const offer = await peer.createOffer();
		await peer.setLocalDescription(offer);
		const response = await post(
			`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(options.model)}`,
			{ authorization: `Bearer ${options.secret}`, 'content-type': 'application/sdp' },
			offer.sdp ?? '',
			options.signal
		);
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new RealtimeError(errorMessage(response.status, data, options.model), response.status);
		}
		await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
		await waitForChannel(channel, options.signal);
		open = true;
	} catch (error) {
		close();
		throw error;
	}

	return {
		send(event) {
			if (channel.readyState === 'open') channel.send(JSON.stringify(event));
		},
		close() {
			// Deliberate teardown is not a connection loss: silence onClosed.
			open = false;
			close();
		}
	};
}

function waitForChannel(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
	if (channel.readyState === 'open') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new RealtimeError('The realtime connection timed out.')),
			15_000
		);
		const settle = (result: () => void) => () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', onAbort);
			result();
		};
		const onAbort = settle(() => reject(new RealtimeError('The request was cancelled.')));
		channel.onopen = settle(resolve);
		channel.onerror = settle(() =>
			reject(new RealtimeError('The realtime event channel failed to open.'))
		);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function post(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal?: AbortSignal
): Promise<Response> {
	const timeout = AbortSignal.timeout(20_000);
	try {
		return await fetch(url, {
			method: 'POST',
			headers,
			body,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
	} catch (error) {
		if (signal?.aborted) throw new RealtimeError('The request was cancelled.');
		if (timeout.aborted) throw new RealtimeError('OpenAI did not answer in time.');
		throw new RealtimeError(
			error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
		);
	}
}
