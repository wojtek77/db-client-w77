import { getTableColumns, setGetCachedColumnsFunction } from '../db/query';

// Cache dla kolumn tabel - przechowuje pełne informacje o kolumnach
let tableColumnsCache: Map<string, any[]> = new Map();

// Funkcja do pobierania kolumn z cache lub z bazy (dla autouzupełniania)
export async function getCachedColumns(tableName: string): Promise<any[]> {
    if (tableColumnsCache.has(tableName)) {
        
        return tableColumnsCache.get(tableName)!;
    }
    
    
    const columns = await getTableColumns(tableName);
    tableColumnsCache.set(tableName, columns);
    
    
    return columns;
}

// Funkcja dla parsera SQL (zwraca tylko nazwy kolumn jako string[])
export async function getCachedColumnsAsStrings(tableName: string): Promise<string[]> {
    const columns = await getCachedColumns(tableName);
    return columns.map((col: any) => col.name);
}
