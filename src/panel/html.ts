import * as vscode from 'vscode';
import * as path from 'path';

export function getHtml(
    webview: vscode.Webview,
    extensionPath: string
): string {

    const toUri = (file: string) =>
        webview.asWebviewUri(
            vscode.Uri.file(
                path.join(extensionPath, 'src', 'panel', 'assets', file)
            )
        );

    const styleUri = toUri('styles.css');
    const stateUri = toUri('state.js');
    const tableRendererUri = toUri('tableRenderer.js');
    const paginationUri = toUri('pagination.js');
    const editorUri = toUri('editor.js');
    const exportUri = toUri('export.js');
    const messageHandlerUri = toUri('messageHandler.js');
    const appUri = toUri('app.js');

    return `
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<link rel="stylesheet" href="${styleUri}">

</head>

<body>

<div class="toolbar" id="connectionColor">

    <div class="stats">
        <span id="connectionName" title="Click to change DB connection">-------</span>
        <span id="connectionColorBtn" class="connection-color-btn" title="Set color for this connection">✎</span>
        | ⏱
        <span id="connectionTime" title="DB connection time">---</span> ms
        | ⏱
        <span id="queryTime" title="SQL execution time">---</span>
        <span id="queryTimeUnit">ms</span>
        
        <span id="cancelQuery" class="cancel-query btn" title="cancel query">cancel</span>
    </div>
        
    <div class="others">
        <span id="flashMessage"></span>
    </div>

    <span class="btn" onclick="openRecentFiles()">
        Recent files
    </span>
    
    <span class="btn" onclick="exportToCSV()">
        Export CSV
    </span>
    
    <span class="btn" onclick="exportToTXT()">
        Export TXT
    </span>

    <div class="pagination">

        <span class="btn" onclick="firstPage()" id="firstBtn">
            ⏮
        </span>

        <span class="btn" onclick="prevPage()" id="prevBtn">
            ◀
        </span>

        <span class="page-info">
            page
            <span id="currentPage">1</span>
            of
            <span id="totalPages">1</span>
        </span>

        <span class="btn" onclick="nextPage()" id="nextBtn">
            ▶
        </span>

        <span class="btn" onclick="lastPage()" id="lastBtn">
            ⏭
        </span>

    </div>

</div>

<!-- komunikat o błędach -->
<p id="errorDisplay" class="error-message"></p>

<div id="gridContainer" class="grid-container">
    <div id="loadingOverlay" class="loading-overlay">
        <div class="spinner"></div>
        <div class="loading-text">Loading data...</div>
    </div>

    <!-- nagłówki -->
    <div id="gridHeader" class="grid-header"></div>
    
    <!-- 200 wierszy danych -->
    <div id="gridBody" class="grid-body"></div>
</div>

<script src="${stateUri}"></script>
<script src="${tableRendererUri}"></script>
<script src="${paginationUri}"></script>
<script src="${editorUri}"></script>
<script src="${exportUri}"></script>
<script src="${messageHandlerUri}"></script>
<script src="${appUri}"></script>

</body>
</html>
`;
}
