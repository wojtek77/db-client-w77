// Ambient module declaration dla importów plików .css jako zwykły tekst.
// TypeScript sam z siebie nie wie, co zrobić z `import x from './plik.css'`
// - ta deklaracja mówi mu: traktuj to jak zwykły moduł eksportujący string.
// Faktyczną podmianę importu na string wykonuje esbuild w czasie budowania,
// dzięki `loader: { '.css': 'text' }` w esbuild.js (patrz komentarz tam).
declare module '*.css' {
    const content: string;
    export default content;
}
