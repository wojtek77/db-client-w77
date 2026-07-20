import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REGEX_TILDE_PATH =
    /^~($|\/|\\)/;

const REGEX_LINE_ENDINGS =
    /\r?\n/;

const REGEX_SURROUNDING_QUOTES =
    /^["']|["']$/g;

// tylko te opcje [client] są bezpiecznie konwertowane na number – hasło/użytkownik/host/baza muszą zostać stringiem (np. hasło '001234' bez wiodących zer)
const NUMERIC_OPTION_KEYS = new Set([
    'port',
    'connect-timeout',
    'connect_timeout',
    'connection-timeout',
    'max-allowed-packet',
    'connection-limit',
    'connectionLimit',
    'connect-retry-count',
    'connect-retry-interval',
]);

// tylko te opcje [client] są bezpiecznie konwertowane na typ boolean
const BOOLEAN_OPTION_KEYS = new Set([
    'compress',
    'reconnect',
    'ssl-verify-server-cert',
    'multi-statements',
    'local-infile',
]);

// niestandardowe opcje żyją w [db-client], nie w [client] – klient mysql/mariadb wywala się na nieznanej zmiennej w [client], ale nieznane sekcje ignoruje
const DB_CLIENT_BOOLEAN_KEYS = new Set([
    'production',
    'readonly',
]);

export class CnfLoader {

    /**
     * Zgodnie z prawdziwą składnią plików opcji MySQL/MariaDB: "#" może zaczynać
     * komentarz w dowolnym miejscu linii (nie tylko na początku), np.
     * `database=  # nazwa bazy` -> pusta wartość + komentarz. Cudzysłów chroni
     * dosłowny znak "#" wewnątrz wartości, np. `password="my#pass"`.
     * https://dev.mysql.com/doc/refman/8.4/en/option-files.html
     */
    private static stripInlineComment(rawValue: string): string {
        const trimmed = rawValue.trim();
        if (trimmed.startsWith('"') || trimmed.startsWith('\'')) {
            const quote = trimmed[0];
            const closeIdx = trimmed.indexOf(quote, 1);
            if (closeIdx !== -1) {
                // to, co jest po zamykającym cudzysłowie (spacja + ewentualny '# ...') to komentarz – odrzucamy, zostaje sama zacytowana wartość
                return trimmed.slice(0, closeIdx + 1);
            }
            return trimmed;
        }

        const hashIdx = trimmed.indexOf('#');
        if (hashIdx !== -1) {
            return trimmed.slice(0, hashIdx).trimEnd();
        }
        return trimmed;
    }

    public static async getOptionsFromCnf(filePath: string): Promise<any> {
        const cnfArr = await this._optionsFromCnfRec(filePath);
        const cnf = Object.fromEntries(cnfArr);
        return cnf;
    }

    private static async _optionsFromCnfRec(filePath: string): Promise<[string, string | boolean | number][]> {
        // 1. Rozwinięcie ścieżki tyldy (~) do katalogu domowego użytkownika
        const absolutePath = filePath.replace(REGEX_TILDE_PATH, `${os.homedir()}$1`);
        
        if (!fs.existsSync(absolutePath)) {
            return [];
        }

        const fileContent = fs.readFileSync(absolutePath, 'utf-8');
        const lines = fileContent.split(REGEX_LINE_ENDINGS);
        
        const options: [string, any][] = [];
        let inClientSection = false;
        let inMysqldSection = false;
        let inDbClientSection = false;
        let tcpKeepaliveTime: number | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // pomijanie pustych linii i komentarzy
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                continue;
            }

            // 4. Obsługa rekurencyjnego !include (działa niezależnie od sekcji)
            if (trimmed.startsWith('!include ')) {
                let includePath = trimmed.replace('!include ', '').trim();
                
                // jeśli ścieżka w !include jest względna, liczona jest od katalogu bieżącego pliku cnf
                if (!includePath.startsWith('~') && !path.isAbsolute(includePath)) {
                    includePath = path.join(path.dirname(absolutePath), includePath);
                }

                // rekurencyjne wywołanie tej samej funkcji i scalenie wyników do listy
                const includedOptions = await this._optionsFromCnfRec(includePath);
                options.push(...includedOptions);
                continue;
            }

            // 2. Wykrywanie sekcji
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                const sectionName = trimmed.slice(1, -1).trim();
                inClientSection = (sectionName === 'client');
                inMysqldSection = (sectionName === 'mysqld');
                inDbClientSection = (sectionName === 'db-client');
                continue;
            }

            // 3b. przetwarzanie parametrów wewnątrz customowej sekcji [db-client] (production/readonly, patrz komentarz przy DB_CLIENT_BOOLEAN_KEYS)
            if (inDbClientSection) {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex !== -1) {
                    const key = trimmed.substring(0, eqIndex).trim();
                    const rawValue = this.stripInlineComment(trimmed.substring(eqIndex + 1)).replace(REGEX_SURROUNDING_QUOTES, '');
                    if (DB_CLIENT_BOOLEAN_KEYS.has(key)) {
                        options.push([key, rawValue.toLowerCase() === 'true']);
                    }
                }
                continue;
            }

            // 3. Przetwarzanie parametrów wewnątrz sekcji [mysqld] dla tcp_keepalive_time
            if (inMysqldSection) {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex !== -1) {
                    const key = trimmed.substring(0, eqIndex).trim();
                    const value = this.stripInlineComment(trimmed.substring(eqIndex + 1));
                    
                    if (key === 'tcp_keepalive_time') {
                        // konwersja na liczbę (sekundy)
                        const numValue = Number(value);
                        if (!isNaN(numValue) && numValue > 0) {
                            tcpKeepaliveTime = numValue;
                        }
                        continue; // Nie przetwarzamy dalej tej linii
                    }
                }
            }

            // 4. Przetwarzanie parametrów wewnątrz sekcji [client]
            if (inClientSection) {
                // podział na klucz i wartość przy pierwszym znaku "="
                const eqIndex = trimmed.indexOf('=');
                let key, value;
                if (eqIndex !== -1) { // to co ma znak równości w linii
                    key = trimmed.substring(0, eqIndex).trim();
                    // '#' może zaczynać komentarz w środku linii (prawdziwa składnia MySQL), np. 'database=  # your database' -> pusta wartość
                    value = this.stripInlineComment(trimmed.substring(eqIndex + 1));
                    // usuwanie cudzysłowów otaczających wartość, jeśli istnieją
                    value = value.replace(REGEX_SURROUNDING_QUOTES, '');
                    
                    // zmiana wartości tylko dla znanych opcji liczbowych/logicznych – hasła, nazwy użytkowników, baz i hosty zawsze zostają stringiem
                    const valueLower = value.toLowerCase();
                    if (NUMERIC_OPTION_KEYS.has(key) && value !== '' && !isNaN(Number(value))) {
                        value = Number(value);
                    } else if (BOOLEAN_OPTION_KEYS.has(key)) {
                        if (valueLower === 'true') {
                            value = true;
                        } else if (valueLower === 'false') {
                            value = false;
                        }
                    }
                } else {
                    // obsługa jeśli nie ma znaku "="
                    key = trimmed;
                    value = '';
                }
                
                // production/readonly nie należą do [client] – pomyłkowy wpis pomijamy, inaczej dałoby mylący wynik ('true' === true to false w JS)
                if (DB_CLIENT_BOOLEAN_KEYS.has(key)) {
                    continue;
                }

                // zamiana kluczy
                switch (key) {
                    case 'skip-ssl': {
                        // wartość jeszcze nie była konwertowana wyżej (skip-ssl nie jest na białej liście), więc porównujemy oryginalny string
                        const rawValue = String(value).toLowerCase();
                        const skipSsl = (rawValue === 'true' || rawValue === '');
                        key = 'ssl';
                        value = !skipSsl;
                        break;
                    }
                    
                    case 'compress':
                    case 'reconnect':
                        if (value === '') {
                            value = false;
                        }
                        break;
                    
                    case 'socket':
                        key = 'socketPath';
                        break;
                }
                
                options.push([key, value]);
            }
        }

        // po przetworzeniu całego pliku, jeśli znaleziono tcp_keepalive_time, dodajemy keepAliveDelay
        if (tcpKeepaliveTime !== null && tcpKeepaliveTime > 0) {
            options.push(['keepAliveDelay', tcpKeepaliveTime * 1000]);
        }

        return options;
    }
}
