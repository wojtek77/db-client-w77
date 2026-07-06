import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import { findCurrentQuery } from '../sql/findCurrentQuery.js';
import { Connection } from '../db/Connection.js';
import { CompletionSelect } from './CompletionSelect.js';
import { CompletionInsert } from './CompletionInsert.js';
import { CompletionUpdate } from './CompletionUpdate.js';
import { CompletionInterface } from './CompletionInterface.js'; // Import interfejsu
import { getTopLevelSqlSnippets } from './sqlSnippets.js';

const REGEX_REMOVE_COMMENT_AT_START = /^(?:(?:--|#).*(?:\r?\n|$)+|\/\*[\s\S]*?\*\/)+/;

export class TableCompletionProvider implements vscode.CompletionItemProvider {
    
    private completionSelect: CompletionInterface;
    private completionInsert: CompletionInterface;
    private completionUpdate: CompletionInterface;
    
    public constructor() {
        const tableColumnsCache = TableColumnsCache.getInstance();
        this.completionSelect = new CompletionSelect(tableColumnsCache);
        this.completionInsert = new CompletionInsert(tableColumnsCache);
        this.completionUpdate = new CompletionUpdate(tableColumnsCache);
    }

    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[]> {
        
        try {
            return await this.raceCancellation(
                this.executeProvideCompletionItems(document, position),
                token
            );
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                return [];
            }
            console.error('[TableCompletionProvider] Critical method error:', err);
            return [];
        }
    }

    private raceCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (token.isCancellationRequested) {
                return reject(new vscode.CancellationError());
            }
            const disposable = token.onCancellationRequested(() => {
                disposable.dispose();
                reject(new vscode.CancellationError());
            });
            promise.then(
                res => { disposable.dispose(); resolve(res); },
                err => { disposable.dispose(); reject(err); }
            );
        });
    }
    
    private async executeProvideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {
        
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const currentQuery = findCurrentQuery(document.getText(), position.line);

        if (!currentQuery) {
            // Pusta linia = start nowego zapytania -> pokaż snippety SELECT/INSERT/...
            // (nie wymaga połączenia z bazą, więc sprawdzamy to przed getDb())
            return getTopLevelSqlSnippets();
        }

        let db: Connection;
        try {
            db = await ConnectionManager.getInstance().getDb();
        } catch (err) {
            console.error('[TableCompletionProvider] Database connection error:', err);
            return [];
        }

        let fullText = currentQuery.sql;

        // usunięcie komentarzy na początku przed SELECT, INSERT, UPDATE
        const commentMatch = fullText.match(REGEX_REMOVE_COMMENT_AT_START);
        if (commentMatch) {
            const removedText = commentMatch[0];
            const removedLines = (removedText.match(/\r?\n/g) || []).length;
            currentQuery.startLine += removedLines;
            fullText = fullText.slice(removedText.length);
        }

        const queryStartOffset = document.offsetAt(new vscode.Position(currentQuery.startLine, 0));
        const queryOffset = document.offsetAt(position) - queryStartOffset;
        const sqlBeforeCursor = fullText.substring(0, queryOffset);
        
        switch (fullText.slice(0, 6).toLowerCase()) {
            case 'select': return this.completionSelect.complete(linePrefix, fullText, db, sqlBeforeCursor);
            case 'insert': return this.completionInsert.complete(linePrefix, fullText, db, sqlBeforeCursor);
            case 'update': return this.completionUpdate.complete(linePrefix, fullText, db, sqlBeforeCursor);
            default: return [];
        }
    }
}
