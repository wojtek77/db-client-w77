window.vscode = acquireVsCodeApi();

initEditor(vscode);

document.getElementById('connectionColorBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'pickConnectionColor' });
});
