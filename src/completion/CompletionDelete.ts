import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { tokenize, computeDepths, currentDepth } from '../sql/tokenizer.js';
import {
    INDEX_HINT_KEYWORDS,
    REGEX_INDEX_LIST,
    REGEX_FROM_JOIN_INDEX_HINT_KEYWORD,
    REGEX_COMMA_INDEX_HINT_KEYWORD,
    REGEX_FROM_JOIN_INDEX_HINT_TABLE,
    REGEX_COMMA_INDEX_HINT_TABLE,
    extractClosestPrecedingTableName,
} from './indexHints.js';

// index hinty (USE/FORCE/IGNORE INDEX) działają w MySQL WYŁĄCZNIE dla wielotabelowego DELETE (np. "DELETE o FROM orders o USE INDEX (...) WHERE ..."), nie dla zwykłego "DELETE FROM tbl WHERE ..." (single-table DELETE nie wspiera index hintów - to błąd składni)
// odróżniamy oba warianty tym, czy po DELETE i modyfikatorach od razu pojawia się FROM (single-table) czy najpierw lista tabel do usunięcia (multi-table)
const REGEX_DELETE_SINGLE_TABLE_FORM = /^\s*delete\s+(?:low_priority\s+)?(?:quick\s+)?(?:ignore\s+)?from\b/i;
function isMultiTableDelete(fullText: string): boolean {
    return !REGEX_DELETE_SINGLE_TABLE_FORM.test(fullText);
}

// modyfikatory MySQL/MariaDB dopuszczalne bezpośrednio po słowie DELETE, przed klauzulą FROM - wszystkie niezależne od siebie (DELETE [LOW_PRIORITY] [QUICK] [IGNORE] FROM tbl_name ...)
const DELETE_MODIFIERS = ['LOW_PRIORITY', 'QUICK', 'IGNORE'];

// wyrażenia regularne dla sekcji tabel (operujące na linePrefix)
const REGEX_DELETE_SCHEMA_TABLE = /\b([\w]+)\.([\w]*)$/i;
// bez \b na początku - w przeciwnym razie nie dopasowuje pustego/samego-białoznakowego linePrefix, np. kursor na nowej linii przed samym wcięciem (ta sama poprawka co w CompletionUpdate.ts)
const REGEX_DELETE_OBJECT = /([\w]*)$/i;

// wyrażenie do wykrywania aliasu z kropką, np. `s.|` lub `c.|`, a także z częściowo wpisaną nazwą kolumny, np. `s.na|` lub `c.id|`
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+)\.(\w*)$/;

// wyrażenie wyciągające sekcję FROM aż do WHERE, ORDER BY, LIMIT lub końca zapytania
const REGEX_DELETE_FROM_CLAUSE = /\bfrom\s+([\s\S]*?)(?:\s+(?:where|order\s+by|limit)\b|$)/i;

// sprawdza, czy kursor jest jeszcze w "strefie modyfikatorów" DELETE, czyli między słowem DELETE a klauzulą FROM
// zwraca null, gdy w tej pozycji pojawiło się już coś innego niż same modyfikatory - czyli FROM
function getDeleteModifierContext(sqlBeforeCursor: string): { used: Set<string>; filter: string } | null {
    const tokens = tokenize(sqlBeforeCursor);
    const used = new Set<string>();
    let filter = '';

    // pomijamy tokens[0], to samo słowo DELETE
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'comment') { continue; }
        if (t.type !== 'word') { return null; }

        const isBeingTyped = i === tokens.length - 1 && t.start + t.value.length === sqlBeforeCursor.length;
        if (isBeingTyped) { filter = t.value.toLowerCase(); break; }

        const upper = t.value.toUpperCase();
        if (upper === 'FROM') { return null; }
        if (!DELETE_MODIFIERS.includes(upper)) { return null; }
        used.add(upper);
    }

    return { used, filter };
}

// słowa zastrzeżone wyciągnięte na górę pliku, aby nie alokować Set-a przy każdym naciśnięciu klawisza
const FORBIDDEN_KEYWORDS = new Set([
    'delete',
    'from',
    'where',
    'ignore',
    'low_priority',
    'quick',
    'inner',
    'join',
    'left',
    'right',
    'outer',
    'cross',
    'straight_join',
    'on',
    'order',
    'by',
    'limit'
]);

// sprawdza, czy kursor jest w kontekście kolumnowym (WHERE albo JOIN...ON), na głębokości zagnieżdżenia kursora
// (podzapytania w WHERE nie mylą tego z klauzulami zewnętrznymi) - idziemy po tokenach, więc np. kolumna "from_date"
// w WHERE nie jest już mylnie brana za nowe FROM, tak jak działo się to przy dawnym indexOf('from') na surowym tekście
export function isInColumnContext(sqlBeforeCursor: string): boolean {
    const tokens = tokenize(sqlBeforeCursor);
    const depths = computeDepths(tokens);
    const targetDepth = currentDepth(tokens);

    let inColumnContext = false;
    for (let i = 0; i < tokens.length; i++) {
        if (depths[i] !== targetDepth) { continue; }
        const t = tokens[i];
        if (t.type !== 'word') { continue; }
        const upper = t.value.toUpperCase();
        if (upper === 'WHERE' || upper === 'ON') { inColumnContext = true; }
        else if (upper === 'FROM' || upper === 'JOIN') { inColumnContext = false; }
    }
    return inColumnContext;
}

export class CompletionDelete extends CompletionAbstract implements CompletionInterface {
    
    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {

        // blokowanie podpowiedzi wewnątrz stringów tekstowych
        const quotesCount = (linePrefix.match(/'/g) || []).length;
        if (quotesCount % 2 !== 0) {
            return [];
        }

        // określamy domyślny kontekst bazy danych
        const defaultSchema = db.getDatabase();

        // USE/FORCE/IGNORE INDEX (xxx) - kursor wewnątrz nawiasu index hintu, tylko dla wielotabelowego DELETE; sprawdzane niezależnie od isInColumnContext, bo otwarty nawias podnosi głębokość zagnieżdżenia i WHERE dalej w tekście jeszcze nie jest "aktywne" na tej głębokości (analogicznie jak w CompletionSelect.ts)
        if (this.tableIndexesService && isMultiTableDelete(fullText)) {
            const indexListMatch = sqlBeforeCursor.match(REGEX_INDEX_LIST);
            if (indexListMatch) {
                const table = extractClosestPrecedingTableName(sqlBeforeCursor, [
                    REGEX_FROM_JOIN_INDEX_HINT_TABLE,
                    REGEX_COMMA_INDEX_HINT_TABLE,
                ]);

                if (table) {
                    const filter = indexListMatch[1].toLowerCase();
                    const tableRef = { schema: defaultSchema || db.findSchemaByTable(table) || '', table };
                    const indexesMap = await this.tableIndexesService.getCachedIndexesBatch([tableRef]);
                    const indexes = indexesMap[this.tableIndexesService.getTableRefKey(tableRef)] ?? [];

                    return indexes
                        .filter(index => !filter || index.name.toLowerCase().includes(filter))
                        .sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')))
                        .map((index, order) => this.createIndexNameItem(table, index.name, index.type, index.columns, order));
                }
            }
        }

        // sprawdzamy, w której sekcji zapytania znajduje się kursor
        const isInWhereClause = isInColumnContext(sqlBeforeCursor);

        // 1. Jeśli jesteśmy w kontekście kolumnowym (WHERE lub JOIN ON)
        if (isInWhereClause) {
            
            // budowanie pełnej listy tabel – A. pobieramy tabele standardowym parserem (allTableRefs zawężone do zasięgu kursora)
            const allTableRefs = findQueryTables(fullText, defaultSchema ?? '', db, sqlBeforeCursor.length);

            // prefetch/cache-warming – batch obejmujący wszystkie tabele w tekście, żeby zmiana zakresu kursora nie wymagała kolejnego zapytania do bazy
            const allTableRefsForPrefetch = findQueryTables(fullText, defaultSchema ?? '', db);

            // b. Obsługa tabel wymienionych po przecinku po klauzuli FROM (Multi-table DELETE)
            const deleteWhereMatch = fullText.match(REGEX_DELETE_FROM_CLAUSE);

            if (deleteWhereMatch && deleteWhereMatch[1]) {
                const tablesPart = deleteWhereMatch[1];
                const tableTokens = tablesPart.split(',');

                for (const token of tableTokens) {
                    const parts = token.trim().split(/\s+/);
                    if (parts.length > 0 && parts[0]) {
                        let table = parts[0];

                        if (!table || FORBIDDEN_KEYWORDS.has(table.toLowerCase())) {
                            continue;
                        }

                        let schema = '';
                        if (table.includes('.')) {
                            const dotParts = table.split('.');
                            schema = dotParts[0];
                            table = dotParts[1];
                        } else {
                            schema = defaultSchema || '';
                        }

                        if (!table) {
                            continue;
                        }

                        // dodajemy tabelę do obu list referencji, jeśli jeszcze jej tam nie ma (na wypadek gdyby standardowy parser jej nie złapał)
                        const exists = allTableRefs.some(
                            ref => ref.schema.toLowerCase() === schema.toLowerCase() && 
                                   ref.table.toLowerCase() === table.toLowerCase()
                        );
                        
                        if (!exists) {
                            allTableRefs.push({ schema, table });
                            allTableRefsForPrefetch.push({ schema, table });
                        }
                    }
                }
            }

            // PRZYPADEK 1A: Kursor stoi bezpośrednio po aliasie z kropką (np. `s.|`, `c.|`)
            const aliasMatch = linePrefix.match(REGEX_ALIAS_DOT);
            if (aliasMatch) {
                const alias = aliasMatch[1].toLowerCase();
                const columnFilter = aliasMatch[2].toLowerCase();
                let matchedTableRef: TableRef | undefined;

                // szukamy w pełnym tekście zapytania, która tabela ma przypisany ten alias
                for (const ref of allTableRefs) {
                    const pattern = new RegExp(`\\b${ref.table}\\s+(?:as\\s+)?${alias}\\b`, 'i');
                    if (pattern.test(fullText)) {
                        matchedTableRef = ref;
                        break;
                    }
                }

                // fallback: jeśli nie wykryto aliasu w tekście, traktujemy tekst przed kropką jako nazwę tabeli
                if (!matchedTableRef) {
                    matchedTableRef = {
                        schema: defaultSchema || db.findSchemaByTable(alias) || '',
                        table: alias
                    };
                }

                // pobieramy kolumny batchem (rozgrzewając cache dla CAŁEGO zapytania)
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(
                    allTableRefsForPrefetch.length > 0 ? allTableRefsForPrefetch : [matchedTableRef]
                );
                const cacheKey = this.tableColumnsService.getTableRefKey(matchedTableRef);
                const columns = columnsMap[cacheKey] ?? [];

                // zwracamy podpowiedzi kolumn dla tego aliasu, opcjonalnie przefiltrowane po już wpisanej części nazwy
                return columns
                    .filter((column: TableColumn) => !columnFilter || column.name.toLowerCase().includes(columnFilter))
                    .map((column: TableColumn) => this.createColumnItem(matchedTableRef!.table, column));
            }

            // PRZYPADEK 1B: Kursor stoi w wolnym miejscu (np. `WHERE |`)
            const result: vscode.CompletionItem[] = [];

            // wyciągamy filtr
            const words = linePrefix.trim().split(/[\s,=+]+/);
            const lastWord = words[words.length - 1].toLowerCase();
            const filter = ['where', 'on', 'and', 'or'].includes(lastWord) ? '' : lastWord;

            // pobieramy kolumny (rozgrzewając cache dla całego zapytania), ale wyświetlamy tylko tabele w zasięgu widoczności kursora
            if (allTableRefs.length > 0) {
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(allTableRefsForPrefetch);
                for (const ref of allTableRefs) {
                    const cacheKey = this.tableColumnsService.getTableRefKey(ref);
                    const columns = columnsMap[cacheKey] ?? [];
                    for (const column of columns) {
                        result.push(this.createColumnItem(ref.table, column));
                    }
                }
            }

            if (filter) {
                return result.filter(item => item.label.toString().toLowerCase().includes(filter));
            }

            return result;
        }

        // 2. Obsługa klauzuli DELETE / FROM (Podpowiedzi TABEL i SCHEMATÓW przed klauzulą WHERE)

        // USE INDEX / FORCE INDEX / IGNORE INDEX - tuż po nazwie tabeli i opcjonalnym aliasie w klauzuli FROM (pierwsza tabela, po JOIN albo po przecinku), tylko dla wielotabelowego DELETE; sprawdzane PRZED przypadkami A/B poniżej, bo przypadek B (dopasowujący dowolne ostatnie słowo) inaczej zawsze złapałby to jako kolejną próbę podpowiedzi tabeli
        if (isMultiTableDelete(fullText)) {
            const deleteIndexHintFilter = sqlBeforeCursor.match(REGEX_FROM_JOIN_INDEX_HINT_KEYWORD)?.[3]
                ?? sqlBeforeCursor.match(REGEX_COMMA_INDEX_HINT_KEYWORD)?.[3];

            if (deleteIndexHintFilter !== undefined) {
                const filter = deleteIndexHintFilter.toLowerCase();
                return INDEX_HINT_KEYWORDS
                    .filter(keyword => !filter || keyword.toLowerCase().startsWith(filter))
                    .map((keyword, order) => this.createIndexHintKeywordItem(keyword, order));
            }
        }

        // przypadek A: kursor po kropce struktury bazy (`DELETE FROM zak_system.|`) – tu kropka zawsze oznacza `schema.tabela`, nigdy alias kolumny
        if (linePrefix.includes('.')) {
            const schemaTableMatch = linePrefix.match(REGEX_DELETE_SCHEMA_TABLE);
            if (schemaTableMatch) {
                const schema = schemaTableMatch[1];
                const filter = schemaTableMatch[2].toLowerCase();

                return db
                    .getTables(schema)
                    .filter(table => table.toLowerCase().includes(filter))
                    .map((table, index) => this.createTableItem(table, index));
            }
        }

        // przypadek B: Kursor bezpośrednio po modyfikatorze lub słowie DELETE / FROM, np. `DELETE FROM |`
        const objectMatch = linePrefix.trimEnd().match(REGEX_DELETE_OBJECT);
        if (objectMatch) {
            const words = linePrefix.trim().split(/\s+/);
            const lastWord = words[words.length - 1].toLowerCase();
            const filter = FORBIDDEN_KEYWORDS.has(lastWord) ? '' : lastWord;

            const result: vscode.CompletionItem[] = [];

            // modyfikatory DELETE (LOW_PRIORITY, QUICK, IGNORE) - tylko dopóki nie pojawiła się jeszcze klauzula FROM
            const modifierContext = getDeleteModifierContext(sqlBeforeCursor);
            if (modifierContext) {
                let order = 0;
                for (const modifier of DELETE_MODIFIERS) {
                    if (modifierContext.used.has(modifier)) { continue; }
                    if (modifierContext.filter && !modifier.toLowerCase().startsWith(modifierContext.filter)) { continue; }
                    result.push(this.createKeywordItem(modifier, order++));
                }
            }

            if (defaultSchema) {
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

        return [];
    }
}
