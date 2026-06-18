import { Connection } from '../db/Connection.js';
import { getTableRefKey, TableRef } from '../cache/tableColumnsCache.js';

export function findQueryTables(
    sql: string,
    defaultSchema: string,
    db: Connection
): TableRef[] {

    const tableRefs: TableRef[] = [];

    const regex =
        /\b(?:from|join)\s+(?:(\w+)\s*\.\s*)?(\w+)/gi;

    let match:
        RegExpExecArray | null;

    while (
        (match = regex.exec(sql))
        !== null
    ) {

        tableRefs.push({

            schema:
                match[1]
                    || defaultSchema
                    || db.findSchemaByTable(
                        match[2]
                    )
                    || '',

            table:
                match[2]
        });
    }

    return Array.from(
        new Map(
            tableRefs.map(
                tableRef => [
                    getTableRefKey(tableRef),
                    tableRef
                ]
            )
        ).values()
    );
}
