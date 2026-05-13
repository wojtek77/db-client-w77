import * as vscode from 'vscode';
import { ConnectionManager } from './db/ConnectionManager';
import { CnfLoader } from "./db/CnfLoader";
import { registerPanelCommand } from './panel/panel';

export async function activate(context: vscode.ExtensionContext) {
    console.log(new Date().toLocaleTimeString('pl-PL', { hour12: false }));

    const db = ConnectionManager.getInstance();
    const cnfOptions = await CnfLoader.getOptionsFromCnf('~/.db_configs/local-system.cnf');
    const connectionTime = await db.connect({
        ...cnfOptions,
        connectionLimit: 5,
        connectTimeout: 10000,
        acquireTimeout: 10000,
        supportBigNumbers: true,
        bigNumberStrings: false,
        insertIdAsNumber: true,
        bigIntAsNumber: true
    });

    let sql = `
                select *
                from student s
                order by id
                limit 400
                `;
    
    const disposable = registerPanelCommand(
        context,
        connectionTime,
        sql
    );

    context.subscriptions.push(disposable);
}

export async function deactivate() {

    await ConnectionManager.getInstance().disconnect();

    console.log('WYWOŁANIE FUNKCJI DEACTIVATE');
}
