import * as vscode from 'vscode';
import { formatSqlValue } from './formatSqlValue.js';

/** pojedyncza opcja modyfikująca generowany UPDATE - "group" oznacza opcje wzajemnie się wykluczające (zaznaczenie jednej odznacza pozostałe z tej samej grupy) */
export interface UpdateGenerationOption {
    id: string;
    label: string;
    detail: string;
    group?: 'batching';
}

// klucz globalState, pod którym zapamiętywany jest ostatni wybór opcji generowania UPDATE (globalnie w edytorze, przetrwa restart)
const UPDATE_GENERATION_OPTIONS_STATE_KEY = 'generateUpdateSql.selectedOptions';
// klucz globalState, pod którym zapamiętywana jest ostatnio wpisana wartość N dla opcji "Split into batches of N rows"
const UPDATE_GENERATION_BATCH_SIZE_STATE_KEY = 'generateUpdateSql.batchSize';
// wartość N proponowana przy pierwszym użyciu opcji podziału na paczki, zanim użytkownik wpisze i zapamięta własną
const DEFAULT_UPDATE_BATCH_SIZE = 500;

// pełna lista dostępnych opcji, w kolejności wyświetlania w QuickPicku - dodanie kolejnej opcji w przyszłości to jeden wpis tutaj, bez zmian w logice UI
export const UPDATE_GENERATION_OPTIONS: UpdateGenerationOption[] = [
    { id: 'lowPriority', label: 'LOW_PRIORITY', detail: 'Wait until no other clients are reading from the table before updating' },
    { id: 'ignore', label: 'IGNORE', detail: 'Skip rows that would cause an error (e.g. duplicate key) instead of aborting the whole statement' },
    { id: 'transaction', label: 'Wrap in transaction', detail: 'Wrap the generated statement(s) in START TRANSACTION / COMMIT' },
    { id: 'caseWhenSingleStatement', label: 'Combine into single UPDATE using CASE WHEN', detail: 'Generate one UPDATE statement for all rows instead of one statement per row (single-column primary key only)', group: 'batching' },
    { id: 'batchSize', label: 'Split into batches of N rows (CASE WHEN)', detail: 'Generate multiple CASE WHEN UPDATE statements with a fixed number of rows each instead of one statement per row (single-column primary key only)', group: 'batching' },
];

// rozstrzyga wzajemną wykluczalność w obrębie grupy "batching": jeśli zaznaczono >1 opcję, zostaje tylko dopiero co dodana
export function resolveUpdateOptionGroupSelection(selectedIds: Set<string>, previousSelectedIds: Set<string>): Set<string> {
    const newlyAddedIds = [...selectedIds].filter((id) => !previousSelectedIds.has(id));

    let finalIds = selectedIds;
    for (const group of ['batching'] as const) {
        const groupIds = UPDATE_GENERATION_OPTIONS.filter((o) => o.group === group).map((o) => o.id);
        const selectedInGroup = groupIds.filter((id) => finalIds.has(id));
        if (selectedInGroup.length <= 1) { continue; }

        const keepId = newlyAddedIds.find((id) => groupIds.includes(id)) ?? selectedInGroup[selectedInGroup.length - 1];
        finalIds = new Set([...finalIds].filter((id) => !groupIds.includes(id) || id === keepId));
    }

    return finalIds;
}

// QuickPick z checkboxami dla opcji generowania UPDATE, domyślne zaznaczenie to ostatni zapamiętany wybór z globalState, undefined gdy użytkownik anulował (Escape)
export async function pickUpdateGenerationOptions(globalState: vscode.Memento | undefined): Promise<{ ids: Set<string>; batchSize?: number } | undefined> {
    const remembered = new Set(
        globalState?.get<string[]>(UPDATE_GENERATION_OPTIONS_STATE_KEY, []) ?? []
    );

    return new Promise<{ ids: Set<string>; batchSize?: number } | undefined>((resolve) => {
        type Item = vscode.QuickPickItem & { optionId?: string };

        const quickPick = vscode.window.createQuickPick<Item>();
        quickPick.canSelectMany = true;
        quickPick.title = 'Generate UPDATE';
        quickPick.placeholder = 'Select modifiers for the generated statement (optional)';
        quickPick.ignoreFocusOut = true;

        // budujemy listę z separatorem przed grupą "batching", żeby wzajemnie wykluczające się opcje były wizualnie odseparowane od reszty
        const items: Item[] = [];
        let lastGroup: UpdateGenerationOption['group'] | 'none' = 'none';
        for (const opt of UPDATE_GENERATION_OPTIONS) {
            const currentGroup = opt.group ?? 'none';
            if (currentGroup !== lastGroup) {
                const groupLabel = opt.group === 'batching' ? 'Batching (choose one)' : 'Other';
                items.push({ label: groupLabel, kind: vscode.QuickPickItemKind.Separator });
                lastGroup = currentGroup;
            }
            items.push({ label: opt.label, detail: opt.detail, optionId: opt.id });
        }

        quickPick.items = items;
        quickPick.selectedItems = items.filter((i) => i.optionId && remembered.has(i.optionId));

        // śledzimy poprzedni stan zaznaczenia, żeby przy konflikcie w grupie rozpoznać, która pozycja jest nowo dodana (tę zostawiamy, resztę z grupy odznaczamy)
        let previousSelectedIds = new Set(quickPick.selectedItems.map((i) => i.optionId).filter(Boolean) as string[]);

        quickPick.onDidChangeSelection((selection) => {
            const selectedIds = new Set(selection.map((i) => i.optionId).filter(Boolean) as string[]);
            const finalIds = resolveUpdateOptionGroupSelection(selectedIds, previousSelectedIds);

            previousSelectedIds = finalIds;
            quickPick.selectedItems = items.filter((i) => i.optionId && finalIds.has(i.optionId));
        });

        // flaga chroniąca przed wyścigiem: pokazanie inputboxa na batch size ukrywa quickpick i odpala onDidHide, które bez tej flagi anulowałoby cały wynik jako "undefined"
        let resolved = false;

        quickPick.onDidAccept(async () => {
            resolved = true;
            const chosenIds = new Set(quickPick.selectedItems.map((i) => i.optionId).filter(Boolean) as string[]);

            // opcja "batchSize" wymaga dodatkowo liczby N - dopytujemy osobnym input boxem, z podpowiedzią ostatnio użytej wartości
            let batchSize: number | undefined;
            if (chosenIds.has('batchSize')) {
                const rememberedBatchSize = globalState?.get<number>(UPDATE_GENERATION_BATCH_SIZE_STATE_KEY, DEFAULT_UPDATE_BATCH_SIZE);
                const input = await vscode.window.showInputBox({
                    title: 'Generate UPDATE - batch size',
                    prompt: 'Number of rows per UPDATE statement',
                    value: String(rememberedBatchSize ?? DEFAULT_UPDATE_BATCH_SIZE),
                    validateInput: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? null : 'Enter a positive whole number'),
                });

                // anulowanie input boxu (Escape) nie przerywa całej operacji - po prostu rezygnujemy z podziału na paczki i wracamy do jednego statementu na wiersz
                if (input === undefined) {
                    chosenIds.delete('batchSize');
                } else {
                    batchSize = Number(input);
                    globalState?.update(UPDATE_GENERATION_BATCH_SIZE_STATE_KEY, batchSize);
                }
            }

            globalState?.update(UPDATE_GENERATION_OPTIONS_STATE_KEY, [...chosenIds]);
            quickPick.dispose();
            resolve({ ids: chosenIds, batchSize });
        });

        quickPick.onDidHide(() => {
            if (resolved) { return; } // quickpick już zaakceptowany, to zdarzenie to tylko efekt uboczny otwarcia inputboxa albo dispose() - nie anulujemy wyniku
            quickPick.dispose();
            resolve(undefined);
        });

        quickPick.show();
    });
}

// opcja, którą użytkownik zaznaczył, ale która zostanie pominięta w wygenerowanym SQL z powodu konfliktu z innym stanem (np. złożonym kluczem głównym)
export interface DroppedUpdateOption {
    id: string;
    label: string;
    reason: string;
}

// zwraca zaznaczone opcje, które faktycznie zostaną pominięte przy budowaniu SQL - do pokazania ostrzeżenia użytkownikowi, nie używane przy samym budowaniu SQL
export function getDroppedUpdateOptions(selectedOptions: Set<string>, primaryKeys: { index: number; name: string; field: any }[]): DroppedUpdateOption[] {
    if (primaryKeys.length <= 1) { return []; }

    const labelOf = (id: string) => UPDATE_GENERATION_OPTIONS.find((o) => o.id === id)?.label ?? id;
    // CASE WHEN grupuje wiersze po wartości jednej kolumny PK w WHERE ... IN (...) - przy złożonym kluczu nie da się tego bezpiecznie zrobić bez zagnieżdżania warunków AND, więc wracamy do jednego UPDATE na wiersz
    return ['caseWhenSingleStatement', 'batchSize']
        .filter((id) => selectedOptions.has(id))
        .map((id) => ({ id, label: labelOf(id), reason: 'requires a single-column primary key' }));
}

// buduje przedrostek statementu wg składni MariaDB/MySQL: UPDATE [LOW_PRIORITY] [IGNORE] - modyfikatory MUSZĄ być między słowem kluczowym a nazwą tabeli
export function buildUpdateStatementPrefix(selectedOptions: Set<string>): string {
    const modifiers: string[] = [];
    if (selectedOptions.has('lowPriority')) { modifiers.push('LOW_PRIORITY'); }
    if (selectedOptions.has('ignore')) { modifiers.push('IGNORE'); }

    return ['UPDATE', ...modifiers].join(' ');
}

// buduje jeden statement UPDATE na wiersz (domyślne zachowanie, zawsze poprawne niezależnie od liczby kolumn PK)
function buildOneStatementPerRow(
    rows: any[][],
    setColumns: { index: number; name: string; field: any }[],
    primaryKeys: { index: number; name: string; field: any }[],
    qualifiedTable: string,
    prefix: string
): string[] {
    return rows.map((row) => {
        const setParts = setColumns.map((c) => `\`${c.name}\` = ${formatSqlValue(row[c.index], c.field)}`);
        const whereParts = primaryKeys.map((pk) => `\`${pk.name}\` = ${formatSqlValue(row[pk.index], pk.field)}`);

        return `${prefix} ${qualifiedTable}\nSET ${setParts.join(', ')}\nWHERE ${whereParts.join(' AND ')};`;
    });
}

// buduje jeden statement UPDATE dla grupy wierszy, aktualizując każdą kolumnę przez CASE `pk` WHEN ... THEN ... END, z WHERE `pk` IN (...) ograniczającym zasięg
function buildCaseWhenStatement(
    rowsGroup: any[][],
    setColumns: { index: number; name: string; field: any }[],
    pk: { index: number; name: string; field: any },
    qualifiedTable: string,
    prefix: string
): string {
    const setParts = setColumns.map((c) => {
        const whens = rowsGroup
            .map((row) => `        WHEN ${formatSqlValue(row[pk.index], pk.field)} THEN ${formatSqlValue(row[c.index], c.field)}`)
            .join('\n');
        return `\`${c.name}\` = CASE \`${pk.name}\`\n${whens}\n    END`;
    });

    const pkValues = rowsGroup.map((row) => formatSqlValue(row[pk.index], pk.field));

    return `${prefix} ${qualifiedTable}\nSET ${setParts.join(',\n')}\nWHERE \`${pk.name}\` IN (${pkValues.join(', ')});`;
}

// buduje pełny SQL dla UPDATE na podstawie wybranych opcji - czysta funkcja (bez I/O), żeby dało się ją testować bez UI i bez połączenia z bazą
export function buildUpdateSql(
    rows: any[][],
    columns: { index: number; name: string; field: any }[],
    primaryKeys: { index: number; name: string; field: any }[],
    qualifiedTable: string,
    selectedOptions: Set<string>,
    batchSize?: number
): string {
    const pkIndexSet = new Set(primaryKeys.map((pk) => pk.index));
    const setColumns = columns.filter((c) => !pkIndexSet.has(c.index));
    const prefix = buildUpdateStatementPrefix(selectedOptions);

    // CASE WHEN wymaga dokładnie jednej kolumny PK do grupowania w WHERE ... IN (...) - przy złożonym kluczu zawsze wracamy do jednego UPDATE na wiersz
    const canUseCaseWhen = primaryKeys.length === 1;

    let statements: string[];
    if (canUseCaseWhen && selectedOptions.has('caseWhenSingleStatement')) {
        statements = [buildCaseWhenStatement(rows, setColumns, primaryKeys[0], qualifiedTable, prefix)];
    } else if (canUseCaseWhen && selectedOptions.has('batchSize') && batchSize) {
        statements = [];
        for (let i = 0; i < rows.length; i += batchSize) {
            statements.push(buildCaseWhenStatement(rows.slice(i, i + batchSize), setColumns, primaryKeys[0], qualifiedTable, prefix));
        }
    } else {
        statements = buildOneStatementPerRow(rows, setColumns, primaryKeys, qualifiedTable, prefix);
    }

    let sql = statements.join('\n\n') + '\n';
    if (selectedOptions.has('transaction')) {
        sql = `START TRANSACTION;\n${sql}COMMIT;\n`;
    }

    return sql;
}
