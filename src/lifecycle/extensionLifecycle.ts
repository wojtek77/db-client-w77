import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';

let extensionRunning = false;
let startingPromise: Promise<void> | null = null;
let stoppingAllPromise: Promise<void> | null = null;

export function isExtensionRunning() {
    return extensionRunning;
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
