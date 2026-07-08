import * as vscode from 'vscode';

export function getHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
): string {

    const toUri = (file: string) =>
        webview.asWebviewUri(
            vscode.Uri.joinPath(
                extensionUri,
                'dist',
                file
            )
        );

    const styleUri = toUri('styles.css');
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
        <span id="infoMessage"></span>
        <span id="flashMessage"></span>
    </div>

    <div class="tools">
        <span id="generateInsertBtn" class="tools-btn generate-insert-btn" title="Generate INSERT SQL">➕</span>
        <span id="generateUpdateBtn" class="tools-btn generate-update-btn" title="Generate UPDATE SQL">✏️</span>
        <span id="generateDeleteBtn" class="tools-btn generate-delete-btn" title="Generate DELETE SQL">➖</span>
        <span id="deleteRowsBtn" class="tools-btn delete-rows-btn" title="Delete selected rows">❌</span>
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

<div id="gridContainer" class="grid-container" tabindex="-1">
    <div id="loadingOverlay" class="loading-overlay">
        <div class="spinner"></div>
        <div class="loading-text">Loading data...</div>
    </div>

    <!-- nagłówki -->
    <div id="gridHeader" class="grid-header"></div>
    
    <!-- 200 wierszy danych -->
    <div id="gridBody" class="grid-body"></div>
</div>

<script src="${appUri}"></script>

</body>
</html>
`;
}
