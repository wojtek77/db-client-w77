import * as vscode from 'vscode';

export interface ColorOption {
    label: string;
    color: string | null; // null = brak koloru
}

export const COLOR_OPTIONS: ColorOption[] = [
    { label: '⬜ No color',    color: null },
    { label: '🔴 Red',        color: '#e06c75' },
    { label: '🟠 Orange',     color: '#d19a66' },
    { label: '🟡 Yellow',     color: '#e5c07b' },
    { label: '🟢 Green',      color: '#98c379' },
    { label: '🔵 Blue',       color: '#61afef' },
    { label: '🟣 Purple',     color: '#c678dd' },
    { label: '🩷 Pink',       color: '#ff79c6' },
    { label: '⬛ Gray',       color: '#abb2bf' },
];

const STORAGE_KEY = 'connectionColors';

export class ConnectionColors {

    private static instance: ConnectionColors;
    private colors: Record<string, string | null> = {};

    public static initialize(context: vscode.ExtensionContext): ConnectionColors {
        if (!this.instance) {
            this.instance = new ConnectionColors(context);
        }
        return this.instance;
    }

    public static getInstance(): ConnectionColors {
        if (!this.instance) {
            throw new Error('ConnectionColors not initialized');
        }
        return this.instance;
    }

    private constructor(private context: vscode.ExtensionContext) {
        this.colors = context.globalState.get<Record<string, string | null>>(STORAGE_KEY) ?? {};
    }

    public getColor(connectionName: string): string | null {
        return this.colors[connectionName] ?? null;
    }

    public async pickColor(connectionName: string): Promise<string | null | undefined> {
        const currentColor = this.getColor(connectionName);

        const items = COLOR_OPTIONS.map(opt => ({
            label: opt.label,
            description: opt.color === currentColor ? '✓ aktualny' : undefined,
            color: opt.color,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Select color for connection: ${connectionName}`,
            ignoreFocusOut: true,
        });

        if (!picked) {
            return undefined; // anulowano
        }

        await this.setColor(connectionName, picked.color);
        return picked.color;
    }

    private async setColor(connectionName: string, color: string | null): Promise<void> {
        if (color === null) {
            delete this.colors[connectionName];
        } else {
            this.colors[connectionName] = color;
        }
        await this.context.globalState.update(STORAGE_KEY, this.colors);
    }
}
