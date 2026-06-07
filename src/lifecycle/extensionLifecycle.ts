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

export async function stopExtension(all = false) {
    console.log('STOP_EXTENSION');
    
    // rozłączenie DB
    ConnectionManager.getInstance().stop();
    
    // zapisanie listy plików SQL na dysk
    RecentSqlFiles.getInstance().persist();
    
    if (all) {
        // zamknięcie panelu na dole
        await vscode.commands.executeCommand('workbench.action.closePanel');
        
        // ⭐ UKRYJ ZAKŁADKĘ
        await vscode.commands.executeCommand('setContext', 'dbClientActive', false);
        extensionRunning = false;
    }
}
