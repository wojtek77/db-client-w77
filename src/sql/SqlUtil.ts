export class SqlUtil {

    public static isSelect(sql: string): boolean {
        return /^select\s/i.test(sql);
    }
    
    public static appendLimit(
        sql: string,
        limit: number = 200
    ): string {
        const needsLimit = this.hasNoLimit(sql);
        if (needsLimit) {
            return sql + `\nLIMIT ${limit}`;
        }
        return sql;
    }
    
    private static hasNoLimit(sql: string): boolean {
        // 1. Usuń komentarze jednowierszowe
        let cleaned = sql.replace(/--.*$/gm, '');
        
        // 2. Usuń komentarze wielowierszowe
        cleaned = cleaned.replace(/\/\*.*?\*\//gs, '');
        
        // 3. Usuń stringi literałowe (opcjonalnie – mogą zawierać 'limit')
        cleaned = cleaned.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/gs, "''");
        
        // 4. Teraz sprawdź
        return /^select(?:.*\(.+\))?(?!.*\slimit\s)/is.test(cleaned);
    }
}
