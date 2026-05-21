function setupConnectionEvents(vscode) {
    
    document.addEventListener('DOMContentLoaded', () => {

        const btn = document.getElementById('connectionName');
        if (btn) {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'changeConnection'
                });
            });
        }
    });

}
