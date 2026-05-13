import * as vscode from 'vscode';
import * as path from 'path';

export function getHtml(
    webview: vscode.Webview,
    extensionPath: string,
    connTime: string,
    qTime: string
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
    const csvExportUri = toUri('csvExport.js');
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
        🔌 ${connTime}ms | ⚡ ${qTime}ms
    </div>

    <button onclick="exportToCSV()">
        💾 Eksportuj CSV
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

<div class="table-container">

    <table id="dataTable">

        <thead>
            <tr id="headerRow">
                <th>#</th>
            </tr>
        </thead>

        <tbody id="tableBody">
            <tr>
                <td>Ładowanie...</td>
            </tr>
        </tbody>

    </table>

</div>

<script src="${stateUri}"></script>
<script src="${tableRendererUri}"></script>
<script src="${paginationUri}"></script>
<script src="${editorUri}"></script>
<script src="${csvExportUri}"></script>
<script src="${messageHandlerUri}"></script>
<script src="${appUri}"></script>

</body>
</html>
`;
}
