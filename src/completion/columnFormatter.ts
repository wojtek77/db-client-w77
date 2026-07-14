import { TableColumn } from "../cache/TableColumnsCache";

// Funkcja formatująca typ kolumny z dodatkowymi informacjami
export function formatColumnType(column: TableColumn): string {
    let typeDisplay = column.type.toUpperCase();
    
    // Dla VARCHAR i CHAR
    if ((column.type === 'varchar' || column.type === 'char') && column.characterMaximumLength) {
        typeDisplay = `${column.type.toUpperCase()}(${column.characterMaximumLength})`;
    }
    // Dla INT, BIGINT, SMALLINT, TINYINT
    else if (column.type === 'int' && column.numericPrecision) {
        typeDisplay = `INT(${column.numericPrecision})`;
    }
    else if (column.type === 'bigint' && column.numericPrecision) {
        typeDisplay = `BIGINT(${column.numericPrecision})`;
    }
    else if (column.type === 'smallint' && column.numericPrecision) {
        typeDisplay = `SMALLINT(${column.numericPrecision})`;
    }
    else if (column.type === 'tinyint' && column.numericPrecision) {
        typeDisplay = `TINYINT(${column.numericPrecision})`;
    }
    // Dla DECIMAL
    else if (column.type === 'decimal' && column.numericPrecision !== null) {
        if (column.numericScale && column.numericScale > 0) {
            typeDisplay = `DECIMAL(${column.numericPrecision}, ${column.numericScale})`;
        } else {
            typeDisplay = `DECIMAL(${column.numericPrecision})`;
        }
    }
    else if (column.type === 'enum' || column.type === 'set') {
        typeDisplay = column.columnType.replace(/^(enum|set)\(/i, (match: string) => match.toUpperCase());
    }
    
    return typeDisplay;
}
