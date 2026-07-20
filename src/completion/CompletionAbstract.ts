import * as vscode from 'vscode';
import { Connection } from '../db/Connection.js';
import { findQueryTables, computeParenStack } from '../sql/findQueryTables.js';
import { maskStringLiterals } from '../sql/maskStringLiterals.js';
import { TableColumn, TableColumnsCache } from '../cache/TableColumnsCache.js';
import { formatColumnType } from './columnFormatter.js';
import { SqlFunction } from './sqlFunctions.js';

export abstract class CompletionAbstract {
    
    protected tableColumnsService;
    
    public constructor(tableColumnsService: TableColumnsCache) {
        this.tableColumnsService = tableColumnsService;
    }
    
    /**
     * Wspólna metoda wyciągająca tabele z zapytania, pobierająca ich kolumny z cache
     * oraz uzupełniająca przekazaną listę wynikową (opcjonalnie filtrując po aliasach).
     *
     * `sqlBeforeCursor` służy do ograniczenia tabel POKAZYWANYCH JAKO PODPOWIEDZI do
     * zasięgu widoczności kursora — tabele z "obcych" podzapytań (np. z innej gałęzi
     * WHERE ... IN (...) niż ta, w której aktualnie edytujemy) nie powinny podpowiadać
     * swoich kolumn w głównym zapytaniu. Zob. findQueryTables.ts.
     *
     * Sam batch pobierający kolumny z cache/bazy celowo NIE jest ograniczany zasięgiem —
     * pobieramy jednym zapytaniem kolumny wszystkich tabel z CAŁEGO tekstu zapytania
     * (rozgrzewając cache), a dopiero z tego wyniku wybieramy tylko te tabele, które są
     * w zasięgu kursora. Dzięki temu, gdy użytkownik przesunie kursor do innego zakresu
     * (np. do wnętrza podzapytania), kolumny tamtej tabeli są już w cache i nie trzeba
     * wysyłać kolejnego zapytania do bazy — tak jak to działało przed wprowadzeniem
     * ograniczenia zasięgiem.
     */
    protected async addColumnsFromQueryTables(
        resultList: vscode.CompletionItem[],
        fullText: string,
        defaultSchema: string | undefined,
        db: Connection,
        sqlBeforeCursor: string,
        allowedAliases?: Set<string>
    ): Promise<void> {
        // zasięg widoczności — tylko te tabele trafią do listy podpowiedzi
        const scopedTableRefs = findQueryTables(fullText, defaultSchema ?? '', db, sqlBeforeCursor.length);

        // prefetch/cache-warming – jeden batch obejmujący wszystkie tabele w tekście, niezależnie od zasięgu (patrz komentarz metody)
        const allTableRefsForPrefetch = findQueryTables(fullText, defaultSchema ?? '', db);
        const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(allTableRefsForPrefetch);

        for (const tableRef of scopedTableRefs) {
            if (allowedAliases) {
                const patterns = [
                    new RegExp(`from\\s+(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i'),
                    new RegExp(`join\\s+(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i'),
                    new RegExp(`,\\s*(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i')
                ];

                let currentAlias = tableRef.table.toLowerCase();
                for (const pattern of patterns) {
                    const aliasMatch = fullText.match(pattern);
                    if (aliasMatch && aliasMatch[2]) {
                        currentAlias = aliasMatch[2].toLowerCase();
                        break;
                    }
                }

                if (!allowedAliases.has(currentAlias)) {
                    continue;
                }
            }

            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];
            for (const column of columns) {
                resultList.push(this.createColumnItem(tableRef.table, column));
            }
        }
    }

    protected createTableItem(tableName: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(tableName, vscode.CompletionItemKind.Struct);
        item.insertText = tableName;
        item.detail     = 'Table';
        item.sortText = `0_${order.toString().padStart(5, '0')}`;
        return item;
    }

    protected createSchemaItem(schema: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
        item.insertText = schema;
        item.detail     = 'Schema';
        item.sortText = `1_${order.toString().padStart(5, '0')}`;
        return item;
    }

    protected createColumnItem(tableName: string, column: TableColumn): vscode.CompletionItem {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
        item.sortText   = `0_${tableName}0_${column.name}`;
        item.insertText = column.name;

        const formattedType = formatColumnType(column);
        const details: string[] = [formattedType];

        details.push(column.isNullable === 'YES' ? 'NULL' : 'NOT NULL');
        if (column.columnKey === 'PRI') { details.push('🔑 PRIMARY KEY'); }
        if (column.columnKey === 'UNI') { details.push('🔗 UNIQUE'); }
        if (column.extra === 'auto_increment') { details.push('📈 AUTO_INCREMENT'); }
        if (column.defaultValue !== null) { details.push(`📌 DEFAULT: ${column.defaultValue}`); }

        item.detail = `${tableName} 📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
        item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;

        return item;
    }

    protected createFunctionItem(fn: SqlFunction): vscode.CompletionItem {
        const item = new vscode.CompletionItem(`${fn.signature}`, vscode.CompletionItemKind.Function);
        item.filterText = fn.name;
        item.insertText = new vscode.SnippetString(fn.snippet);
        item.documentation = new vscode.MarkdownString(fn.documentation);
        item.sortText = `9_${fn.name}`;
        return item;
    }
    
    /**
     * Sprawdza czy kursor znajduje się wewnątrz nawiasów funkcji w obrębie danej klauzuli.
     * Przykład: "HAVING GROUP_CONCAT(|)" lub "HAVING COUNT(|)" → zwraca true.
     * Działa poprzez liczenie nawiasów od początku klauzuli do kursora:
     * jeśli głębokość > 0, kursor jest wewnątrz wywołania funkcji.
     */
    protected isCursorInsideFunctionCall(sqlBeforeCursor: string, clauseIndex: number): boolean {
        if (clauseIndex === -1) { return false; }
        const fromClause = sqlBeforeCursor.slice(clauseIndex);
        return computeParenStack(fromClause, fromClause.length).length > 0;
    }

    protected extractSelectPartAtCursorLevel(sqlBeforeCursor: string): string {
        const stack = computeParenStack(sqlBeforeCursor, sqlBeforeCursor.length);
        const blockStart = stack.length > 0 ? stack[stack.length - 1] + 1 : 0;

        const block = sqlBeforeCursor.slice(blockStart);
        const flat = this.flattenSubqueries(block);

        const selectRegex = /\bselect\b/gi;
        let lastSelectEnd = -1;
        let m: RegExpExecArray | null;
        while ((m = selectRegex.exec(flat)) !== null) {
            lastSelectEnd = m.index + m[0].length;
        }
        if (lastSelectEnd === -1) { return ''; }

        const fromRegex = /\bfrom\b/gi;
        fromRegex.lastIndex = lastSelectEnd;
        const fromResult = fromRegex.exec(flat);
        if (!fromResult) { return ''; }

        return block.slice(lastSelectEnd, fromResult.index);
    }

    protected extractHavingCandidates(selectPart: string): string[] {
        const masked = maskStringLiterals(selectPart);
        const entries: string[] = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < selectPart.length; i++) {
            const ch = masked[i];
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            else if (ch === ',' && depth === 0) {
                entries.push(selectPart.slice(start, i));
                start = i + 1;
            }
        }
        entries.push(selectPart.slice(start));

        const result: string[] = [];

        for (const entry of entries) {
            const rtrimmed = entry.trimEnd();
            if (!rtrimmed) { continue; }
            
            if (rtrimmed.endsWith(')')) {
                const e1 = rtrimmed.trimStart();
                if (e1.startsWith('(')) {
                    result.push(e1);
                    continue;
                }
            }

            const e1 = rtrimmed.trimStart();
            if (e1.endsWith('.*')) {
                result.push(e1);
                continue;
            }

            const parts = rtrimmed.split(/[ .]/);
            const last = parts[parts.length - 1].trimStart();
            if (last) { result.push(last); }
        }

        return [...new Set(result)];
    }
    
    private flattenSubqueries(sql: string): string {
        let text = sql;
        let masked = maskStringLiterals(sql);

        for (;;) {
            const regex = /\([^()]*\)/g;
            let m: RegExpExecArray | null;
            let lastIndex = 0;
            let nextText = '';
            let nextMasked = '';
            let changed = false;

            while ((m = regex.exec(masked)) !== null) {
                changed = true;
                const blank = ' '.repeat(m[0].length);
                nextText += text.slice(lastIndex, m.index) + blank;
                nextMasked += masked.slice(lastIndex, m.index) + blank;
                lastIndex = m.index + m[0].length;
            }

            if (!changed) { return text; }

            nextText += text.slice(lastIndex);
            nextMasked += masked.slice(lastIndex);
            text = nextText;
            masked = nextMasked;
        }
    }
}