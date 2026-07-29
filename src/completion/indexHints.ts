// wspólne elementy podpowiadania USE/FORCE/IGNORE INDEX, używane przez CompletionSelect, CompletionUpdate i CompletionDelete

// słowa kluczowe index hintu, wspólne dla wszystkich typów zapytań je wspierających
export const INDEX_HINT_KEYWORDS = ['USE INDEX', 'FORCE INDEX', 'IGNORE INDEX'];

// kursor wewnątrz nawiasu USE/FORCE/IGNORE {INDEX|KEY} (...) - podpowiadamy realne nazwy indeksów, wspólne dla SELECT/UPDATE/DELETE, bo składnia samego nawiasu jest identyczna niezależnie od typu zapytania
export const REGEX_INDEX_LIST = /\b(?:use|force|ignore)\s+(?:index|key)\s*(?:for\s+(?:join|order\s+by|group\s+by)\s*)?\(\s*(?:`?\w+`?\s*,\s*)*`?(\w*)$/i;

// pozycja tuż po nazwie tabeli i opcjonalnym aliasie w klauzuli FROM/JOIN (np. "FROM users u |") - używane przez SELECT i multi-table DELETE, bo tam gramatyka FROM jest identyczna; grupa 1: tabela, grupa 2: opcjonalny alias, grupa 3: aktualnie pisane słowo (filtr, może być puste)
export const REGEX_FROM_JOIN_INDEX_HINT_KEYWORD = /\b(?:from|join)\s+(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?(\w+)`?)?\s+(\w*)$/i;

// znajduje tabelę, do której odnosi się otwarty nawias USE/FORCE/IGNORE INDEX ( po FROM/JOIN - global, może być wiele takich tabel w jednym zapytaniu
export const REGEX_FROM_JOIN_INDEX_HINT_TABLE = /\b(?:from|join)\s+(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?\w+`?)?\s+(?:use|force|ignore)\s+(?:index|key)\s*(?:for\s+(?:join|order\s+by|group\s+by)\s*)?\(/gi;

// tabela po przecinku w liście table_references (np. "FROM client c, student s |") - dotyczy zarówno SELECT/DELETE (przecinek = CROSS JOIN), grupa 1: tabela, grupa 2: opcjonalny alias, grupa 3: aktualnie pisane słowo (filtr, może być puste)
export const REGEX_COMMA_INDEX_HINT_KEYWORD = /,\s*(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?(\w+)`?)?\s+(\w*)$/i;

// wykrywa tabelę po przecinku, do której odnosi się otwarty nawias USE/FORCE/IGNORE INDEX ( - global, może być wiele takich tabel w jednym zapytaniu
export const REGEX_COMMA_INDEX_HINT_TABLE = /,\s*(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?\w+`?)?\s+(?:use|force|ignore)\s+(?:index|key)\s*(?:for\s+(?:join|order\s+by|group\s+by)\s*)?\(/gi;

// gdy zapytanie ma kilka index hintów naraz (np. każda tabela w multi-table UPDATE/DELETE ma własny "USE INDEX (...)"), zwykłe ?? między regexami zawsze wygrałoby pierwszy PASUJĄCY wzorzec, a nie ten faktycznie najbliższy kursorowi - stąd ta funkcja bierze pod uwagę WSZYSTKIE dopasowania ze WSZYSTKICH podanych regexów naraz i wybiera to, które kończy się najbliżej końca tekstu (czyli najbliżej kursora)
export function extractClosestPrecedingTableName(text: string, regexes: RegExp[]): string | undefined {
    let bestTable: string | undefined;
    let bestEnd = -1;

    for (const regex of regexes) {
        for (const match of text.matchAll(regex)) {
            const end = (match.index ?? 0) + match[0].length;
            if (end > bestEnd) {
                bestEnd = end;
                bestTable = match[1];
            }
        }
    }

    return bestTable;
}
