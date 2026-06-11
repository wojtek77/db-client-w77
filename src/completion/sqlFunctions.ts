export interface SqlFunction {
    name: string;
    signature: string;
    description: string;
    snippet: string;
}

export const SQL_FUNCTIONS: SqlFunction[] = [

    {
        name: 'COUNT',
        signature: 'COUNT(expr)',
        description:
            'Counts rows or non-null values.',
        snippet:
            'COUNT($1)'
    },

    {
        name: 'SUM',
        signature: 'SUM(expr)',
        description:
            'Adds numeric values.',
        snippet:
            'SUM($1)'
    },

    {
        name: 'AVG',
        signature: 'AVG(expr)',
        description:
            'Calculates average value.',
        snippet:
            'AVG($1)'
    },

    {
        name: 'GROUP_CONCAT',
        signature:
            'GROUP_CONCAT(expr)',
        description:
            'Concatenates values from a group into one string.',
        snippet:
            'GROUP_CONCAT($1)'
    },

    {
        name: 'IFNULL',
        signature:
            'IFNULL(expr, alt)',
        description:
            'Returns alternative value when expression is NULL.',
        snippet:
            'IFNULL($1, $2)'
    },

    {
        name: 'ROUND',
        signature:
            'ROUND(number, decimals)',
        description:
            'Rounds number to specified decimals.',
        snippet:
            'ROUND($1, $2)'
    },

    {
        name: 'DATE_FORMAT',
        signature:
            'DATE_FORMAT(date, format)',
        description:
            'Formats date using specified pattern.',
        snippet:
            'DATE_FORMAT($1, $2)'
    }
];
