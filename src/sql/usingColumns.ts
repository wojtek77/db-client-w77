import { tokenize, Token } from './tokenizer.js';
import { isOpenToken } from './expressionPosition.js';

// kursor wewnątrz nawiasu USING (...) w złączeniu
export interface UsingColumnContext {
    // aktualnie pisany fragment nazwy kolumny małymi literami (puste, gdy kursor stoi tuż po nawiasie albo przecinku)
    filter: string;
    // kolumny już wpisane wcześniej w tym nawiasie, małymi literami - nie proponujemy ich ponownie
    used: Set<string>;
}

// nazwa kolumny w backtickach, np. `order`, zwraca samą nazwę
function unquote(token: Token): string | null {
    if (token.type !== 'string' || token.value.length < 3 || !token.value.startsWith('`') || !token.value.endsWith('`')) { return null; }
    return token.value.slice(1, -1);
}

// wykrywa, czy kursor stoi na miejscu nazwy kolumny w nawiasie po słowie USING, np. "JOIN b USING (id, |"
// zwraca null w każdym innym miejscu (inny nawias, po nazwie kolumny bez przecinka, w stringu, w komentarzu itd.)
export function detectUsingColumnList(sqlBeforeCursor: string): UsingColumnContext | null {
    const all = tokenize(sqlBeforeCursor);
    const lastToken = all[all.length - 1];
    // niedomknięty backtick jest pisaną nazwą kolumny, każdy inny otwarty string albo komentarz wyklucza podpowiedzi
    const openBacktick = lastToken && lastToken.type === 'string' && lastToken.value.startsWith('`') && isOpenToken(lastToken, sqlBeforeCursor);
    if (lastToken && !openBacktick && isOpenToken(lastToken, sqlBeforeCursor)) { return null; }

    // najbardziej wewnętrzny niedomknięty nawias
    const stack: number[] = [];
    for (let i = 0; i < all.length; i++) {
        if (all[i].type === 'lparen') { stack.push(i); }
        else if (all[i].type === 'rparen') { stack.pop(); }
    }
    if (stack.length === 0) { return null; }
    const openIndex = stack[stack.length - 1];

    // nawias musi stać bezpośrednio po słowie USING
    const before = all.slice(0, openIndex).filter(t => t.type !== 'comment');
    const prev = before[before.length - 1];
    if (!prev || prev.type !== 'word' || prev.value.toUpperCase() !== 'USING') { return null; }

    // zawartość nawiasu to naprzemiennie nazwa kolumny i przecinek
    const content = all.slice(openIndex + 1).filter(t => t.type !== 'comment');
    const used = new Set<string>();
    let filter = '';
    let expectName = true;

    for (let i = 0; i < content.length; i++) {
        const t = content[i];
        if (!expectName) {
            if (t.type !== 'comma') { return null; }
            expectName = true;
            continue;
        }

        const isLast = i === content.length - 1;
        if (isLast && openBacktick && t.type === 'string') { filter = t.value.slice(1).toLowerCase(); break; }
        if (t.type === 'word' && /^\w+$/.test(t.value)) {
            // ostatnie słowo dotykające kursora to pisana nazwa, a nie ukończona kolumna
            if (isLast && t.start + t.value.length === sqlBeforeCursor.length) { filter = t.value.toLowerCase(); break; }
            used.add(t.value.toLowerCase());
            expectName = false;
            continue;
        }
        const quoted = unquote(t);
        if (quoted === null) { return null; }
        used.add(quoted.toLowerCase());
        expectName = false;
    }

    // po ukończonej nazwie bez przecinka kolumny już się nie podpowiada
    if (!expectName) { return null; }
    return { filter, used };
}
