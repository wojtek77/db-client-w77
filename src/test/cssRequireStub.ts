import Module from 'module';

// hook ładowany przez mocha.require w .vscode-test.mjs, zanim wczytają się pliki testowe
// html.ts robi `import cssContent from '../../media/styles.css'` - w prawdziwym buildzie esbuild podmienia to na gotowy string (patrz esbuild.js), ale testy kompilowane są zwykłym tsc, więc require('*.css') próbowałby sparsować CSS jako JS i wywalał się z SyntaxError
// dowolny test, który (nawet pośrednio, przez import innego modułu) dociera do SqlResultsProvider.ts -> html.ts, potrzebuje tego stuba
(Module as unknown as { _extensions: Record<string, (module: NodeModule, filename: string) => void> })
    ._extensions['.css'] = (module) => {
        module.exports = '';
    };
