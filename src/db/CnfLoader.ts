import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REGEX_TILDE_PATH =
    /^~($|\/|\\)/;

const REGEX_LINE_ENDINGS =
    /\r?\n/;

const REGEX_SURROUNDING_QUOTES =
    /^["']|["']$/g;

export class CnfLoader {

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
        let tcpKeepaliveTime: number | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // Pomijanie pustych linii i komentarzy
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                continue;
            }

            // 4. Obsługa rekurencyjnego !include (działa niezależnie od sekcji)
            if (trimmed.startsWith('!include ')) {
                let includePath = trimmed.replace('!include ', '').trim();
                
                // Jeśli ścieżka w !include jest względna, liczona jest od katalogu bieżącego pliku cnf
                if (!includePath.startsWith('~') && !path.isAbsolute(includePath)) {
                    includePath = path.join(path.dirname(absolutePath), includePath);
                }

                // Rekurencyjne wywołanie tej samej funkcji i scalenie wyników do listy
                const includedOptions = await this._optionsFromCnfRec(includePath);
                options.push(...includedOptions);
                continue;
            }

            // 2. Wykrywanie sekcji
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                const sectionName = trimmed.slice(1, -1).trim();
                inClientSection = (sectionName === 'client');
                inMysqldSection = (sectionName === 'mysqld');
                continue;
            }

            // 3. Przetwarzanie parametrów wewnątrz sekcji [mysqld] dla tcp_keepalive_time
            if (inMysqldSection) {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex !== -1) {
                    const key = trimmed.substring(0, eqIndex).trim();
                    const value = trimmed.substring(eqIndex + 1).trim();
                    
                    if (key === 'tcp_keepalive_time') {
                        // Konwersja na liczbę (sekundy)
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
                // Podział na klucz i wartość przy pierwszym znaku "="
                const eqIndex = trimmed.indexOf('=');
                let key, value;
                if (eqIndex !== -1) { // to co ma znak równości w linii
                    key = trimmed.substring(0, eqIndex).trim();
                    value = trimmed.substring(eqIndex + 1).trim();
                    // Usuwanie cudzysłowów otaczających wartość, jeśli istnieją
                    value = value.replace(REGEX_SURROUNDING_QUOTES, '');
                    
                    // zmiana wartości
                    const valueLower = value.toLowerCase();
                    if (valueLower === 'true') {
                        value = true;
                    } else if (valueLower === 'false') {
                        value = false;
                    } else if (!isNaN(Number(value)) && value !== '') {
                        // Automatyczna konwersja portów i limitów na typ number
                        value = Number(value);
                    }
                } else {
                    // obsługa jeśli nie ma znaku "="
                    key = trimmed;
                    value = '';
                }
                
                // zamiana kluczy
                switch (key) {
                    case 'skip-ssl':
                        key = 'ssl';
                        value = (value === true || value === '') ? false : true;
                        break;
                    
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

        // Po przetworzeniu całego pliku, jeśli znaleziono tcp_keepalive_time, dodajemy keepAliveDelay
        if (tcpKeepaliveTime !== null && tcpKeepaliveTime > 0) {
            options.push(['keepAliveDelay', tcpKeepaliveTime * 1000]);
        }

        return options;
    }
}
