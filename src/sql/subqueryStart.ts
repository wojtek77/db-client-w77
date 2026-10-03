import { tokenize } from './tokenizer.js';
import { isOpenToken } from './expressionPosition.js';

// słowa, po których nawias otwiera podzapytanie (EXISTS (SELECT ...), x IN (SELECT ...), x > ANY (SELECT ...))
const SUBQUERY_INTRO_WORDS = new Set(['EXISTS', 'IN', 'ANY', 'SOME', 'ALL']);

// sprawdza, czy kursor stoi tuż po nawiasie otwierającym podzapytanie (po EXISTS, IN, ANY, SOME albo ALL), gdzie można wpisać SELECT
// ostatnie dotykające kursora słowo to pisany prefiks, więc "EXISTS (SEL" też się liczy, a "EXISTS (SELECT 1 " już nie
export function detectSubqueryStart(sqlBeforeCursor: string): boolean {
    const all = tokenize(sqlBeforeCursor);
    const lastToken = all[all.length - 1];
    if (lastToken && isOpenToken(lastToken, sqlBeforeCursor)) { return false; }

    const tokens = all.filter(t => t.type !== 'comment');
    const tail = tokens[tokens.length - 1];
    if (tail && tail.type === 'word' && tail.start + tail.value.length === sqlBeforeCursor.length) {
        if (!/^\w+$/.test(tail.value)) { return false; }
        tokens.pop();
    }

    const open = tokens[tokens.length - 1];
    const intro = tokens[tokens.length - 2];
    if (!open || open.type !== 'lparen') { return false; }
    return !!intro && intro.type === 'word' && SUBQUERY_INTRO_WORDS.has(intro.value.toUpperCase());
}
