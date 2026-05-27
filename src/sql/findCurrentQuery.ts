export function findCurrentQuery(text: string, currentLine: number): string | null {
    const lines = text.split('\n');

    // Pomocnicza funkcja realizująca punkt 2 (definicja "pustej linii")
    // Zwraca true, jeśli indeks wykracza poza dokument lub linia zawiera tylko białe znaki
    const isEmptyOrBoundary = (index: number): boolean => {
        if (index < 0 || index >= lines.length) {
            return true; // Początek lub koniec dokumentu
        }
        return lines[index].trim() === ''; // Linia zupełnie pusta lub tylko z białymi znakami
    };

    // KROK 1: Sprawdzenie linii, w której stoi kursor
    if (isEmptyOrBoundary(currentLine)) {
        return null; // Wychodzimy z funkcji bez znalezionego SQL-a
    }

    // KROK 3: Szukanie początku kodu SQL (idziemy w górę)
    let startLine = currentLine;
    while (!isEmptyOrBoundary(startLine)) {
        startLine--;
    }

    // KROK 4: Korekta po znalezieniu pustej linii / granicy dokumentu
    // Jeśli zatrzymaliśmy się, bo i < 0 (początek dokumentu), to startLine wynosi -1.
    // Wtedy pierwsza linia to 0 (nie zwiększamy). W innym przypadku zwiększamy o 1.
    if (startLine < 0) {
        startLine = 0;
    } else {
        startLine = startLine + 1;
    }

    // KROK 5: Szukanie końca kodu SQL (idziemy w dół od znalezionego początku)
    let endLine = startLine;
    while (!isEmptyOrBoundary(endLine)) {
        endLine++;
    }
    // Cofamy o 1, ponieważ pętla zatrzymała się na pierwszej "pustej linii" za kodem
    endLine = endLine - 1;

    // Wycinamy linie i łączymy je w jeden tekst
    const queryLines = lines.slice(startLine, endLine + 1);
    
    return queryLines.join('\n').trim();
}
