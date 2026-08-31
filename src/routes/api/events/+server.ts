/**
 * `GET /api/events` — the SSE hint stream. CONTRACT.md §4. Auth: session.
 *
 * Wire format is normative: every event is an UNNAMED (default `message`) event
 * whose `data` is single-line JSON, terminated by one blank line. No `event:`
 * field and no `id:` field is ever sent — the client uses `es.onmessage` and the
 * browser never replays `Last-Event-ID`, because recovery is by refetch.
 */
import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/realtime/bus';
import { handle, unauthenticated } from '$lib/server/domain/responses';
import type { ZembilEvent } from '$lib/types';

const PING_INTERVAL_MS = 25_000;

/**
 * Chunks a client may leave unread before the stream is torn down.
 *
 * `controller.enqueue` buffers in process memory with no bound of its own: a
 * client that opens the stream and then stops reading — a phone that suspended,
 * or an account holder doing it on purpose — would otherwise accumulate every
 * ping and every hint forever. Events are hints, not data (§4), so dropping a
 * stream that is not keeping up costs nothing: the client reconnects and
 * revalidates on `open`.
 *
 * This is an EVENTUAL bound, not a tight one (D-028). Measured against
 * `@sveltejs/kit/node`'s `setResponse` on Node 26.1.0 with a client that never
 * reads a byte: chunks flush as enqueued (nothing buffers to EOF while a socket
 * is accepting bytes), and `desiredSize` does not start falling until roughly
 * 27,749 unread events (~2.5 MB) have piled up in the kernel/libuv socket
 * buffers — only once the actual pipe stalls does the queue back up and this
 * bound fire, and it fires immediately once it does. So the real ceiling per
 * stalled stream is on the order of a few MB, not `MAX_BUFFERED_CHUNKS` bytes.
 * That is still bounded, and at 4 streams per session (§4) and fewer than ten
 * users total, a few MB per stalled connection is acceptable — it is a backstop
 * against a connection that never resumes, not a tight memory cap.
 */
const MAX_BUFFERED_CHUNKS = 64;

export const GET: RequestHandler = async ({ locals }) =>
	handle(() => {
		const user = locals.user;
		const sessionId = locals.sessionId;
		if (!user || !sessionId) return unauthenticated();

		const encoder = new TextEncoder();
		let unsubscribe: (() => void) | null = null;
		let ping: ReturnType<typeof setInterval> | null = null;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;

				const teardown = () => {
					if (closed) return;
					closed = true;
					if (ping !== null) clearInterval(ping);
					ping = null;
					if (unsubscribe) unsubscribe();
					unsubscribe = null;
					try {
						controller.close();
					} catch {
						/* already closed by the client going away */
					}
				};

				const write = (chunk: string) => {
					if (closed) return;
					// desiredSize falls by one per unread chunk under the default
					// queuing strategy, so it going far negative means the consumer
					// has stopped reading.
					const desired = controller.desiredSize;
					if (desired !== null && desired <= -MAX_BUFFERED_CHUNKS) {
						teardown();
						return;
					}
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch {
						teardown();
					}
				};

				// A comment, not an event: §4 says the server sends no *event* on
				// connect. This flushes the response headers through a buffering
				// intermediary, which is what X-Accel-Buffering also guards against.
				write(': connected\n\n');

				const send = (event: ZembilEvent) => {
					// JSON.stringify never emits a raw newline, so this is one line.
					write(`data: ${JSON.stringify(event)}\n\n`);
				};

				unsubscribe = subscribe(user.id, sessionId, send, teardown);

				ping = setInterval(() => write(': ping\n\n'), PING_INTERVAL_MS);
				// Never hold the process open for a keepalive timer.
				if (typeof ping.unref === 'function') ping.unref();
			},
			cancel() {
				if (ping !== null) clearInterval(ping);
				ping = null;
				if (unsubscribe) unsubscribe();
				unsubscribe = null;
			}
		});

		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no',
				connection: 'keep-alive'
			}
		});
	});
