export class SqlUtil {

    static appendLimit(
        sql: string,
        limit: number = 200
    ): string {
        const needsLimit = /^select(?!.+\slimit\s)/is.test(sql);
        if (needsLimit) {
            return sql
                .replace(/;$/, '')
                .trim() + ' LIMIT '+limit;
        }
        return sql;
    }
}
