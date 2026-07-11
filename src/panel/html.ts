import * as vscode from 'vscode';
import * as crypto from 'crypto';

function getNonce(): string {
    // 32 losowe bajty zakodowane jako base64 - wystarczająco silne dla CSP script-src nonce
    return crypto.randomBytes(16).toString('base64');
}

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
    const nonce = getNonce();

    // Ścisła CSP: skrypty tylko z tym konkretnym nonce (żaden inline onclick/onerror
    // się nie wykona), style i skrypty tylko z zasobów tego webview, brak dostępu
    // do sieci/obrazów spoza webview.
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`,
        `img-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
    ].join('; ');

    return `
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">

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
        <span id="saveColumnEditsBtn" class="tools-btn save-column-edits-btn" title="Save new value(s) for the whole column(s)">💾 Save</span>
    </div>

    <span class="btn" id="openRecentFilesBtn">
        Recent files
    </span>
    
    <span class="btn" id="exportCSVBtn">
        Export CSV
    </span>
    
    <span class="btn" id="exportTXTBtn">
        Export TXT
    </span>

    <div class="pagination">

        <button class="btn" id="firstBtn">
            ⏮
        </button>

        <button class="btn" id="prevBtn">
            ◀
        </button>

        <span class="page-info">
            page
            <span id="currentPage">1</span>
            of
            <span id="totalPages">1</span>
        </span>

        <button class="btn" id="nextBtn">
            ▶
        </button>

        <button class="btn" id="lastBtn">
            ⏭
        </button>

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

<script nonce="${nonce}" src="${appUri}"></script>

</body>
</html>
`;
}
