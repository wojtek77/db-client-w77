// wspólne potwierdzenie destrukcyjnej operacji (bulk UPDATE/DELETE) - wydzielone z SqlResultsProvider.ts, bo to generyczny dialog VS Code, niezależny od stanu grida
import * as vscode from 'vscode';
import { Connection } from '../db/Connection.js';

/**
 * Wspólne potwierdzenie destrukcyjnej, zbiorczej operacji (bulk UPDATE / DELETE
 * z widoku wyników): pokazuje host i bazę danych, na które operacja faktycznie
 * trafi, a opcjonalnie (ustawienie db-client.requireConnectionNameConfirmation)
 * wymaga wpisania nazwy połączenia, zanim operacja zostanie wykonana.
 */
export async function confirmDestructiveOperation(
    message: string,
    confirmLabel: string,
    db: Connection
): Promise<boolean> {
    const target = [db.getHost(), db.getDatabase()].filter(Boolean).join(' / ');
    const productionWarning = db.isProductionConnection() ? '\n\n⚠ This is a PRODUCTION connection.' : '';
    const fullMessage = target
        ? `${message}\n\nConnection: "${db.getConnectionName()}" (${target})${productionWarning}`
        : `${message}${productionWarning}`;

    const answer = await vscode.window.showWarningMessage(
        fullMessage,
        { modal: true },
        confirmLabel
    );
    if (answer !== confirmLabel) {
        return false;
    }

    const requireTypedName = vscode.workspace
        .getConfiguration('db-client')
        .get<boolean>('requireConnectionNameConfirmation', false);

    if (requireTypedName) {
        const connectionName = db.getConnectionName();
        // validateInput trzyma pole otwarte i pokazuje czerwony błąd dopóki nazwa się nie zgadza, zamiast od razu anulować całą operację
        const typed = await vscode.window.showInputBox({
            prompt: `Type the connection name "${connectionName}" to confirm`,
            placeHolder: connectionName,
            ignoreFocusOut: true,
            validateInput: (value) =>
                value === connectionName ? null : `Connection name doesn't match "${connectionName}"`,
        });
        if (typed !== connectionName) {
            return false;
        }
    }

    return true;
}
