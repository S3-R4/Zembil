import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ out: 'build' }),
		// Defence in depth only. SvelteKit's own check inspects form content types
		// alone, and Zembil's API is JSON — the load-bearing Origin check is ours,
		// in hooks.server.ts, for every method and content type. See CONTRACT.md §3.
		csrf: { trustedOrigins: [] },
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				// See CONTRACT.md §5 / D-026: script-src stays strict, style-src does not.
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': ['self'],
				'base-uri': ['none'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
