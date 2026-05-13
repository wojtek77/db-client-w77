export class SqlUtil {

    public static appendLimit(
        sql: string,
        limit: number = 200
    ): string {
        const needsLimit = this.hasNoLimit(sql);
        if (needsLimit) {
            let cleanSql = sql
                .replace(/--[^--]*$/, '')           // końcowy -- komentarz
                .replace(/\/\*[\s\S]*?\*\/$/, '')   // końcowy /* */ komentarz (wielolinijkowy)
                .replace(/;$/, '')                  // usuń średnik
                .trimEnd();
            
            return cleanSql + ` LIMIT ${limit}`;
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
