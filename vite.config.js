import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['tests/**/*.test.{js,ts}'],
		exclude: ['tests/e2e/**'],
		environment: 'node',
		// node:sqlite is synchronous and each suite opens its own file; running
		// suites in one process keeps the fd count and the temp dirs predictable.
		pool: 'forks',
		poolOptions: { forks: { singleFork: true } }
	}
});
