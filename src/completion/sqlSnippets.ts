import * as vscode from 'vscode';

interface SqlSnippet {
    label: string;
    prefix: string;
    description: string;
    snippet: vscode.SnippetString;
}

/**
 * Snippety pokazywane wyłącznie na pustej linii (start nowego zapytania),
 * czyli dokładnie tam, gdzie TableCompletionProvider dostaje `currentQuery === null`.
 */
const TOP_LEVEL_SNIPPETS: SqlSnippet[] = [
    {
        label: 'SELECT',
        prefix: 'select',
        description: 'SELECT with WHERE / GROUP BY / HAVING / ORDER BY / LIMIT',
        snippet: new vscode.SnippetString(
            'SELECT ${1:*}\n' +
            'FROM ${2:table_name}\n' +
            'WHERE ${3:1}\n' +
            'GROUP BY ${4:id}\n' +
            'HAVING ${5:1}\n' +
            'ORDER BY ${6:id}\n' +
            'LIMIT ${7:1}'
        )
    },
    {
        label: 'SELECT Simple',
        prefix: 'select-simple',
        description: 'SELECT with WHERE only',
        snippet: new vscode.SnippetString(
            'SELECT *\n' +
            'FROM ${1:table_name}\n' +
            'WHERE ${2:1}'
        )
    },
    {
        label: 'INSERT',
        prefix: 'insert',
        description: 'INSERT',
        snippet: new vscode.SnippetString(
            'INSERT INTO ${1:table_name} (${2:column})\n' +
            'VALUES (${3:value})'
        )
    },
    {
        label: 'INSERT ON DUPLICATE KEY UPDATE',
        prefix: 'insert-update',
        description: 'INSERT ... ON DUPLICATE KEY UPDATE',
        snippet: new vscode.SnippetString(
            'INSERT INTO ${1:table_name} (${2:column})\n' +
            'VALUES (${3:value})\n' +
            'ON DUPLICATE KEY UPDATE ${2} = VALUES(${2})'
        )
    },
    {
        label: 'REPLACE',
        prefix: 'replace',
        description: 'REPLACE INTO',
        snippet: new vscode.SnippetString(
            'REPLACE INTO ${1:table_name} (${2:column})\n' +
            'VALUES (${3:value})'
        )
    },
    {
        label: 'UPDATE JOIN',
        prefix: 'update',
        description: 'UPDATE with JOIN',
        snippet: new vscode.SnippetString(
            'UPDATE LOW_PRIORITY IGNORE ${1:table_name1} ${2:t1}\n' +
            'INNER JOIN ${3:table_name2} ${4:t2} ON ${4}.id = ${2}.id\n' +
            'SET ${5:column} = ${6:value}\n' +
            'WHERE ${7:0}'
        )
    },
    {
        label: 'UPDATE Simple',
        prefix: 'update-simple',
        description: 'UPDATE Simple',
        snippet: new vscode.SnippetString(
            'UPDATE ${1:table_name}\n' +
            'SET ${2:column} = ${3:value}\n' +
            'WHERE ${4:0}'
        )
    },
    {
        label: 'DELETE JOIN',
        prefix: 'delete',
        description: 'DELETE with JOIN',
        snippet: new vscode.SnippetString(
            'DELETE LOW_PRIORITY QUICK IGNORE ${1:alias}\n' +
            'FROM ${2:table_name1} ${1}\n' +
            'INNER JOIN ${3:table_name2} ${4:t2} ON ${4}.${5:column} = ${1}.${6:column}\n' +
            'WHERE ${7:0}'
        )
    },
    {
        label: 'DELETE Simple',
        prefix: 'delete-simple',
        description: 'DELETE Simple',
        snippet: new vscode.SnippetString(
            'DELETE\n' +
            'FROM ${1:table_name}\n' +
            'WHERE ${2:0}'
        )
    }
];

/**
 * Buduje listę CompletionItem dla snippetów top-level.
 * Wywoływać tylko wtedy, gdy currentQuery === null (pusta linia).
 */
export function getTopLevelSqlSnippets(): vscode.CompletionItem[] {
    return TOP_LEVEL_SNIPPETS.map((s, index) => {
        const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
        item.insertText = s.snippet;
        item.detail = s.description;
        item.filterText = s.prefix;
        item.sortText = '0_' + index.toString().padStart(3, '0');
        return item;
    });
}
