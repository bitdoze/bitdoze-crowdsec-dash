import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'#lib': new URL('./src/lib', import.meta.url).pathname,
			// vitest has no SvelteKit plugin — stub the env modules app code reads
			'$app/env/private': new URL('./tests/mocks/app-env-private.ts', import.meta.url).pathname,
			'$app/env': new URL('./tests/mocks/app-env.ts', import.meta.url).pathname
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node'
	}
});
