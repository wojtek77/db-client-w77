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

<div class="toolbar">

    <div class="stats">
        <span id="connectionName" title="Click to change DB connection">-------</span>
        ⏱
        <span id="connectionTime" title="DB connection time">---</span> ms
        | ⏱
        <span id="queryTime" title="SQL execution time">---</span>
        <span id="queryTimeUnit">ms</span>
    </div>
        
    <div class="others">
        <button id="cancelQuery" class="cancel-query-btn">
            ⛔ Stop SQL
        </button>
        
        <span id="flashMessage"></span>
    </div>

    <button onclick="openRecentFiles()">
        📚 Recent files
    </button>
    
    <button onclick="exportToCSV()">
        📊 Export CSV
    </button>
    
    <button onclick="exportToTXT()">
        📊 Export TXT
    </button>

    <div class="pagination">

        <button onclick="firstPage()" id="firstBtn">
            ⏮️
        </button>

        <button onclick="prevPage()" id="prevBtn">
            ◀
        </button>

        <span class="page-info">
            Strona
            <span id="currentPage">1</span>
            z
            <span id="totalPages">1</span>
        </span>

        <button onclick="nextPage()" id="nextBtn">
            ▶
        </button>

        <button onclick="lastPage()" id="lastBtn">
            ⏭️
        </button>

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
