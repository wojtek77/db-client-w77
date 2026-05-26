export interface ParsedQuery {
    columns: string[];      // Lista kolumn do wyświetlenia
    tables: string[];       // Lista użytych tabel
    originalSql: string;    // Oryginalne zapytanie
}

// Funkcja do pobierania kolumn z cache (będzie przekazana z zewnątrz)
let getCachedColumnsFn: ((tableName: string) => Promise<string[]>) | null = null;

export function setGetCachedColumnsFunction(fn: (tableName: string) => Promise<string[]>) {
    getCachedColumnsFn = fn;
}

// Główna funkcja parsująca SELECT
export async function parseSelectQuery(sql: string): Promise<ParsedQuery> {
    const trimmedSql = sql.trim();
    
    
    // Sprawdź czy to SELECT
    if (!trimmedSql.toLowerCase().startsWith('select')) {
        
        return { columns: [], tables: [], originalSql: sql };
    }
    
    // Wyciągnij część między SELECT a FROM
    const selectMatch = trimmedSql.match(/select\s+(.*?)\s+from\s+/i);
    if (!selectMatch) {
        
        return { columns: [], tables: [], originalSql: sql };
    }
    
    const selectClause = selectMatch[1].trim();
    
    
    // Wyciągnij nazwy tabel (pomijamy aliasy)
    const fromMatch = trimmedSql.match(/from\s+([^\s]+(?:\s+join\s+[^\s]+)*)/i);
    const tableNames: string[] = [];
    
    if (fromMatch) {
        const fromClause = fromMatch[1];
        const tableMatches = fromClause.match(/(\w+)(?:\s+(?:as\s+)?\w+)?/gi);
        if (tableMatches) {
            tableMatches.forEach(t => {
                const tableName = t.trim();
                if (tableName && !tableName.toLowerCase().startsWith('join')) {
                    tableNames.push(tableName);
                }
            });
        }
    }
    
    let columns: string[] = [];
    
    // Przypadek 1: SELECT * FROM tabela
    // Przypadek 1: SELECT * FROM tabela (lub SELECT s.* FROM tabela s)
    if (selectClause === '*' || selectClause.match(/^\w+\.\*$/)) {
        let tableName: string | null = null;
        
        // Jeśli jest alias (np. "s.*")
        const aliasMatch = selectClause.match(/^(\w+)\.\*$/);
        if (aliasMatch) {
            const alias = aliasMatch[1];
            // Znajdź tabelę dla tego aliasu
            const fromMatch = trimmedSql.match(new RegExp(`from\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'));
            if (fromMatch && fromMatch[1]) {
                tableName = fromMatch[1];
            }
        } else {
            // Brak aliasu, weź pierwszą tabelę
            if (tableNames.length > 0) {
                tableName = tableNames[0];
            }
        }
        
        if (tableName && getCachedColumnsFn) {
            columns = await getCachedColumnsFn(tableName);
            
        } else {
            
        }
    }
    // Przypadek 2: SELECT konkretne kolumny (np. "id, firstname" lub "s.id, s.status")
    else {
        // Parsuj listę kolumn
        const columnMatches = selectClause.match(/(\w+(?:\.\w+)?)(?:\s+as\s+\w+)?/gi);
        if (columnMatches) {
            columns = columnMatches.map(c => {
                // Usuń alias tabeli (np. "s.id" -> "id")
                let columnName = c.trim();
                const dotMatch = columnName.match(/^\w+\.(\w+)$/);
                if (dotMatch) {
                    columnName = dotMatch[1];  // Weź tylko część po kropce
                }
                // Jeśli jest AS, weź pierwszą część
                const asMatch = columnName.match(/(\w+)\s+as\s+\w+/i);
                if (asMatch) {
                    return asMatch[1];
                }
                return columnName;
            });
            
        }
    }
    
    return {
        columns: columns,
        tables: tableNames,
        originalSql: sql
    };
}
