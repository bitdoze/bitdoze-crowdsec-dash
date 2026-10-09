import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'#lib': new URL('./src/lib', import.meta.url).pathname,
			// vitest has no SvelteKit plugin — stub the env module config.ts reads
			'$app/env/private': new URL('./tests/mocks/app-env-private.ts', import.meta.url).pathname
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node'
	}
});
