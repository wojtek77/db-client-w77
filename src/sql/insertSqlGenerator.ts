import * as vscode from 'vscode';
import { formatSqlValue } from './formatSqlValue.js';

/** pojedyncza opcja modyfikująca generowany INSERT - "group" oznacza opcje wzajemnie się wykluczające (zaznaczenie jednej odznacza pozostałe z tej samej grupy) */
export interface InsertGenerationOption {
    id: string;
    label: string;
    detail: string;
    group?: 'priority' | 'conflict' | 'batching';
}

// klucz workspaceState, pod którym zapamiętywany jest ostatni wybór opcji generowania INSERT (per-workspace, przetrwa restart edytora)
const INSERT_GENERATION_OPTIONS_STATE_KEY = 'generateInsertSql.selectedOptions';
// klucz workspaceState, pod którym zapamiętywana jest ostatnio wpisana wartość N dla opcji "Split into batches of N rows"
const INSERT_GENERATION_BATCH_SIZE_STATE_KEY = 'generateInsertSql.batchSize';
// wartość N proponowana przy pierwszym użyciu opcji podziału na paczki, zanim użytkownik wpisze i zapamięta własną
const DEFAULT_INSERT_BATCH_SIZE = 500;

// pełna lista dostępnych opcji, w kolejności wyświetlania w QuickPicku - dodanie kolejnej opcji w przyszłości to jeden wpis tutaj, bez zmian w logice UI
export const INSERT_GENERATION_OPTIONS: InsertGenerationOption[] = [
    { id: 'ignore', label: 'IGNORE', detail: 'Skip rows that would cause an error (e.g. duplicate key) instead of aborting the whole statement', group: 'conflict' },
    { id: 'onDuplicateKeyUpdate', label: 'ON DUPLICATE KEY UPDATE', detail: 'Update the existing row instead of failing when a row already exists', group: 'conflict' },
    { id: 'replaceInto', label: 'REPLACE INTO', detail: 'Delete the existing row and insert the new one instead of failing when a row already exists', group: 'conflict' },
    { id: 'lowPriority', label: 'LOW_PRIORITY', detail: 'Wait until no other clients are reading from the table before inserting', group: 'priority' },
    { id: 'highPriority', label: 'HIGH_PRIORITY', detail: 'Override the effect of the low-priority-updates server setting', group: 'priority' },
    { id: 'delayed', label: 'DELAYED', detail: 'Queue the insert to run in the background (ignored by modern MySQL/MariaDB)', group: 'priority' },
    { id: 'transaction', label: 'Wrap in transaction', detail: 'Wrap the generated statement(s) in START TRANSACTION / COMMIT' },
    { id: 'oneRowPerStatement', label: 'One INSERT per row', detail: 'Generate a separate INSERT statement for each row instead of one statement with multiple VALUES rows', group: 'batching' },
    { id: 'batchSize', label: 'Split into batches of N rows', detail: 'Generate multiple INSERT statements with a fixed number of rows each instead of one statement with all rows', group: 'batching' },
];

// rozstrzyga wzajemną wykluczalność w obrębie grup (priority/conflict/batching): jeśli w grupie jest >1 zaznaczona opcja, zostaje tylko dopiero co dodana
export function resolveInsertOptionGroupSelection(selectedIds: Set<string>, previousSelectedIds: Set<string>): Set<string> {
    const newlyAddedIds = [...selectedIds].filter((id) => !previousSelectedIds.has(id));

    let finalIds = selectedIds;
    for (const group of ['priority', 'conflict', 'batching'] as const) {
        const groupIds = INSERT_GENERATION_OPTIONS.filter((o) => o.group === group).map((o) => o.id);
        const selectedInGroup = groupIds.filter((id) => finalIds.has(id));
        if (selectedInGroup.length <= 1) { continue; }

        const keepId = newlyAddedIds.find((id) => groupIds.includes(id)) ?? selectedInGroup[selectedInGroup.length - 1];
        finalIds = new Set([...finalIds].filter((id) => !groupIds.includes(id) || id === keepId));
    }

    return finalIds;
}

// QuickPick z checkboxami dla opcji generowania INSERT, domyślne zaznaczenie to ostatni zapamiętany wybór z workspaceState, undefined gdy użytkownik anulował (Escape)
export async function pickInsertGenerationOptions(workspaceState: vscode.Memento | undefined): Promise<{ ids: Set<string>; batchSize?: number } | undefined> {
    const remembered = new Set(
        workspaceState?.get<string[]>(INSERT_GENERATION_OPTIONS_STATE_KEY, []) ?? []
    );

    return new Promise<{ ids: Set<string>; batchSize?: number } | undefined>((resolve) => {
        type Item = vscode.QuickPickItem & { optionId?: string };

        const quickPick = vscode.window.createQuickPick<Item>();
        quickPick.canSelectMany = true;
        quickPick.title = 'Generate INSERT';
        quickPick.placeholder = 'Select modifiers for the generated statement (optional)';
        quickPick.ignoreFocusOut = true;

        // budujemy listę z separatorami przed każdą grupą, żeby wzajemnie wykluczające się opcje były wizualnie odseparowane od reszty
        const items: Item[] = [];
        let lastGroup: InsertGenerationOption['group'] | 'none' = 'none';
        for (const opt of INSERT_GENERATION_OPTIONS) {
            const currentGroup = opt.group ?? 'none';
            if (currentGroup !== lastGroup) {
                const groupLabel = opt.group === 'priority' ? 'Priority (choose one)' : opt.group === 'conflict' ? 'Conflict handling (choose one)' : opt.group === 'batching' ? 'Batching (choose one)' : 'Other';
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
            const finalIds = resolveInsertOptionGroupSelection(selectedIds, previousSelectedIds);

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
                const rememberedBatchSize = workspaceState?.get<number>(INSERT_GENERATION_BATCH_SIZE_STATE_KEY, DEFAULT_INSERT_BATCH_SIZE);
                const input = await vscode.window.showInputBox({
                    title: 'Generate INSERT - batch size',
                    prompt: 'Number of rows per INSERT statement',
                    value: String(rememberedBatchSize ?? DEFAULT_INSERT_BATCH_SIZE),
                    validateInput: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? null : 'Enter a positive whole number'),
                });

                // anulowanie input boxu (Escape) nie przerywa całej operacji - po prostu rezygnujemy z podziału na paczki i wracamy do jednego statementu
                if (input === undefined) {
                    chosenIds.delete('batchSize');
                } else {
                    batchSize = Number(input);
                    workspaceState?.update(INSERT_GENERATION_BATCH_SIZE_STATE_KEY, batchSize);
                }
            }

            workspaceState?.update(INSERT_GENERATION_OPTIONS_STATE_KEY, [...chosenIds]);
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

// opcja, którą użytkownik zaznaczył, ale która zostanie pominięta w wygenerowanym SQL z powodu konfliktu z inną zaznaczoną opcją
export interface DroppedInsertOption {
    id: string;
    label: string;
    reason: string;
}

// zwraca zaznaczone opcje, które faktycznie zostaną pominięte przy budowaniu SQL - do pokazania ostrzeżenia użytkownikowi, nie używane przy samym budowaniu SQL
export function getDroppedInsertOptions(selectedOptions: Set<string>): DroppedInsertOption[] {
    if (!selectedOptions.has('replaceInto')) { return []; }

    const labelOf = (id: string) => INSERT_GENERATION_OPTIONS.find((o) => o.id === id)?.label ?? id;
    const conflicting: { id: string; reason: string }[] = [
        { id: 'highPriority', reason: 'not supported by REPLACE INTO' },
        { id: 'ignore', reason: 'has no effect with REPLACE INTO' },
        { id: 'onDuplicateKeyUpdate', reason: 'has no effect with REPLACE INTO' },
    ];

    return conflicting
        .filter((c) => selectedOptions.has(c.id))
        .map((c) => ({ id: c.id, label: labelOf(c.id), reason: c.reason }));
}

// buduje przedrostek statementu wg składni MariaDB/MySQL: INSERT|REPLACE [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] INTO - modyfikatory MUSZĄ być między słowem kluczowym a INTO, nigdy po INTO
export function buildInsertStatementPrefix(selectedOptions: Set<string>): string {
    const isReplace = selectedOptions.has('replaceInto');
    const keyword = isReplace ? 'REPLACE' : 'INSERT';

    const modifiers: string[] = [];
    if (selectedOptions.has('lowPriority')) { modifiers.push('LOW_PRIORITY'); }
    if (selectedOptions.has('delayed')) { modifiers.push('DELAYED'); }
    // HIGH_PRIORITY nie jest obsługiwane przez REPLACE (tylko przez INSERT), więc przy REPLACE INTO je pomijamy
    if (selectedOptions.has('highPriority') && !isReplace) { modifiers.push('HIGH_PRIORITY'); }
    // IGNORE ma sens tylko przy INSERT - REPLACE i tak nadpisuje konflikt, więc IGNORE byłby tu bez znaczenia
    if (selectedOptions.has('ignore') && !isReplace) { modifiers.push('IGNORE'); }

    return [keyword, ...modifiers, 'INTO'].join(' ');
}

// buduje pełny SQL dla INSERT/REPLACE na podstawie wybranych opcji - czysta funkcja (bez I/O), żeby dało się ją testować bez UI i bez połączenia z bazą
export function buildInsertSql(
    rows: any[][],
    columns: { index: number; name: string; field: any }[],
    primaryKeys: { index: number; name: string; field: any }[],
    qualifiedTable: string,
    selectedOptions: Set<string>,
    batchSize?: number
): string {
    const columnNames = columns.map((c) => `\`${c.name}\``).join(', ');

    const valuesLines = rows.map((row) => {
        const values = columns.map((c) => formatSqlValue(row[c.index], c.field));
        return `(${values.join(', ')})`;
    });

    const prefix = buildInsertStatementPrefix(selectedOptions);

    // ON DUPLICATE KEY UPDATE aktualizuje wszystkie kolumny spoza klucza głównego wartością z bieżącego wiersza (funkcja VALUES()) - bez sensu razem z REPLACE INTO, który i tak nadpisuje cały wiersz
    let onDuplicateClause = '';
    if (selectedOptions.has('onDuplicateKeyUpdate') && !selectedOptions.has('replaceInto')) {
        const pkIndexSet = new Set(primaryKeys.map((pk) => pk.index));
        const updateColumns = columns.filter((c) => !pkIndexSet.has(c.index));
        if (updateColumns.length > 0) {
            const updateParts = updateColumns.map((c) => `\`${c.name}\` = VALUES(\`${c.name}\`)`);
            onDuplicateClause = `\nON DUPLICATE KEY UPDATE ${updateParts.join(', ')}`;
        }
    }

    // dzielimy wiersze na grupy zależnie od wybranej opcji: pojedynczy wiersz na statement, paczki po N wierszy, albo jedna grupa ze wszystkimi wierszami (domyślnie)
    let valuesGroups: string[][];
    if (selectedOptions.has('oneRowPerStatement')) {
        valuesGroups = valuesLines.map((line) => [line]);
    } else if (selectedOptions.has('batchSize') && batchSize) {
        valuesGroups = [];
        for (let i = 0; i < valuesLines.length; i += batchSize) {
            valuesGroups.push(valuesLines.slice(i, i + batchSize));
        }
    } else {
        valuesGroups = [valuesLines];
    }

    const statements = valuesGroups.map((group) => `${prefix} ${qualifiedTable} (${columnNames})\nVALUES\n${group.join(',\n')}${onDuplicateClause};`);

    let sql = statements.join('\n') + '\n';
    if (selectedOptions.has('transaction')) {
        sql = `START TRANSACTION;\n${sql}COMMIT;\n`;
    }

    return sql;
}
