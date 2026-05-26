import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { getCachedColumns } from '../cache/tableColumnsCache';
import { formatColumnType } from './columnFormatter';

// Provider autouzupełniania
export class TableCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        
        // Sprawdź, czy piszemy "from " (podpowiadanie tabel)
        const fromMatch = linePrefix.match(/from\s+$/i);
        const afterFromMatch = linePrefix.match(/from\s+(\w*)$/i);
        
        // Sprawdź, czy piszemy alias z kropką (np. "s.")
        const aliasMatch = linePrefix.match(/(\w+)\.$/i);
        
        // Podpowiadanie nazw tabel po FROM
        if (fromMatch || afterFromMatch) {
            let filterText = '';
            if (afterFromMatch && afterFromMatch[1]) {
                filterText = afterFromMatch[1];
            }
            
            const tableNames = (await ConnectionManager.getInstance().getDb()).getTableNames();
            const completions = tableNames.map(tableName => {
                const item = new vscode.CompletionItem(tableName, vscode.CompletionItemKind.Class);
                item.insertText = tableName;
                item.detail = 'Tabela';
                item.documentation = `Nazwa tabeli: ${tableName}`;
                
                if (filterText && !tableName.toLowerCase().includes(filterText.toLowerCase())) {
                    return null;
                }
                
                return item;
            }).filter(item => item !== null) as vscode.CompletionItem[];
            
            return completions;
        }
        
        // Podpowiadanie nazw kolumn po aliasie z kropką (np. "s.")
        if (aliasMatch) {
            const alias = aliasMatch[1];
            
            const fullText = document.getText();
            const currentLine = document.lineAt(position.line).text;
            
            let tableName: string | null = null;
            
            const patterns = [
                new RegExp(`from\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`join\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`,\\s*(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i')
            ];
            
            for (const pattern of patterns) {
                const match = fullText.match(pattern);
                if (match && match[1]) {
                    tableName = match[1];
                    break;
                }
            }
            
            if (!tableName) {
                const inlinePattern = new RegExp(`join\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i');
                const inlineMatch = currentLine.match(inlinePattern);
                if (inlineMatch && inlineMatch[1]) {
                    tableName = inlineMatch[1];
                }
            }
            
            if (tableName) {
                const columns = await getCachedColumns(tableName);
                
                const completions = columns.map((column: any) => {
                    const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
                    item.insertText = column.name;
                    
                    const formattedType = formatColumnType(column);
                    
                    const details: string[] = [];
                    details.push(`${formattedType}`);
                    if (column.isNullable === 'YES') details.push('NULL');
                    else details.push('NOT NULL');
                    if (column.columnKey === 'PRI') details.push('🔑 PRIMARY KEY');
                    if (column.columnKey === 'UNI') details.push('🔗 UNIQUE');
                    if (column.extra === 'auto_increment') details.push('📈 AUTO_INCREMENT');
                    if (column.defaultValue !== null) details.push(`📌 DEFAULT: ${column.defaultValue}`);
                    
                    item.detail = `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
                    item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;
                    return item;
                });
                
                return completions;
            }
        }
        
        // Podpowiadanie kolumn gdy kursor jest między SELECT a FROM (bez aliasu)
        const selectSectionMatch = linePrefix.match(/select\s+(\w*)$/i);
        if (selectSectionMatch) {
            const fullText = document.getText();
            const fromTableMatch = fullText.match(/from\s+(\w+)\b/i);
            
            if (fromTableMatch && fromTableMatch[1]) {
                const tableName = fromTableMatch[1];
                const columns = await getCachedColumns(tableName);
                
                let filterText = selectSectionMatch[1] || '';
                
                const completions = columns
                    .filter((column: any) => {
                        if (!filterText) return true;
                        return column.name.toLowerCase().includes(filterText.toLowerCase());
                    })
                    .map((column: any) => {
                        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
                        item.insertText = column.name;
                        
                        const formattedType = formatColumnType(column);
                        
                        const details: string[] = [];
                        details.push(`${formattedType}`);
                        if (column.isNullable === 'YES') details.push('NULL');
                        else details.push('NOT NULL');
                        if (column.columnKey === 'PRI') details.push('🔑 PRIMARY KEY');
                        if (column.columnKey === 'UNI') details.push('🔗 UNIQUE');
                        if (column.extra === 'auto_increment') details.push('📈 AUTO_INCREMENT');
                        if (column.defaultValue !== null) details.push(`📌 DEFAULT: ${column.defaultValue}`);
                        
                        item.detail = `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
                        item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;
                        return item;
                    });
                
                if (completions.length > 0) {
                    return completions;
                }
            }
        }
        
        return [];
    }
}
