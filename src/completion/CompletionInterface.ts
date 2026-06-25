import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";

export interface CompletionInterface {
    /**
     * Generuje podpowiedzi kodu (IntelliSense) na podstawie kontekstu SQL.
     * @param linePrefix Tekst w aktualnej linijce znajdujący się przed kursorem.
     * @param fullText Pełna treść SQL-a.
     * @param db Aktywne połączenie z bazą danych.
     * @param sqlBeforeCursor Cały kod SQL znajdujący się przed pozycją kursora.
     */
    complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]>;
}
