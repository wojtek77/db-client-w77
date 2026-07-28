import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { SQL_FUNCTIONS } from './sqlFunctions.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { findCteDefinitions } from '../sql/findCteDefinitions.js';
import { findDerivedTables } from '../sql/findDerivedTables.js';
import { CompletionInterface } from './CompletionInterface.js';
import { tokenize, computeDepths, currentDepth, Token } from '../sql/tokenizer.js';
import {
    INDEX_HINT_KEYWORDS,
    REGEX_INDEX_LIST,
    REGEX_FROM_JOIN_INDEX_HINT_KEYWORD as REGEX_INDEX_HINT_KEYWORD,
    extractPrecedingFromJoinTableName,
} from './indexHints.js';

// `?` wokół identyfikatorów obsługuje cytowanie w backtickach (standard MySQL/MariaDB, np. `` `order` ``) - grupy przechwytują samą nazwę, bez backticków
const REGEX_SCHEMA_TABLE = /\b(?:from|join)\s+`?(\w+)`?\s*\.\s*`?(\w*)$/i;
const REGEX_FROM_OBJECT = /\b(?:from|join)\s+`?(\w*)$/i;
// analogiczne regexy dla kolejnej tabeli po przecinku w starym stylu JOIN - tylko gdy kursor jest w klauzuli FROM, inaczej złapałyby przecinek w SELECT
const REGEX_COMMA_SCHEMA_TABLE = /,\s*`?(\w+)`?\s*\.\s*`?(\w*)$/;
const REGEX_COMMA_OBJECT = /,\s*`?(\w*)$/;
// 3 grupy: segment1[.segment2] to alias albo schema.table, ostatnia grupa to filtr kolumny (obsługuje częściowo wpisaną nazwę, np. `l.date_ent|`); `?` obsługuje backticki
const REGEX_ALIAS_DOT = /`?([a-zA-Z0-9_]+)`?(?:\s*\.\s*`?([a-zA-Z0-9_]+)`?)?\s*\.\s*`?(\w*)$/;

// modyfikatory MySQL/MariaDB dopuszczalne bezpośrednio po słowie SELECT, przed listą wybieranych wyrażeń
// (SELECT [ALL | DISTINCT | DISTINCTROW] [HIGH_PRIORITY] [STRAIGHT_JOIN] [SQL_SMALL_RESULT] [SQL_BIG_RESULT] [SQL_BUFFER_RESULT] [SQL_NO_CACHE] [SQL_CALC_FOUND_ROWS] ...)
const SELECT_MODIFIERS = [
    'ALL', 'DISTINCT', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN',
    'SQL_SMALL_RESULT', 'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS'
];

export type SelectClauseName = 'select' | 'from' | 'where' | 'group' | 'having' | 'order' | 'limit' | 'partition';

export interface DetectedClause {
    name: SelectClauseName;
    // offset słowa rozpoczynającego klauzulę w oryginalnym sqlBeforeCursor - potrzebne tylko do przekazania do isCursorInsideFunctionCall
    start: number;
}

// pojedyncze słowo -> nazwa klauzuli; GROUP/ORDER wymagają jeszcze sprawdzenia kolejnego tokena ('BY'), patrz niżej
const CLAUSE_WORD: Partial<Record<string, SelectClauseName>> = {
    SELECT: 'select',
    FROM: 'from',
    WHERE: 'where',
    HAVING: 'having',
    LIMIT: 'limit',
};

// zwraca kolejny token pomijając komentarze (np. GROUP /* uwaga */ BY nie powinno gubić słowa BY)
function nextSignificantToken(tokens: Token[], fromIndex: number): Token | undefined {
    for (let j = fromIndex; j < tokens.length; j++) {
        if (tokens[j].type !== 'comment') { return tokens[j]; }
    }
    return undefined;
}

interface SelectModifierContext {
    // modyfikatory już wpisane wcześniej w tej samej klauzuli SELECT (np. po "SELECT DISTINCT " -> {'DISTINCT'}) - nie proponujemy ich ponownie
    used: Set<string>;
    // fragment aktualnie pisanego słowa (np. "SELECT DIS|" -> "dis") - do przefiltrowania podpowiedzi
    filter: string;
}

// sprawdza, czy kursor w klauzuli SELECT jest jeszcze w "strefie modyfikatorów", czyli między słowem SELECT
// a pierwszym realnym wyrażeniem z listy wybieranych kolumn - tylko wtedy warto podpowiadać DISTINCT i pokrewne słowa
// zwraca null, gdy w klauzuli pojawiło się już coś innego niż same modyfikatory (kolumna, przecinek, nawias, gwiazdka itd.)
function getSelectModifierContext(sqlBeforeCursor: string, selectStart: number): SelectModifierContext | null {
    const tail = sqlBeforeCursor.slice(selectStart);
    const tokens = tokenize(tail);
    const used = new Set<string>();
    let filter = '';

    // pomijamy tokens[0], to samo słowo SELECT
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'comment') { continue; }
        if (t.type !== 'word') { return null; }

        // ostatni token dotykający końca fragmentu to właśnie pisane słowo, a nie ukończony modyfikator
        const isBeingTyped = i === tokens.length - 1 && t.start + t.value.length === tail.length;
        if (isBeingTyped) { filter = t.value.toLowerCase(); break; }

        const upper = t.value.toUpperCase();
        if (!SELECT_MODIFIERS.includes(upper)) { return null; }
        used.add(upper);
    }

    return { used, filter };
}

// wykrywa, w której klauzuli zapytania SELECT znajduje się kursor (koniec sqlBeforeCursor)
// liczy się z zagnieżdżeniem w nawiasach (podzapytania, wywołania funkcji) - szukamy klauzul tylko na głębokości, na której faktycznie stoi kursor,
// a nie zawsze na najwyższym poziomie, bo inaczej HAVING/SELECT wewnątrz "FROM (SELECT ... )" myliłoby się z klauzulami zapytania zewnętrznego
// dzięki tokenizacji słowo kluczowe wewnątrz stringa/komentarza albo będące częścią dłuższego identyfikatora (np. "transform_flag" zawiera "from")
// nie jest już mylnie brane za granicę klauzuli - to był realny błąd poprzedniej wersji opartej na indexOf na surowym tekście
export function detectCurrentClause(sqlBeforeCursor: string): DetectedClause | undefined {
    const tokens = tokenize(sqlBeforeCursor);
    const depths = computeDepths(tokens);
    const targetDepth = currentDepth(tokens);

    let found: DetectedClause | undefined;
    for (let i = 0; i < tokens.length; i++) {
        if (depths[i] !== targetDepth) { continue; }
        const t = tokens[i];
        if (t.type !== 'word') { continue; }
        const upper = t.value.toUpperCase();
        const next = nextSignificantToken(tokens, i + 1);
        const nextUpper = next?.type === 'word' ? next.value.toUpperCase() : undefined;

        if (upper === 'GROUP' && nextUpper === 'BY') { found = { name: 'group', start: t.start }; continue; }
        if (upper === 'ORDER' && nextUpper === 'BY') { found = { name: 'order', start: t.start }; continue; }
        if (upper === 'PARTITION' && nextUpper === 'BY') { found = { name: 'partition', start: t.start }; continue; }

        const simple = CLAUSE_WORD[upper];
        if (simple) { found = { name: simple, start: t.start }; }
    }
    return found;
}

export class CompletionSelect extends CompletionAbstract implements CompletionInterface {

    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {
        
        const detectedClause = detectCurrentClause(sqlBeforeCursor);
        const currentClause = detectedClause?.name;
        // offset klauzuli HAVING w sqlBeforeCursor - potrzebny tylko do isCursorInsideFunctionCall (metoda dziedziczona z CompletionAbstract, na razie działa na tekście, nie na tokenach)
        const havingIndex = currentClause === 'having' ? detectedClause!.start : -1;
        
        const isInSelectClause    = currentClause === 'select';
        const isInFromClause      = currentClause === 'from';
        const isInWhereClause     = currentClause === 'where';
        const isInGroupClause     = currentClause === 'group';
        const isInHavingClause    = currentClause === 'having';
        const isInOrderClause     = currentClause === 'order';
        const isInLimitClause     = currentClause === 'limit';
        const isInPartitionClause = currentClause === 'partition';

        const defaultSchema = db.getDatabase();

        // USE/FORCE/IGNORE INDEX (xxx) - kursor wewnątrz nawiasu index hintu, sprawdzane niezależnie od detectCurrentClause/isInFromClause, bo otwarty nawias podnosi głębokość zagnieżdżenia i FROM (na głębokości 0) przestałby być widoczny dla standardowej detekcji klauzuli - ten sam problem, który dla HAVING rozwiązuje isCursorInsideFunctionCall
        if (this.tableIndexesService) {
            const indexListMatch = sqlBeforeCursor.match(REGEX_INDEX_LIST);
            if (indexListMatch) {
                const table = extractPrecedingFromJoinTableName(sqlBeforeCursor);
                if (table) {
                    const filter = indexListMatch[1].toLowerCase();
                    const tableRef = { schema: defaultSchema || db.findSchemaByTable(table) || '', table };
                    const indexesMap = await this.tableIndexesService.getCachedIndexesBatch([tableRef]);
                    const indexes = indexesMap[this.tableIndexesService.getTableRefKey(tableRef)] ?? [];

                    // sortujemy wg połączonych nazw kolumn (np. "aaa" przed "aaa,bbb" przed "bbb"), a nie wg samej nazwy indeksu
                    return indexes
                        .filter(index => !filter || index.name.toLowerCase().includes(filter))
                        .sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')))
                        .map((index, order) => this.createIndexNameItem(table, index.name, index.type, index.columns, order));
                }
            }
        }
        
        /* LIMIT */
        if (isInLimitClause) {
            return [
                new vscode.CompletionItem('1', vscode.CompletionItemKind.Value),
                new vscode.CompletionItem('10', vscode.CompletionItemKind.Value),
                new vscode.CompletionItem('100', vscode.CompletionItemKind.Value)
            ];
        }

        /* HAVING */
        if (isInHavingClause) {
            const result: vscode.CompletionItem[] = [];

            // sprawdzamy czy kursor jest wewnątrz nawiasów funkcji (np. GROUP_CONCAT(|)) – jeśli tak, pomijamy SELECT i serwujemy kolumny z tabel zapytania
            if (this.isCursorInsideFunctionCall(sqlBeforeCursor, havingIndex)) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);
                return result;
            }

            // wyciągamy fragment SELECT...FROM z tego samego poziomu zagnieżdżenia
            const selectPart = this.extractSelectPartAtCursorLevel(sqlBeforeCursor);
            const candidates = this.extractHavingCandidates(selectPart);

            let shouldLoadAllTables = false;
            const specificAliasesToLoad = new Set<string>();

            for (const word of candidates) {
                if (word === '*') {
                    shouldLoadAllTables = true;
                } else if (word.endsWith('.*')) {
                    const alias = word.split('.')[0];
                    if (alias) {
                        specificAliasesToLoad.add(alias.toLowerCase());
                    }
                } else {
                    const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
                    item.sortText = `5_${word}`;
                    result.push(item);
                }
            }

            // wspólna metoda: Ładujemy kolumny z tabel na podstawie gwiazdek
            if (shouldLoadAllTables) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);
            } else if (specificAliasesToLoad.size > 0) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor, specificAliasesToLoad);
            }

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }
            return result;
        }

        // fallback dla FROM/JOIN w innej linii niż nazwa schematu/tabeli - linePrefix widzi tylko bieżącą linię, więc próbujemy dopasować regexy też do fragmentu sqlBeforeCursor od początku klauzuli FROM
        const fromClauseTail = isInFromClause ? sqlBeforeCursor.slice(detectedClause!.start) : '';

        /* FROM schema. / JOIN schema. / , schema. (kolejna tabela po przecinku) */
        const schemaTableMatch =
            linePrefix.match(REGEX_SCHEMA_TABLE)
            ?? (isInFromClause ? fromClauseTail.match(REGEX_SCHEMA_TABLE) : null)
            ?? (isInFromClause ? fromClauseTail.match(REGEX_COMMA_SCHEMA_TABLE) : null);
        if (schemaTableMatch) {
            const schema = schemaTableMatch[1];
            const filter = schemaTableMatch[2].toLowerCase();

            return db
                .getTables(schema)
                .filter(table => table.toLowerCase().includes(filter))
                .map((table, index) => this.createTableItem(table, index));
        }

        /* FROM xxx / JOIN xxx / , xxx (kolejna tabela po przecinku) */
        const objectMatch =
            linePrefix.match(REGEX_FROM_OBJECT)
            ?? (isInFromClause ? fromClauseTail.match(REGEX_FROM_OBJECT) : null)
            ?? (isInFromClause ? fromClauseTail.match(REGEX_COMMA_OBJECT) : null);
        if (objectMatch) {
            const filter = objectMatch[1].toLowerCase();
            const result: vscode.CompletionItem[] = [];

            if (db.getDatabase()) {
                let tableOrder = 0;
                for (const table of db.getDefaultDatabaseTables()) {
                    if (filter && !table.toLowerCase().includes(filter)) {
                        continue;
                    }
                    result.push(this.createTableItem(table, tableOrder++));
                }
            }

            const schemas = db.getSchemas();
            schemas.forEach((schema, index) => {
                if (filter && !schema.toLowerCase().includes(filter)) {
                    return;
                }
                result.push(this.createSchemaItem(schema, index));
            });

            return result;
        }

        // alias lub pełna nazwa tabeli (np. s. lub public.contacts.), opcjonalnie z już częściowo wpisaną nazwą kolumny (np. s.na lub public.contacts.na)
        const aliasMatch = linePrefix.match(REGEX_ALIAS_DOT);
        if (aliasMatch) {
            // grupa 2 obecna tylko dla formy schema.table. - grupy nie zawierają backticków, nawet jeśli w tekście były
            const alias = aliasMatch[2] ? `${aliasMatch[1]}.${aliasMatch[2]}` : aliasMatch[1];
            const columnFilter = aliasMatch[3].toLowerCase();
            const parts = alias.split('.');

            if (parts.length === 2) {
                const schema = parts[0];
                const table  = parts[1];

                if (!schema || !table) {
                    return [];
                }

                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([{ schema, table }]);
                const columns = columnsMap[this.tableColumnsService.getTableRefKey({ schema, table })] ?? [];

                return columns
                    .filter((column: TableColumn) => !columnFilter || column.name.toLowerCase().includes(columnFilter))
                    .map((column: TableColumn) => this.createColumnItem(table, column));
            }

            let tableRef: TableRef | null = null;

            // `?` wokół schematu/tabeli/aliasu obsługuje deklaracje w backtickach (np. FROM `users` `u`)
            const patterns = [
                new RegExp(`from\\s+(?:\`?(\\w+)\`?\\s*\\.\\s*)?\`?(\\w+)\`?\\s+(?:as\\s+)?\`?${alias}\`?\\b`, 'i'),
                new RegExp(`join\\s+(?:\`?(\\w+)\`?\\s*\\.\\s*)?\`?(\\w+)\`?\\s+(?:as\\s+)?\`?${alias}\`?\\b`, 'i'),
                new RegExp(`,\\s*(?:\`?(\\w+)\`?\\s*\\.\\s*)?\`?(\\w+)\`?\\s+(?:as\\s+)?\`?${alias}\`?\\b`, 'i')
            ];

            for (const pattern of patterns) {
                const match = fullText.match(pattern);
                if (!match) {
                    continue;
                }
                tableRef = {
                    schema: match[1] || defaultSchema || db.findSchemaByTable(match[2]) || '',
                    table: match[2]
                };
                break;
            }

            if (!tableRef) {
                tableRef = {
                    schema: defaultSchema || db.findSchemaByTable(alias) || '',
                    table: alias
                };
            }

            // CTE nie istnieje w katalogu bazy - jeśli tableRef wskazuje na CTE, kolumny bierzemy z jego definicji, a nie z prawdziwej tabeli
            const cte = findCteDefinitions(fullText).find(c => c.name.toLowerCase() === tableRef!.table.toLowerCase());
            if (cte) {
                return cte.columns
                    .filter(name => !columnFilter || name.toLowerCase().includes(columnFilter))
                    .map(name => this.createInferredColumnItem(tableRef!.table, name, 'CTE'));
            }

            // podzapytanie w FROM z aliasem (derived table) - alias nie odpowiada żadnej realnej tabeli, kolumny bierzemy z jego własnej listy SELECT
            const derivedTable = findDerivedTables(fullText).find(d => d.alias.toLowerCase() === tableRef!.table.toLowerCase());
            if (derivedTable) {
                return derivedTable.columns
                    .filter(name => !columnFilter || name.toLowerCase().includes(columnFilter))
                    .map(name => this.createInferredColumnItem(tableRef!.table, name, 'derived table'));
            }

            // pre-fetch kolumn dla wszystkich tabel jednym batchem, celowo bez scopingu po cursorOffset – sugestia i tak buduje się z jednego `tableRef`
            const allTableRefs = findQueryTables(fullText, defaultSchema ?? '', db);
            const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(
                allTableRefs.length > 0 ? allTableRefs : [tableRef]
            );
            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];

            return columns
                .filter((column: TableColumn) => !columnFilter || column.name.toLowerCase().includes(columnFilter))
                .map((column: TableColumn) => this.createColumnItem(tableRef!.table, column));
        }

        /* USE INDEX / FORCE INDEX / IGNORE INDEX - tuż po nazwie tabeli (i opcjonalnym aliasie) w FROM/JOIN */
        if (isInFromClause) {
            const indexHintMatch = linePrefix.match(REGEX_INDEX_HINT_KEYWORD) ?? fromClauseTail.match(REGEX_INDEX_HINT_KEYWORD);
            if (indexHintMatch) {
                const filter = indexHintMatch[3].toLowerCase();
                return INDEX_HINT_KEYWORDS
                    .filter(keyword => !filter || keyword.toLowerCase().startsWith(filter))
                    .map((keyword, order) => this.createIndexHintKeywordItem(keyword, order));
            }
        }

        /* SELECT, WHERE, GROUP BY, ORDER BY, PARTITION BY <Ctrl+Space> */
        if (isInSelectClause || isInWhereClause || isInGroupClause || isInOrderClause || isInPartitionClause) {
            const result: vscode.CompletionItem[] = [];

            // modyfikatory SELECT (DISTINCT, ALL itd.) - tylko dopóki w klauzuli nie pojawiło się jeszcze żadne realne wyrażenie kolumnowe
            if (isInSelectClause) {
                const modifierContext = getSelectModifierContext(sqlBeforeCursor, detectedClause!.start);
                if (modifierContext) {
                    let order = 0;
                    for (const modifier of SELECT_MODIFIERS) {
                        if (modifierContext.used.has(modifier)) { continue; }
                        if (modifierContext.filter && !modifier.toLowerCase().startsWith(modifierContext.filter)) { continue; }
                        result.push(this.createKeywordItem(modifier, order++));
                    }
                }
            }

            // wspólna metoda: Ładujemy wszystkie kolumny dla klauzul strukturalnych
            await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);

            // GROUP BY / ORDER BY mogą odwoływać się do aliasu z listy SELECT (np. "SELECT id xxx ... GROUP BY xxx") - dorzucamy je jako kandydatów tekstowych, pomijając te, które już pokrywają realne kolumny załadowane wyżej (np. gołe "id" bez aliasu)
            if (isInGroupClause || isInOrderClause) {
                const existingLabels = new Set(result.map(item => (typeof item.label === 'string' ? item.label : item.label.label).toLowerCase()));
                const selectPart = this.extractSelectPartAtCursorLevel(sqlBeforeCursor);
                for (const word of this.extractHavingCandidates(selectPart)) {
                    if (word === '*' || word.endsWith('.*') || existingLabels.has(word.toLowerCase())) { continue; }
                    const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
                    item.sortText = `5_${word}`;
                    result.push(item);
                }
            }

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        return [];
    }
}
