// wspólne elementy podpowiadania USE/FORCE/IGNORE INDEX, używane przez CompletionSelect, CompletionUpdate i CompletionDelete

// słowa kluczowe index hintu, wspólne dla wszystkich typów zapytań je wspierających
export const INDEX_HINT_KEYWORDS = ['USE INDEX', 'FORCE INDEX', 'IGNORE INDEX'];

// kursor wewnątrz nawiasu USE/FORCE/IGNORE {INDEX|KEY} (...) - podpowiadamy realne nazwy indeksów, wspólne dla SELECT/UPDATE/DELETE, bo składnia samego nawiasu jest identyczna niezależnie od typu zapytania
export const REGEX_INDEX_LIST = /\b(?:use|force|ignore)\s+(?:index|key)\s*(?:for\s+(?:join|order\s+by|group\s+by)\s*)?\(\s*(?:`?\w+`?\s*,\s*)*`?(\w*)$/i;

// pozycja tuż po nazwie tabeli i opcjonalnym aliasie w klauzuli FROM/JOIN (np. "FROM users u |") - używane przez SELECT i multi-table DELETE, bo tam gramatyka FROM jest identyczna; grupa 1: tabela, grupa 2: opcjonalny alias, grupa 3: aktualnie pisane słowo (filtr, może być puste)
export const REGEX_FROM_JOIN_INDEX_HINT_KEYWORD = /\b(?:from|join)\s+(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?(\w+)`?)?\s+(\w*)$/i;

// znajduje tabelę, do której odnosi się otwarty nawias USE/FORCE/IGNORE INDEX ( po FROM/JOIN - global, bo interesuje nas ostatnie (najbliższe kursorowi) wystąpienie
export const REGEX_FROM_JOIN_INDEX_HINT_TABLE = /\b(?:from|join)\s+(?:`?\w+`?\s*\.\s*)?`?(\w+)`?(?:\s+(?:as\s+)?`?\w+`?)?\s+(?:use|force|ignore)\s+(?:index|key)\s*(?:for\s+(?:join|order\s+by|group\s+by)\s*)?\(/gi;

// bierze ostatnie (najbliższe kursorowi) dopasowanie global regexu REGEX_FROM_JOIN_INDEX_HINT_TABLE - w zapytaniu może być kilka JOIN-ów, każdy z własnym index hintem
export function extractPrecedingFromJoinTableName(fromClauseTail: string): string | undefined {
    const matches = [...fromClauseTail.matchAll(REGEX_FROM_JOIN_INDEX_HINT_TABLE)];
    return matches.at(-1)?.[1];
}
