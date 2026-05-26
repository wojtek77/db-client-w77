import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles';

let extensionRunning = false;

export function isExtensionRunning() {
    return extensionRunning;
}

export async function startExtension(context: vscode.ExtensionContext) {
    console.log('START_EXTENSION');
    
    // ⭐ USTAW KONTEKST – zakładka stanie się widoczna
    await vscode.commands.executeCommand('setContext', 'dbClientActive', true);
    extensionRunning = true;
    
    ConnectionManager.getInstance().start();
}

export async function stopExtension() {
    console.log('STOP_EXTENSION');
    
    // ⭐ UKRYJ ZAKŁADKĘ
    await vscode.commands.executeCommand('setContext', 'dbClientActive', false);
    extensionRunning = false;
    
    ConnectionManager.getInstance().stop();
    
    // zapisanie listy plików SQL na dysk
    await RecentSqlFiles.getInstance().persist();
}
