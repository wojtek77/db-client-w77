// deklaracja modułu żeby import pliku .css działał jak zwykły string – podmianę na string robi esbuild w czasie budowania (loader w esbuild.js)
declare module '*.css' {
    const content: string;
    export default content;
}
