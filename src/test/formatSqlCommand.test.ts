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

    test('does not uppercase asc/desc outside of ORDER BY / GROUP BY (e.g. plain WHERE column)', () => {
        // "asc"/"desc" jako nazwa kolumny w innej klauzuli nie powinny być tykane
        const result = formatSql("select id from t where asc = 1");
        assert.ok(result.includes('WHERE asc = 1'));
    });
});

suite('formatSql - BETWEEN ... AND (nie jest granicą klauzuli)', () => {
    test('nie rozbija BETWEEN x AND y na dwie linie', () => {
        assert.strictEqual(
            formatSql('select id from users where age between 1 and 2'),
            'SELECT id\nFROM users\nWHERE age BETWEEN 1 AND 2',
        );
    });

    test('poprawnie łączy BETWEEN z kolejnym prawdziwym AND', () => {
        assert.strictEqual(
            formatSql("select id from users where age between 1 and 2 and name = 'x'"),
            "SELECT id\nFROM users\nWHERE age BETWEEN 1 AND 2\n\tAND name = 'x'",
        );
    });

    test('obsługuje dwa BETWEEN połączone prawdziwym AND', () => {
        assert.strictEqual(
            formatSql('select id from t where a between 1 and 2 and b between 3 and 4'),
            'SELECT id\nFROM t\nWHERE a BETWEEN 1 AND 2\n\tAND b BETWEEN 3 AND 4',
        );
    });

    test('obsługuje NOT BETWEEN', () => {
        assert.strictEqual(
            formatSql('select id from t where a not between 1 and 2'),
            'SELECT id\nFROM t\nWHERE a NOT BETWEEN 1 AND 2',
        );
    });
});

suite('formatSql - ujednolicone wielkie litery pozostałych słów kluczowych', () => {
    test('uppercase DISTINCT, AS, IS NULL, LIKE, IN, NOT EXISTS jednocześnie', () => {
        assert.strictEqual(
            formatSql(
                "select distinct id as user_id from users where deleted_at is null " +
                "and name like 'a%' and id in (1,2) and not exists (select 1 from x)",
            ),
            'SELECT DISTINCT id AS user_id\nFROM users\nWHERE deleted_at IS NULL\n' +
            "\tAND name LIKE 'a%'\n\tAND id IN (1,2)\n\tAND NOT EXISTS (select 1 from x)",
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

    test('nie rusza zawartości literału tekstowego', () => {
        const result = formatSql("select id from t where note = 'this is null and not exists'");
        assert.ok(result.includes("'this is null and not exists'"));
    });

    test('nie rusza identyfikatora w cudzysłowie (backtick)', () => {
        assert.strictEqual(
            formatSql('select `desc`, `is null` from t'),
            'SELECT `desc`, `is null`\nFROM t',
        );
    });
});

suite('formatSql - słowa kluczowe wewnątrz literału tekstowego nie są granicą klauzuli', () => {
    // Bug znaleziony przy okazji naprawy BETWEEN: findClauses szukał granic klauzul
    // na surowym tekście, więc np. "where"/"and" wewnątrz stringa rozwalało formatowanie.
    test('nie rozbija stringa zawierającego słowa kluczowe SQL', () => {
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
