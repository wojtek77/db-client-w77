import * as vscode from 'vscode';
import { formatSqlValue } from './formatSqlValue.js';

/** pojedyncza opcja modyfikująca generowany DELETE - "group" oznacza opcje wzajemnie się wykluczające (zaznaczenie jednej odznacza pozostałe z tej samej grupy) */
export interface DeleteGenerationOption {
    id: string;
    label: string;
    detail: string;
    group?: 'batching';
}

// klucz globalState, pod którym zapamiętywany jest ostatni wybór opcji generowania DELETE (globalnie w edytorze, przetrwa restart)
const DELETE_GENERATION_OPTIONS_STATE_KEY = 'generateDeleteSql.selectedOptions';
// klucz globalState, pod którym zapamiętywana jest ostatnio wpisana wartość N dla opcji "Split into batches of N rows"
const DELETE_GENERATION_BATCH_SIZE_STATE_KEY = 'generateDeleteSql.batchSize';
// wartość N proponowana przy pierwszym użyciu opcji podziału na paczki, zanim użytkownik wpisze i zapamięta własną
const DEFAULT_DELETE_BATCH_SIZE = 500;

// pełna lista dostępnych opcji, w kolejności wyświetlania w QuickPicku - dodanie kolejnej opcji w przyszłości to jeden wpis tutaj, bez zmian w logice UI
export const DELETE_GENERATION_OPTIONS: DeleteGenerationOption[] = [
    { id: 'ignore', label: 'IGNORE', detail: 'Skip rows that would cause an error instead of aborting the whole statement' },
    { id: 'lowPriority', label: 'LOW_PRIORITY', detail: 'Wait until no other clients are reading from the table before deleting' },
    { id: 'quick', label: 'QUICK', detail: 'Skip merging index leaves during the delete (MyISAM), which can speed up the delete but leaves the index less compact' },
    { id: 'transaction', label: 'Wrap in transaction', detail: 'Wrap the generated statement(s) in START TRANSACTION / COMMIT' },
    { id: 'oneRowPerStatement', label: 'One DELETE per row', detail: 'Generate a separate DELETE statement for each row instead of one statement with a WHERE ... IN (...) clause', group: 'batching' },
    { id: 'batchSize', label: 'Split into batches of N rows', detail: 'Generate multiple DELETE statements with a fixed number of rows each instead of one statement with all rows', group: 'batching' },
];

// rozstrzyga wzajemną wykluczalność w obrębie grupy "batching": jeśli zaznaczono >1 opcję, zostaje tylko dopiero co dodana
export function resolveDeleteOptionGroupSelection(selectedIds: Set<string>, previousSelectedIds: Set<string>): Set<string> {
    const newlyAddedIds = [...selectedIds].filter((id) => !previousSelectedIds.has(id));

    let finalIds = selectedIds;
    for (const group of ['batching'] as const) {
        const groupIds = DELETE_GENERATION_OPTIONS.filter((o) => o.group === group).map((o) => o.id);
        const selectedInGroup = groupIds.filter((id) => finalIds.has(id));
        if (selectedInGroup.length <= 1) { continue; }

        const keepId = newlyAddedIds.find((id) => groupIds.includes(id)) ?? selectedInGroup[selectedInGroup.length - 1];
        finalIds = new Set([...finalIds].filter((id) => !groupIds.includes(id) || id === keepId));
    }

    return finalIds;
}

// QuickPick z checkboxami dla opcji generowania DELETE, domyślne zaznaczenie to ostatni zapamiętany wybór z globalState, undefined gdy użytkownik anulował (Escape)
export async function pickDeleteGenerationOptions(globalState: vscode.Memento | undefined): Promise<{ ids: Set<string>; batchSize?: number } | undefined> {
    const remembered = new Set(
        globalState?.get<string[]>(DELETE_GENERATION_OPTIONS_STATE_KEY, []) ?? []
    );

    return new Promise<{ ids: Set<string>; batchSize?: number } | undefined>((resolve) => {
        type Item = vscode.QuickPickItem & { optionId?: string };

        const quickPick = vscode.window.createQuickPick<Item>();
        quickPick.canSelectMany = true;
        quickPick.title = 'Generate DELETE';
        quickPick.placeholder = 'Select modifiers for the generated statement (optional)';
        quickPick.ignoreFocusOut = true;

        // budujemy listę z separatorem przed grupą "batching", żeby wzajemnie wykluczające się opcje były wizualnie odseparowane od reszty
        const items: Item[] = [];
        let lastGroup: DeleteGenerationOption['group'] | 'none' = 'none';
        for (const opt of DELETE_GENERATION_OPTIONS) {
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
            const finalIds = resolveDeleteOptionGroupSelection(selectedIds, previousSelectedIds);

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
                const rememberedBatchSize = globalState?.get<number>(DELETE_GENERATION_BATCH_SIZE_STATE_KEY, DEFAULT_DELETE_BATCH_SIZE);
                const input = await vscode.window.showInputBox({
                    title: 'Generate DELETE - batch size',
                    prompt: 'Number of rows per DELETE statement',
                    value: String(rememberedBatchSize ?? DEFAULT_DELETE_BATCH_SIZE),
                    validateInput: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? null : 'Enter a positive whole number'),
                });

                // anulowanie input boxu (Escape) nie przerywa całej operacji - po prostu rezygnujemy z podziału na paczki i wracamy do jednego statementu
                if (input === undefined) {
                    chosenIds.delete('batchSize');
                } else {
                    batchSize = Number(input);
                    globalState?.update(DELETE_GENERATION_BATCH_SIZE_STATE_KEY, batchSize);
                }
            }

            globalState?.update(DELETE_GENERATION_OPTIONS_STATE_KEY, [...chosenIds]);
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

// buduje przedrostek statementu wg składni MariaDB/MySQL: DELETE [LOW_PRIORITY] [QUICK] [IGNORE] - modyfikatory MUSZĄ być między słowem kluczowym a FROM
export function buildDeleteStatementPrefix(selectedOptions: Set<string>): string {
    const modifiers: string[] = [];
    if (selectedOptions.has('lowPriority')) { modifiers.push('LOW_PRIORITY'); }
    if (selectedOptions.has('quick')) { modifiers.push('QUICK'); }
    if (selectedOptions.has('ignore')) { modifiers.push('IGNORE'); }

    return ['DELETE', ...modifiers, 'FROM'].join(' ');
}

// buduje jeden statement DELETE dla grupy wierszy - klucz jednokolumnowy trafia do WHERE pk IN (...), złożony do WHERE (pk1, pk2) IN ((...), (...))
function buildDeleteStatementForGroup(
    rowsGroup: any[][],
    primaryKeys: { index: number; name: string; field: any }[],
    qualifiedTable: string,
    prefix: string
): string {
    if (primaryKeys.length === 1) {
        const pk = primaryKeys[0];
        const values = rowsGroup.map((row) => formatSqlValue(row[pk.index], pk.field));
        return `${prefix} ${qualifiedTable}\nWHERE \`${pk.name}\` IN (${values.join(', ')});`;
    }

    const pkColumnNames = primaryKeys.map((pk) => `\`${pk.name}\``);
    const tuples = rowsGroup.map((row) => {
        const values = primaryKeys.map((pk) => formatSqlValue(row[pk.index], pk.field));
        return `(${values.join(', ')})`;
    });
    return `${prefix} ${qualifiedTable}\nWHERE (${pkColumnNames.join(', ')}) IN (${tuples.join(', ')});`;
}

// buduje pełny SQL dla DELETE na podstawie wybranych opcji - czysta funkcja (bez I/O), żeby dało się ją testować bez UI i bez połączenia z bazą
export function buildDeleteSql(
    rows: any[][],
    primaryKeys: { index: number; name: string; field: any }[],
    qualifiedTable: string,
    selectedOptions: Set<string>,
    batchSize?: number
): string {
    const prefix = buildDeleteStatementPrefix(selectedOptions);

    // dzielimy wiersze na grupy zależnie od wybranej opcji: pojedynczy wiersz na statement, paczki po N wierszy, albo jedna grupa ze wszystkimi wierszami (domyślnie)
    let rowGroups: any[][][];
    if (selectedOptions.has('oneRowPerStatement')) {
        rowGroups = rows.map((row) => [row]);
    } else if (selectedOptions.has('batchSize') && batchSize) {
        rowGroups = [];
        for (let i = 0; i < rows.length; i += batchSize) {
            rowGroups.push(rows.slice(i, i + batchSize));
        }
    } else {
        rowGroups = [rows];
    }

    const statements = rowGroups.map((group) => buildDeleteStatementForGroup(group, primaryKeys, qualifiedTable, prefix));

    let sql = statements.join('\n') + '\n';
    if (selectedOptions.has('transaction')) {
        sql = `START TRANSACTION;\n${sql}COMMIT;\n`;
    }

    return sql;
}
