import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { Connection } from '../db/Connection.js';

// Domyślny szablon połączenia - celowo dopasowany do najbardziej typowego
// przypadku (Windows + WAMP: root bez hasła na 127.0.0.1:3306), bo to jest
// to, co realnie "po prostu działa" u większości użytkowników tego rozszerzenia
// bez żadnej edycji poza `database`. `production`/`readonly` żyją w osobnej
// sekcji [db-client] (nie [client]!), żeby ten sam plik dało się nadal użyć
// wprost jako --defaults-file dla prawdziwego klienta `mysql`/`mariadb`
// (patrz CnfLoader.ts - DB_CLIENT_BOOLEAN_KEYS).
// UWAGA: komentarze WEWNĄTRZ pliku .cnf są po angielsku (plik czyta użytkownik
// końcowy), w odróżnieniu od komentarzy w tym pliku .ts.
const DEFAULT_CNF_CONTENT = `[client]
host = 127.0.0.1
port = 3306
user = root
password =
database =  # your database name

# WAMP doesn't set a password for "root" by default and doesn't require TLS
# on localhost. If your credentials differ (e.g. Linux/MAMP/Docker), just
# change the values above.
# For REMOTE connections, use "ssl-ca = /path/to/ca-cert.pem" instead of
# "skip-ssl" (see README, "Production safety" section).
skip-ssl = true
reconnect = false
compress = false

[db-client]
# uncomment to mark this connection as production / read-only
# production = true
# readonly = true
`;

const DEFAULT_CNF_FILENAME = 'localhost.cnf';

/**
 * Zapewnia, że istnieje katalog konfiguracji ORAZ przynajmniej jeden plik .cnf:
 * - tworzy katalog, jeśli go nie ma (no-op, jeśli już istnieje)
 * - tworzy domyślny plik połączenia, TYLKO jeśli w katalogu nie ma jeszcze
 *   żadnego pliku .cnf (nigdy nie nadpisuje istniejącej konfiguracji użytkownika)
 * - od razu otwiera ten plik w edytorze, żeby użytkownik go uzupełnił
 *
 * Używane zarówno przez komendę z palety poleceń, jak i bezpośrednio po
 * potwierdzeniu w prompcie "brak skonfigurowanego połączenia" (patrz extension.ts).
 */
export async function createConfigDirCommand() {
    const configDir = ConnectionManager.getInstance().getConfigDir();

    try {
        fs.mkdirSync(configDir, { recursive: true });
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create "${configDir}": ${err.message}`);
        return;
    }

    const alreadyHasConnections = !ConnectionManager.getInstance().hasNoConnections();
    const defaultCnfPath = path.join(configDir, DEFAULT_CNF_FILENAME);

    if (alreadyHasConnections) {
        // katalog już ma jakiś plik .cnf (być może kilka) - nic nie tworzymy,
        // tylko informujemy, gdzie szukać
        vscode.window.showInformationMessage(
            `Connection config directory "${configDir}" already has connection(s) configured.`
        );
        return;
    }

    // Nie nadpisuj, jeśli plik o tej samej nazwie już istnieje z jakiegoś powodu
    // (np. przywrócony z kopii zapasowej) - to by bezpowrotnie skasowało dane.
    if (!fs.existsSync(defaultCnfPath)) {
        try {
            fs.writeFileSync(defaultCnfPath, DEFAULT_CNF_CONTENT, { mode: 0o600 });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create "${defaultCnfPath}": ${err.message}`);
            return;
        }
    } else {
        // plik już istniał (mode nie działa retroaktywnie) - i tak dopilnuj uprawnień
        try {
            fs.chmodSync(defaultCnfPath, 0o600);
        } catch {
            // best-effort - np. na Windows chmod nie ma tego samego znaczenia, ignorujemy
        }
    }

    ConnectionManager.getInstance().reloadConfigs();

    // Otwarcie pliku w edytorze JEST feedbackiem, że coś się stało - nie trzeba
    // do tego dodatkowo blokującego modala z przyciskiem "Edit", jak poprzednio.
    try {
        const doc = await vscode.workspace.openTextDocument(defaultCnfPath);
        await vscode.window.showTextDocument(doc);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Could not open "${defaultCnfPath}": ${err.message}`);
        return;
    }

    vscode.window.showInformationMessage(
        `Created "${DEFAULT_CNF_FILENAME}" with default WAMP-style values (root, no password, 127.0.0.1:3306). ` +
        `Update "database" (and anything else that doesn't match your setup), then run "DB client: Reload Connection Files".`
    );
}

/** Otwiera plik połączenia w edytorze - używane m.in. do naprawy jedynego
 *  skonfigurowanego połączenia po nieudanej próbie użycia go. */
export async function openConnectionFile(cnfPath: string) {
    try {
        const doc = await vscode.workspace.openTextDocument(cnfPath);
        await vscode.window.showTextDocument(doc);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Could not open "${cnfPath}": ${err.message}`);
    }
}

/** Ponownie wczytuje pliki *.cnf z katalogu konfiguracji. */
export async function reloadConnectionsCommand() {
    const configs = ConnectionManager.getInstance().reloadConfigs();
    const names = Object.keys(configs);

    if (ConnectionManager.getInstance().isConfigDirMissing()) {
        vscode.window.showWarningMessage(
            `Connection config directory "${ConnectionManager.getInstance().getConfigDir()}" still doesn't exist. Run "DB client: Create Default Connection (localhost)" first.`
        );
        return;
    }

    vscode.window.showInformationMessage(
        names.length > 0
            ? `Reloaded ${names.length} connection(s): ${names.join(', ')}`
            : `No .cnf files found in "${ConnectionManager.getInstance().getConfigDir()}".`
    );
}

/** Próbuje nawiązać (lub odświeżyć) połączenie z wybraną bazą i pokazuje wynik. */
export async function testConnectionCommand() {
    const configs = ConnectionManager.getInstance().getConfigs();
    const names = Object.keys(configs);

    if (names.length === 0) {
        vscode.window.showWarningMessage(
            ConnectionManager.getInstance().isConfigDirMissing()
                ? 'No connection config directory found. Run "DB client: Create Default Connection (localhost)" first.'
                : 'No connections configured. Add a .cnf file to the connection config directory.'
        );
        return;
    }

    const connectionName = await vscode.window.showQuickPick(names, {
        placeHolder: 'Select a connection to test',
        ignoreFocusOut: true,
    });
    if (!connectionName) {
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing connection "${connectionName}"...` },
        async () => {
            try {
                const db: Connection = await ConnectionManager.getInstance().reconnect(connectionName);
                const label = db.isProductionConnection() ? ' (⚠ PRODUCTION)' : '';
                vscode.window.showInformationMessage(
                    `✅ Connected to "${connectionName}"${label} in ${db.getConnectionTime().toFixed(0)} ms`
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`❌ Connection "${connectionName}" failed: ${err.message}`);
            }
        }
    );
}
