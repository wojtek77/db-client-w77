const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		// loader 'text' dla .css: src/panel/html.ts robi `import cssContent
		// from '../../media/styles.css'` - dzięki temu loaderowi esbuild nie
		// próbuje tego parsować jako CSS, tylko wkleja całą zawartość pliku
		// jako zwykły string wprost do bundla extension.js. Efekt: CSS
		// webview jest dostępny w runtime bez żadnego I/O (fs.readFileSync)
		// i bez osobnego pliku dist/styles.css - patrz komentarz w html.ts.
		loader: {
			'.css': 'text',
		},
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});

	// Bundluje JS webview (media/app.js) do dist/app.js. Samego styles.css
	// już tu NIE bundlujemy jako osobny plik wyjściowy - jego treść trafia
	// inline do HTML-a przez import w html.ts (patrz wyżej), więc dist/app.js
	// jest teraz jedynym plikiem webview referencjonowanym z html.ts przez
	// <script src="...">.
	const ctxMedia = await esbuild.context({
		entryPoints: [
			'media/app.js'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outdir: 'dist',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await ctx.watch();
		await ctxMedia.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		await ctxMedia.rebuild();
		await ctxMedia.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
