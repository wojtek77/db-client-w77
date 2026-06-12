const REGEX_TRAILING_SEMICOLON =
    /;$/;

const REGEX_SINGLE_LINE_COMMENTS =
    /--.*$/gm;

const REGEX_MULTI_LINE_COMMENTS =
    /\/\*.*?\*\//gs;

const REGEX_STRING_LITERALS =
    /'[^'\\]*(?:\\.[^'\\]*)*'/gs;

const REGEX_SELECT_WITHOUT_LIMIT =
    /^select(?:.*\(.+\))?(?!.*\slimit\s)/is;

export class SqlUtil {

    // public static isSelect(sql: string): boolean {
    //     return /^select\s/i.test(sql);
    // }
    
    public static appendLimit(
        sql: string,
        limit: number = 200
    ): string {
        const needsLimit = this.hasNoLimit(sql);
        if (needsLimit) {
            return sql
                .replace(REGEX_TRAILING_SEMICOLON, '') + `\nLIMIT ${limit}`;
        }
        return sql;
    }
    
    private static hasNoLimit(sql: string): boolean {
        // 1. Usuń komentarze jednowierszowe
        let cleaned = sql.replace(REGEX_SINGLE_LINE_COMMENTS, '');
        
        // 2. Usuń komentarze wielowierszowe
        cleaned = cleaned.replace(REGEX_MULTI_LINE_COMMENTS, '');
        
        // 3. Usuń stringi literałowe (opcjonalnie – mogą zawierać 'limit')
        cleaned = cleaned.replace(REGEX_STRING_LITERALS, "''");
        
        // 4. Teraz sprawdź
        return REGEX_SELECT_WITHOUT_LIMIT.test(cleaned);
    }
}
