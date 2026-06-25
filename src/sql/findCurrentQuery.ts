export interface CurrentQuery {
    sql: string;
    startLine: number;
    endLine: number;
}

export function findCurrentQuery(
    text: string,
    currentLine: number
): CurrentQuery | null {

    const lines =
        text.split('\n');

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
            .trim(),
        startLine,
        endLine
    };
}
