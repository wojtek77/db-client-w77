import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';

let extensionRunning = false;
let startingPromise: Promise<void> | null = null;
let stoppingAllPromise: Promise<void> | null = null;

export function isExtensionRunning() {
    return extensionRunning;
}

/**
 * Wywoływane, gdy zakładka danego pliku SQL przestaje być otwarta (nie ma
 * już żadnej zakładki wskazującej na ten plik). Czyści cache wyników zapytań
 * dla tego pliku - to jedyne miejsce, w którym trzeba to robić, bo zamknięcie
 * ostatniej zakładki SQL (patrz `stopExtension`) jest tylko szczególnym
 * przypadkiem zamknięcia zakładki w ogóle.
 *
 * Owinięte w try/catch - w teorii może zostać wywołane zanim
 * SqlResultsProvider.initialize() zdąży się wykonać.
 */
export function closeSqlFile(filePath: string) {
    try {
        SqlResultsProvider.getInstance().clearCache(filePath);
    } catch {
        // sqlResultsProvider jeszcze nie istnieje - nic do wyczyszczenia
    }
}

export async function startExtension(context: vscode.ExtensionContext) {
    // już uruchomione - nic do zrobienia
    if (extensionRunning) {
        return;
    }

    // start już w toku (druga równoległa próba) - poczekaj na ten sam start
    if (startingPromise) {
        return startingPromise;
    }

    startingPromise = (async () => {
        console.log('START_EXTENSION');

        // ⭐ USTAW KONTEKST – zakładka stanie się widoczna
        await vscode.commands.executeCommand('setContext', 'dbClientActive', true);
        extensionRunning = true;

        ConnectionManager.getInstance().start();
    })();

    try {
        await startingPromise;
    } finally {
        startingPromise = null;
    }
}

/**
 * Uruchamia rozszerzenie, a w razie błędu pokazuje komunikat zamiast
 * surowego błędu aktywacji rozszerzenia.
 *
 * Przeniesione tu z extension.ts (zamiast zostawać lokalną funkcją) tak,
 * żeby komendy typu runSQLCommand/runSqlWholeFileCommand mogły z niej
 * skorzystać bez cyklicznego importu z extension.ts.
 *
 * UWAGA: to jest wołane za KAŻDYM razem, gdy rozszerzenie przechodzi ze
 * stanu stopped -> running (czyli też przy każdym otwarciu pierwszego pliku
 * .sql po zamknięciu poprzedniego) - dlatego nie ma tu już sprawdzania braku
 * konfiguracji (patrz checkFirstRunConfig poniżej, wołane tylko raz z
 * extension.ts/activate).
 */
export async function safeStartExtension(context: vscode.ExtensionContext) {
    try {
        await startExtension(context);
    } catch (err: any) {
        console.error('Failed to start DB client extension:', err);

        if (!ConnectionManager.getInstance().hasNoConnections()) {
            vscode.window.showErrorMessage(`DB client failed to start: ${err.message}`);
        }
        // gdy nie ma żadnego połączenia, startExtension() nie rzuca – ten przypadek obsługuje checkFirstRunConfig, raz przy starcie VS Code
    }

    // celowo nie łączymy się tu proaktywnie z bazą – połączenie ma powstawać leniwie przy Run SQL, błędny .cnf obsłuży fallback przy zapytaniu
}

/**
 * Sprawdza, czy jest skonfigurowane jakiekolwiek połączenie z bazą i jeśli
 * nie - pokazuje przyjazny prompt z opcją utworzenia domyślnego połączenia
 * (localhost).
 *
 * CELOWO wołane TYLKO RAZ, bezpośrednio z extension.ts/activate() - a więc
 * raz na sesję VS Code, niezależnie od tego, ile razy w międzyczasie
 * rozszerzenie faktycznie wystartuje/zatrzyma się (otwieranie/zamykanie
 * plików .sql). Jeśli user przy pierwszym pokazaniu zrobi Cancel, nie ma
 * sensu go tym więcej meczyć w tej samej sesji.
 *
 * Celowo NIE rozróżniamy tutaj "katalog w ogóle nie istnieje" od "katalog
 * istnieje, ale jest pusty" - w obu przypadkach obsługa jest identyczna
 * (createConfigDirCommand tworzy katalog tylko jeśli faktycznie brakuje).
 */
export async function checkFirstRunConfig() {
    const cm = ConnectionManager.getInstance();

    if (!cm.hasNoConnections()) {
        return;
    }

    const createLabel = 'Create Default Connection (localhost)';

    // modal: true, bo zwykła notyfikacja sama się chowa po kilku sekundach, a to pierwsza rzecz widoczna przy pierwszym uruchomieniu
    // VS Code sam dokłada przycisk 'Cancel' przy modal:true, więc podajemy tylko przycisk potwierdzający – inaczej byłyby dwa 'Cancel'
    const choice = await vscode.window.showWarningMessage(
        `DB client: no database connection configured yet. Create a default localhost connection to get started ` +
        `(you can edit it afterwards), or set it up manually in "${cm.getConfigDir()}".`,
        { modal: true },
        createLabel
    );

    try {
        if (choice === createLabel) {
            await vscode.commands.executeCommand('db-client.createConfigDir');
        }
    } catch (err: any) {
        // gdyby wykonanie komendy się nie powiodło, użytkownik ma to zobaczyć zamiast cichego niepowodzenia wyglądającego jak 'przycisk nic nie robi'
        vscode.window.showErrorMessage(`DB client: action failed: ${err.message}`);
    }
}

export async function stopExtension(all = false) {
    console.log('STOP_EXTENSION');
    
    // rozłączenie DB
    ConnectionManager.getInstance().stop();
    
    // zapisanie listy plików SQL na dysk
    RecentSqlFiles.getInstance().persist();
    
    // czyszczenie cache tabel z polami
    TableColumnsCache.getInstance().clearTableColumnsCache();

    if (all) {
        // stop-all już w toku (druga równoległa próba) - poczekaj na ten sam stop
        if (stoppingAllPromise) {
            return stoppingAllPromise;
        }

        stoppingAllPromise = (async () => {
            // zamknięcie panelu na dole
            await vscode.commands.executeCommand('workbench.action.closePanel');

            // ⭐ UKRYJ ZAKŁADKĘ
            await vscode.commands.executeCommand('setContext', 'dbClientActive', false);
            extensionRunning = false;
        })();

        try {
            await stoppingAllPromise;
        } finally {
            stoppingAllPromise = null;
        }
    }
}
