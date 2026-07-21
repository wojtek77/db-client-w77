import * as assert from 'assert';
import { formatSql } from '../commands/formatSqlCommand.js';

suite('formatSql - ASC/DESC casing', () => {
    test('uppercases lowercase asc/desc in ORDER BY', () => {
        assert.strictEqual(
            formatSql('select id, name from users order by name desc, id asc'),
            'SELECT id, name\nFROM users\nORDER BY name DESC, id ASC',
        );
    });

    test('uppercases mixed-case Asc/Desc in ORDER BY', () => {
        assert.strictEqual(
            formatSql('select id from t order by id Asc, name Desc'),
            'SELECT id\nFROM t\nORDER BY id ASC, name DESC',
        );
    });

    test('leaves already-uppercase ASC/DESC untouched', () => {
        assert.strictEqual(
            formatSql('select id from t order by id ASC, name DESC'),
            'SELECT id\nFROM t\nORDER BY id ASC, name DESC',
        );
    });

    test('uppercases asc/desc in GROUP BY (legacy MySQL/MariaDB syntax)', () => {
        assert.strictEqual(
            formatSql('select id, count(*) from users group by id desc'),
            'SELECT id, count(*)\nFROM users\nGROUP BY id DESC',
        );
    });

    test('does not touch identifiers that merely contain "asc"/"desc" as a substring', () => {
        // "descripcion" i "ascii_col" nie mogą zostać częściowo zamienione na wielkie litery
        const result = formatSql('select descripcion, ascii_col from t order by descripcion asc');
        assert.ok(result.includes('descripcion'));
        assert.ok(result.includes('ascii_col'));
        assert.ok(!result.includes('DESCripcion'));
        assert.ok(!result.includes('ASCii_col'));
        assert.ok(result.endsWith('descripcion ASC'));
    });

    test('uppercases asc/desc even outside of ORDER BY / GROUP BY (no context sensitivity - unquoted reserved words are not valid identifiers anyway)', () => {
        const result = formatSql("select id from t where asc = 1");
        assert.ok(result.includes('WHERE ASC = 1'));
    });

    test('uppercases desc/asc glued directly to a trailing semicolon (no space before ;)', () => {
        // bug: ';' nie był granicą tokena, więc "desc;" trafiało jako jeden token i nie przechodziło testu /^[A-Za-z_]+$/
        assert.strictEqual(
            formatSql('select id from products order by price desc;'),
            'SELECT id\nFROM products\nORDER BY price DESC;',
        );
    });

    test('uppercases last asc/desc glued to semicolon after a function call', () => {
        assert.strictEqual(
            formatSql('select id from products order by name, ROUND(price, 2) desc;'),
            'SELECT id\nFROM products\nORDER BY name, ROUND(price, 2) DESC;',
        );
    });
});

suite('formatSql - BETWEEN ... AND (not a clause boundary)', () => {
    test('does not split BETWEEN x AND y into two lines', () => {
        assert.strictEqual(
            formatSql('select id from users where age between 1 and 2'),
            'SELECT id\nFROM users\nWHERE age BETWEEN 1 AND 2',
        );
    });

    test('correctly joins BETWEEN with a following real AND', () => {
        assert.strictEqual(
            formatSql("select id from users where age between 1 and 2 and name = 'x'"),
            "SELECT id\nFROM users\nWHERE age BETWEEN 1 AND 2\n\tAND name = 'x'",
        );
    });

    test('handles two BETWEEN clauses joined by a real AND', () => {
        assert.strictEqual(
            formatSql('select id from t where a between 1 and 2 and b between 3 and 4'),
            'SELECT id\nFROM t\nWHERE a BETWEEN 1 AND 2\n\tAND b BETWEEN 3 AND 4',
        );
    });

    test('handles NOT BETWEEN', () => {
        assert.strictEqual(
            formatSql('select id from t where a not between 1 and 2'),
            'SELECT id\nFROM t\nWHERE a NOT BETWEEN 1 AND 2',
        );
    });
});

suite('formatSql - consistent uppercasing of remaining keywords', () => {
    test('uppercase DISTINCT, AS, IS NULL, LIKE, IN, NOT EXISTS at once (including SELECT/FROM inside a subquery)', () => {
        assert.strictEqual(
            formatSql(
                "select distinct id as user_id from users where deleted_at is null " +
                "and name like 'a%' and id in (1,2) and not exists (select 1 from x)",
            ),
            'SELECT DISTINCT id AS user_id\nFROM users\nWHERE deleted_at IS NULL\n' +
            "\tAND name LIKE 'a%'\n\tAND id IN (1,2)\n\tAND NOT EXISTS (SELECT 1 FROM x)",
        );
    });

    test('uppercase CASE/WHEN/THEN/ELSE/END', () => {
        assert.strictEqual(
            formatSql("select case when id = 1 then 'a' else 'b' end from users"),
            "SELECT CASE WHEN id = 1 THEN 'a' ELSE 'b' END\nFROM users",
        );
    });

    test('uppercase NULL/TRUE/FALSE', () => {
        assert.strictEqual(
            formatSql('insert into t (a,b) values (null, true)'),
            'INSERT INTO t (a,b)\nVALUES (NULL, TRUE)',
        );
    });

    test('does not touch the content of a string literal', () => {
        const result = formatSql("select id from t where note = 'this is null and not exists'");
        assert.ok(result.includes("'this is null and not exists'"));
    });

    test('does not touch a backtick-quoted identifier', () => {
        assert.strictEqual(
            formatSql('select `desc`, `is null` from t'),
            'SELECT `desc`, `is null`\nFROM t',
        );
    });
});

suite('formatSql - keywords inside a string literal are not a clause boundary', () => {
    // bug znaleziony przy naprawie BETWEEN: findClauses szukał granic klauzul w surowym tekście, więc 'where'/'and' w stringu psuło formatowanie
    test('does not split a string literal containing SQL keywords', () => {
        assert.strictEqual(
            formatSql("select id from t where note = 'select this and where that'"),
            "SELECT id\nFROM t\nWHERE note = 'select this and where that'",
        );
    });
});


suite('formatSql - basic clause formatting (regression safety net)', () => {
    test('uppercases core clause keywords regardless of input casing', () => {
        assert.strictEqual(
            formatSql('SeLeCt id From users Where id = 1'),
            'SELECT id\nFROM users\nWHERE id = 1',
        );
    });

    test('formats JOIN ... ON and uppercases ON', () => {
        assert.strictEqual(
            formatSql('select id from users u join orders o on o.user_id = u.id'),
            'SELECT id\nFROM users u\nJOIN orders o ON o.user_id = u.id',
        );
    });

    test('indents AND/OR under WHERE', () => {
        assert.strictEqual(
            formatSql('select id from t where a = 1 and b = 2'),
            'SELECT id\nFROM t\nWHERE a = 1\n\tAND b = 2',
        );
    });

    test('preserves trailing semicolon', () => {
        assert.strictEqual(
            formatSql('select id from users;'),
            'SELECT id\nFROM users;',
        );
    });
});

suite('formatSql - standalone comments stay on their own lines', () => {
    test('# and -- comments before the query are not merged into one line', () => {
        assert.strictEqual(
            formatSql('# note one\n-- note two\nselect id from orders'),
            '# note one\n-- note two\nSELECT id\nFROM orders',
        );
    });

    test('recognizes a "#" comment glued without a space to the previous line', () => {
        // bug: '#' nie było ogranicznikiem tokena słowa, więc "#note" wpadało do słowa zamiast być komentarzem
        assert.strictEqual(
            formatSql('#note\nselect id from customers'),
            '#note\nSELECT id\nFROM customers',
        );
    });

    test('a comment inside FROM/JOIN starts a new line instead of being glued to the previous token', () => {
        assert.strictEqual(
            formatSql('select id from customers c\n-- join comment\njoin invoices i on i.customer_id = c.id'),
            'SELECT id\nFROM customers c\n-- join comment\nJOIN invoices i ON i.customer_id = c.id',
        );
    });

    test('a comment inside ORDER BY starts a new line without breaking the formatting after it', () => {
        assert.strictEqual(
            formatSql('select id from customers order by name,\n# extra sorting\nemail desc'),
            'SELECT id\nFROM customers\nORDER BY name,\n# extra sorting\nemail DESC',
        );
    });

    test('a comment right after a clause header (ORDER BY) does not get glued into the header line', () => {
        assert.strictEqual(
            formatSql('select id from customers order by\n# extra sorting\nname desc'),
            'SELECT id\nFROM customers\nORDER BY\n# extra sorting\nname DESC',
        );
    });
});

suite('formatSql - block comments (/* ... */)', () => {
    // bug: /* */ nie było wcale tokenizowane, więc słowo kluczowe wewnątrz (np. "select") było mylone z granicą klauzuli
    test('a keyword inside a block comment does not create a new clause boundary', () => {
        assert.strictEqual(
            formatSql('select id /* please and or select */ from t'),
            'SELECT id\n\t/* please and or select */\nFROM t',
        );
    });

    test('does not touch the content of a block comment', () => {
        const result = formatSql('select id /* select from where */ from t');
        assert.ok(result.includes('/* select from where */'));
    });

    test('a single-line block comment inside SELECT starts a new line, like -- and #', () => {
        assert.strictEqual(
            formatSql('select id, /* note */ name from t'),
            'SELECT id,\n\t/* note */\n\tname\nFROM t',
        );
    });

    test('a multi-line block comment is kept intact as one token', () => {
        assert.strictEqual(
            formatSql('select id,\n/* multi\nline comment */\nname from t'),
            'SELECT id,\n\t/* multi\nline comment */\n\tname\nFROM t',
        );
    });

    test('an unterminated block comment consumes the rest of the text instead of throwing', () => {
        assert.strictEqual(
            formatSql('select id from t /* unterminated'),
            'SELECT id\nFROM t\n/* unterminated',
        );
    });
});

suite('formatSql - escaped quotes inside string/identifier literals', () => {
    // bug: apostrof podwojony w środku stringa ('it''s') był mylony z końcem tokena, co rozbijało string na dwa osobne tokeny
    test('a doubled single quote inside a string is an escaped quote, not the end of the string', () => {
        assert.strictEqual(
            formatSql("select id from t where note = 'it''s ok'"),
            "SELECT id\nFROM t\nWHERE note = 'it''s ok'",
        );
    });

    test('a backslash-escaped single quote inside a string is not the end of the string', () => {
        assert.strictEqual(
            formatSql("select id from t where note = 'it\\'s ok'"),
            "SELECT id\nFROM t\nWHERE note = 'it\\'s ok'",
        );
    });

    test('a doubled double quote inside a double-quoted string is an escaped quote', () => {
        assert.strictEqual(
            formatSql('select id from t where note = "she said ""hi"""'),
            'SELECT id\nFROM t\nWHERE note = "she said ""hi"""',
        );
    });

    test('a doubled backtick inside a backtick identifier is an escaped backtick', () => {
        assert.strictEqual(
            formatSql('select `a``b` from t'),
            'SELECT `a``b`\nFROM t',
        );
    });

    test('an unterminated string ending in a lone backslash does not throw', () => {
        assert.strictEqual(
            formatSql("select id from t where note = 'abc\\"),
            "SELECT id\nFROM t\nWHERE note = 'abc\\",
        );
    });
});

suite('formatSql - UNION / INTERSECT / EXCEPT split each statement onto its own block', () => {
    // bug: UNION nie było granicą klauzuli, więc doklejało się na koniec FROM pierwszego zapytania zamiast rozdzielać dwa SELECT-y
    test('splits a plain UNION into two independently formatted statements', () => {
        assert.strictEqual(
            formatSql('select a from t1 union select b from t2'),
            'SELECT a\nFROM t1\nUNION\nSELECT b\nFROM t2',
        );
    });

    test('keeps UNION ALL together as one operator on its own line', () => {
        assert.strictEqual(
            formatSql('select a from t1 union all select b from t2'),
            'SELECT a\nFROM t1\nUNION ALL\nSELECT b\nFROM t2',
        );
    });

    test('handles three statements chained by UNION', () => {
        assert.strictEqual(
            formatSql('select a from t1 union select b from t2 union select c from t3'),
            'SELECT a\nFROM t1\nUNION\nSELECT b\nFROM t2\nUNION\nSELECT c\nFROM t3',
        );
    });

    test('handles INTERSECT', () => {
        assert.strictEqual(
            formatSql('select a from t1 intersect select b from t2'),
            'SELECT a\nFROM t1\nINTERSECT\nSELECT b\nFROM t2',
        );
    });

    test('handles EXCEPT', () => {
        assert.strictEqual(
            formatSql('select a from t1 except select b from t2'),
            'SELECT a\nFROM t1\nEXCEPT\nSELECT b\nFROM t2',
        );
    });

    test('formats WHERE and ORDER BY correctly on both sides of a UNION', () => {
        assert.strictEqual(
            formatSql('select a from t1 where a > 1 union select b from t2 where b < 5 order by b'),
            'SELECT a\nFROM t1\nWHERE a > 1\nUNION\nSELECT b\nFROM t2\nWHERE b < 5\nORDER BY b',
        );
    });

    test('a UNION inside a subquery (deeper nesting) is not treated as a top-level statement boundary', () => {
        assert.strictEqual(
            formatSql('select * from (select a from t1 union select b from t2) x'),
            'SELECT *\nFROM (SELECT a FROM t1 UNION SELECT b FROM t2) x',
        );
    });
});

suite('formatSql - UPDATE / SET / DELETE are now recognized clauses', () => {
    test('formats a simple UPDATE ... SET ... WHERE', () => {
        assert.strictEqual(
            formatSql('update t set a = 1, b = 2 where id = 3'),
            'UPDATE t\nSET a = 1, b = 2\nWHERE id = 3',
        );
    });

    test('formats UPDATE ... SET without a WHERE clause', () => {
        assert.strictEqual(
            formatSql('update products set price = 10'),
            'UPDATE products\nSET price = 10',
        );
    });

    test('formats a multi-table UPDATE with JOIN on its own line, like FROM', () => {
        assert.strictEqual(
            formatSql('update t1 join t2 on t1.id = t2.id set t1.a = t2.b where t2.id = 5'),
            'UPDATE t1\nJOIN t2 ON t1.id = t2.id\nSET t1.a = t2.b\nWHERE t2.id = 5',
        );
    });

    test('formats a simple DELETE FROM ... WHERE', () => {
        assert.strictEqual(
            formatSql('delete from t where id = 1'),
            'DELETE\nFROM t\nWHERE id = 1',
        );
    });

    test('formats DELETE FROM without a WHERE clause', () => {
        assert.strictEqual(
            formatSql('delete from t'),
            'DELETE\nFROM t',
        );
    });

    test('formats a multi-table DELETE with a table alias before FROM', () => {
        assert.strictEqual(
            formatSql('delete t1 from t1 join t2 on t1.id = t2.id where t2.x = 1'),
            'DELETE t1\nFROM t1\nJOIN t2 ON t1.id = t2.id\nWHERE t2.x = 1',
        );
    });
});

suite('formatSql - window functions (OVER / PARTITION BY) and NULLS FIRST/LAST', () => {
    test('uppercases OVER/PARTITION BY/ORDER BY inside a window function', () => {
        assert.strictEqual(
            formatSql('select id, row_number() over (partition by dept order by salary desc) as rn from emp'),
            'SELECT id, row_number() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn\nFROM emp',
        );
    });

    test('handles a window function with ORDER BY but no PARTITION BY', () => {
        assert.strictEqual(
            formatSql('select id, rank() over (order by salary desc) as r from emp'),
            'SELECT id, rank() OVER (ORDER BY salary DESC) AS r\nFROM emp',
        );
    });

    test('handles an empty OVER ()', () => {
        assert.strictEqual(
            formatSql('select id, sum(salary) over () as total from emp'),
            'SELECT id, sum(salary) OVER () AS total\nFROM emp',
        );
    });

    test('does not uppercase NULLS/FIRST/LAST - not reserved words (this syntax does not even exist in MariaDB)', () => {
        assert.strictEqual(
            formatSql('select id from t order by id desc nulls last'),
            'SELECT id\nFROM t\nORDER BY id DESC nulls last',
        );
        assert.strictEqual(
            formatSql('select id from t order by id nulls first'),
            'SELECT id\nFROM t\nORDER BY id nulls first',
        );
    });

    test('does not uppercase NULLS/LAST inside a window function ORDER BY', () => {
        assert.strictEqual(
            formatSql('select id, lag(id) over (order by id nulls last) as prev from t'),
            'SELECT id, lag(id) OVER (ORDER BY id nulls last) AS prev\nFROM t',
        );
    });

    test('does not touch identifiers like over_col/partition_col outside a window context', () => {
        assert.strictEqual(
            formatSql('select over_col, partition_col from t where over_col = 1'),
            'SELECT over_col, partition_col\nFROM t\nWHERE over_col = 1',
        );
    });

    test('handles multiple window functions in the same SELECT list', () => {
        assert.strictEqual(
            formatSql('select a, sum(a) over (partition by b) as s1, avg(a) over (partition by c order by d) as s2 from t'),
            'SELECT a, sum(a) OVER (PARTITION BY b) AS s1, avg(a) OVER (PARTITION BY c ORDER BY d) AS s2\nFROM t',
        );
    });
});
