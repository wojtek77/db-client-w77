export function findCurrentQuery(text: string, cursorOffset: number): string {
    const lines = text.split('\n');
    
    let lineNumber = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (cursorOffset <= charCount + lines[i].length + 1) {
            lineNumber = i;
            break;
        }
        charCount += lines[i].length + 1;
    }
    
    let startLine = lineNumber;
    for (let i = lineNumber; i >= 0; i--) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine === '' || trimmedLine.endsWith(';')) {
            startLine = i + 1;
            break;
        }
        if (i === 0) startLine = 0;
    }
    
    let endLine = lineNumber;
    for (let i = lineNumber; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine === '') {
            endLine = i - 1;
            break;
        }
        if (trimmedLine.endsWith(';')) {
            endLine = i;
            break;
        }
        if (i === lines.length - 1) endLine = i;
    }
    
    let queryLines = lines.slice(startLine, endLine + 1);
    
    while (queryLines.length > 0 && queryLines[0].trim() === '') {
        queryLines.shift();
    }
    while (queryLines.length > 0 && queryLines[queryLines.length - 1].trim() === '') {
        queryLines.pop();
    }
    
    let query = queryLines.join('\n').trim();
    if (query.endsWith(';')) {
        query = query.slice(0, -1).trim();
    }
    
    return query;
}
