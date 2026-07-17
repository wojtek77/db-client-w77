const REGEX_TRAILING_SEMICOLON =
    /;$/;

// Usuwamy razem z kończącym znakiem nowej linii (\n?) - z tego samego
// powodu co REGEX_HASH_COMMENTS poniżej
const REGEX_SINGLE_LINE_COMMENTS =
    /--.*\n?/gm;

// Komentarze jednowierszowe w stylu MySQL/MariaDB (np. "# komentarz").
// Usuwamy razem z kończącym znakiem nowej linii (\n?), żeby po wycięciu
// komentarza "select" był pierwszym tokenem (bez pozostałości \n przed nim)
const REGEX_HASH_COMMENTS =
    /#.*\n?/gm;

const REGEX_MULTI_LINE_COMMENTS =
    /\/\*.*?\*\//gs;

const REGEX_STRING_LITERALS =
    /'[^'\\]*(?:\\.[^'\\]*)*'/gs;

const REGEX_SELECT_WITHOUT_LIMIT =
    /^select(?:.*\(.+\))?(?!.*\slimit\s)/is;

export class SqlUtil {

    /**
     * Wykrywa polecenia zapisujące dane (INSERT/UPDATE/DELETE/REPLACE) oraz DDL
     * (CREATE/ALTER/DROP/TRUNCATE/RENAME) - używane do blokowania zapisu na
     * połączeniach oznaczonych jako "readonly".
     */
    public static isWriteStatement(sql: string): boolean {
        return /^(insert|update|delete|replace|create|alter|drop|truncate|rename)\s/i.test(sql.trim());
    }

    public static isSelect(sql: string): boolean {
        return /^select\s/i.test(sql);
    }

    /**
     * Wykrywa polecenia DDL (CREATE/ALTER/DROP/TRUNCATE/RENAME).
     * W MySQL/MariaDB każde z nich powoduje niejawny COMMIT, więc objęcie
     * ich transakcją NIE gwarantuje możliwości wycofania zmian.
     */
    public static isDDL(sql: string): boolean {
        return /^(create|alter|drop|truncate|rename)\s/i.test(sql.trim());
    }

    public static isUpdateOrDelete(sql: string): boolean {
        return /^(update|delete)\s/i.test(sql.trim());
    }

    /** Best-effort sprawdzenie, czy zapytanie ma klauzulę WHERE (poza komentarzami/stringami). */
    public static hasWhereClause(sql: string): boolean {
        let cleaned = sql.replace(REGEX_SINGLE_LINE_COMMENTS, '');
        cleaned = cleaned.replace(REGEX_MULTI_LINE_COMMENTS, '');
        cleaned = cleaned.replace(REGEX_STRING_LITERALS, "''");
        return /\bwhere\b/i.test(cleaned);
    }
    
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
        // 1. Usuń komentarze jednowierszowe (styl "-- ...")
        let cleaned = sql.replace(REGEX_SINGLE_LINE_COMMENTS, '');

        // 2. Usuń komentarze jednowierszowe (styl MySQL "# ...")
        cleaned = cleaned.replace(REGEX_HASH_COMMENTS, '');

        // 3. Usuń komentarze wielowierszowe
        cleaned = cleaned.replace(REGEX_MULTI_LINE_COMMENTS, '');
        
        // 4. Usuń stringi literałowe (opcjonalnie – mogą zawierać 'limit')
        cleaned = cleaned.replace(REGEX_STRING_LITERALS, "''");
        
        // 5. Teraz sprawdź
        return REGEX_SELECT_WITHOUT_LIMIT.test(cleaned);
    }
}
