export interface CurrentQuery {
    sql: string;
    startLine: number;
    endLine: number;
}

// dzieli tekst na linie obsługując CRLF (Windows), CR (stary Mac) i LF (Linux/nowy Mac) - bez + w regexie, żeby dwa kolejne końce linii (pusta linia) nie zostały zjedzone jako jeden separator
export function splitLines(text: string): string[] {
    return text.split(/\r\n|\r|\n/);
}

export function findCurrentQuery(
    text: string,
    currentLine: number
): CurrentQuery | null {

    const lines =
        splitLines(text);

    if (
        currentLine < 0 ||
        currentLine >= lines.length ||
        lines[currentLine].trim() === ''
    ) {
        return null;
    }

    let startLine =
        currentLine;

    while (startLine > 0) {

        const previousLine =
            lines[startLine - 1].trim();

        if (
            previousLine === '' ||
            previousLine.endsWith(';')
        ) {
            break;
        }

        startLine--;
    }

    let endLine =
        currentLine;

    while (endLine < lines.length - 1) {

        const current =
            lines[endLine].trim();

        if (current.endsWith(';')) {
            break;
        }

        const nextLine =
            lines[endLine + 1].trim();

        if (nextLine === '') {
            break;
        }

        endLine++;
    }

    return {
        sql: lines
            .slice(
                startLine,
                endLine + 1
            )
            .join('\n')
            // przycinamy tylko wiodące białe znaki – końcowe zostają, bo np. CompletionInsert potrzebuje ich do wykrycia 'ON DUPLICATE KEY UPDATE '
            .trimStart(),
        startLine,
        endLine
    };
}

// zwraca wszystkie zapytania w tekście, pomijając puste linie pomiędzy nimi - wspólna logika dla Run Whole File i formatowania całego pliku/wielu zaznaczonych SQL-i
export function findAllQueries(text: string): CurrentQuery[] {
    const lines = splitLines(text);
    const queries: CurrentQuery[] = [];
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        if (lines[lineIndex].trim() === '') {
            lineIndex++;
            continue;
        }

        const query = findCurrentQuery(text, lineIndex);
        if (!query) {
            lineIndex++;
            continue;
        }

        queries.push(query);
        lineIndex = query.endLine + 1;
    }

    return queries;
}
