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
