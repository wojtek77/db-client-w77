// wspólna logika łączenia kolumn PRIMARY KEY (i ogólnie kolumn tabeli) z ich pozycją w wynikach zapytania SELECT
// używane zarówno przy edycji pojedynczej komórki, bezpośrednim kasowaniu wierszy, jak i przy generowaniu SQL INSERT/UPDATE/DELETE,
// żeby te miejsca nie mogły się rozjechać w kwestii tego, jak znajdują "swoje" kolumny w this._meta

export interface MetaFieldLike {
    orgTable?: () => string | undefined;
    orgName?: () => string | undefined;
    [key: string]: any;
}

export interface ResolvedColumnRef {
    index: number;
    name: string;
    field: any;
}

export interface ResolvePrimaryKeyColumnsResult {
    found: ResolvedColumnRef[];
    missingNames: string[];
}

// znajduje w meta pierwszy indeks kolumny należącej do danej tabeli o danej nazwie oryginalnej (orgTable/orgName), pomija ewentualne kolejne duplikaty (np. z SELECT a.id, a.*)
export function findColumnIndex(meta: MetaFieldLike[], tableName: string, columnName: string): number {
    return meta.findIndex((m) => m.orgTable?.() === tableName && m.orgName?.() === columnName);
}

// dla każdej podanej nazwy kolumny PK znajduje jej jedno (pierwsze) wystąpienie w wynikach SELECT, resztę zgłasza jako brakujące
export function resolvePrimaryKeyColumns(
    meta: MetaFieldLike[],
    tableName: string,
    primaryKeyNames: string[]
): ResolvePrimaryKeyColumnsResult {
    const found: ResolvedColumnRef[] = [];
    const missingNames: string[] = [];

    for (const name of primaryKeyNames) {
        const index = findColumnIndex(meta, tableName, name);
        if (index === -1) {
            missingNames.push(name);
        } else {
            found.push({ index, name, field: meta[index] });
        }
    }

    return { found, missingNames };
}

// zwraca kolumny danej tabeli widoczne w wynikach SELECT, każda nazwa tylko raz (wygrywa pierwsze wystąpienie) - zabezpiecza przed duplikatami np. przy SELECT a.id, a.name, a.*
export function resolveTableColumns(meta: MetaFieldLike[], tableName: string): ResolvedColumnRef[] {
    const seen = new Set<string>();
    const columns: ResolvedColumnRef[] = [];

    meta.forEach((field, index) => {
        const name = field.orgName?.();
        if (!name || field.orgTable?.() !== tableName || seen.has(name)) {
            return;
        }
        seen.add(name);
        columns.push({ index, name, field });
    });

    return columns;
}

// porównuje dwie wartości PK (obsługuje liczby, stringi, null) - do sortowania krotek PK przed wstawieniem do WHERE IN (żeby były czytelne w logach SQL)
export function comparePkValues(a: any, b: any): number {
    if (a === b) {return 0;}
    if (a === null || a === undefined) {return -1;}
    if (b === null || b === undefined) {return 1;}
    if (typeof a === 'number' && typeof b === 'number') {return a - b;}
    if (typeof a === 'bigint' && typeof b === 'bigint') {return a < b ? -1 : (a > b ? 1 : 0);}
    return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// porównuje dwie krotki wartości PK kolumna po kolumnie (obsługuje też PK złożony)
export function comparePkTuples(tupleA: any[], tupleB: any[]): number {
    for (let i = 0; i < tupleA.length; i++) {
        const cmp = comparePkValues(tupleA[i], tupleB[i]);
        if (cmp !== 0) {return cmp;}
    }
    return 0;
}
