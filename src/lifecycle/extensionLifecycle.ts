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
        // SqlResultsProvider jeszcze nie istnieje - nic do wyczyszczenia
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
