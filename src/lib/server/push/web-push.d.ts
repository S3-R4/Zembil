/**
 * `web-push` ships no types and `@types/web-push` is not a dependency, so the
 * surface Zembil actually uses is declared here. Deliberately narrow: if a
 * future change needs another export, it gets added here explicitly rather than
 * arriving as `any` from a broad declaration.
 */
declare module 'web-push' {
	export interface VapidKeyPair {
		publicKey: string;
		privateKey: string;
	}

	export interface PushSubscriptionShape {
		endpoint: string;
		keys: { p256dh: string; auth: string };
	}

	export interface SendOptions {
		vapidDetails?: { subject: string; publicKey: string; privateKey: string };
		TTL?: number;
		headers?: Record<string, string>;
		contentEncoding?: string;
	}

	export interface SendResult {
		statusCode: number;
		body?: string;
		headers?: Record<string, string>;
	}

	export class WebPushError extends Error {
		statusCode: number;
		headers: Record<string, string>;
		body: string;
		endpoint: string;
	}

	export function generateVAPIDKeys(): VapidKeyPair;

	export function sendNotification(
		subscription: PushSubscriptionShape,
		payload?: string | Buffer | null,
		options?: SendOptions
	): Promise<SendResult>;

	/**
	 * `web-push` is CommonJS and Node's ESM loader refuses named imports from
	 * it ("Named export 'generateVAPIDKeys' not found"), so every call site uses
	 * the default import. Measured on this build, not recalled.
	 */
	const webpush: {
		generateVAPIDKeys: typeof generateVAPIDKeys;
		sendNotification: typeof sendNotification;
		WebPushError: typeof WebPushError;
	};
	export default webpush;
}
