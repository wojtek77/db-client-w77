/**
 * Zwraca wersję `sql` o tej samej długości, w której zawartość literałów
 * tekstowych ('...', "...", `...`) jest zamieniona na spacje.
 * Znaki otwierające/zamykające cudzysłów pozostają na swoim miejscu.
 *
 * Dzięki temu kod liczący nawiasy `(` `)` (np. przy dzieleniu kolumn SELECT
 * albo wykrywaniu klauzul na poziomie głównym) nie musi nic wiedzieć
 * o stringach — wystarczy, że liczy nawiasy na zamaskowanej wersji tekstu,
 * a oryginalne fragmenty wycina z `sql` po tych samych indeksach.
 */
export function maskStringLiterals(sql: string): string {
    let out = '';
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];

        if (inString) {
            out += ch === stringChar ? ch : ' ';
            if (ch === stringChar) { inString = false; }
            continue;
        }

        if (ch === '\'' || ch === '"' || ch === '`') {
            inString = true;
            stringChar = ch;
            out += ch;
        } else {
            out += ch;
        }
    }

    return out;
}
