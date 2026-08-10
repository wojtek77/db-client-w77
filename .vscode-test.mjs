import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		// require przed testami: stub dla importów .css, patrz src/test/cssRequireStub.ts
		require: './out/test/cssRequireStub.js',
	},
});
