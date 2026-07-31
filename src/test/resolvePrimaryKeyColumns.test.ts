import * as assert from 'assert';
import {
    findColumnIndex,
    resolvePrimaryKeyColumns,
    resolveTableColumns,
    MetaFieldLike,
} from '../sql/resolvePrimaryKeyColumns.js';

// symuluje pole z wyniku SELECT (mysql2 FieldPacket ma orgTable()/orgName() jako metody, nie właściwości)
function meta(table: string, name: string): MetaFieldLike {
    return {
        orgTable: () => table,
        orgName: () => name,
    };
}

suite('findColumnIndex', () => {
    test('znajduje kolumnę po nazwie tabeli źródłowej i oryginalnej nazwie kolumny', () => {
        const row = [meta('products', 'id'), meta('products', 'sku'), meta('categories', 'name')];
        assert.strictEqual(findColumnIndex(row, 'products', 'sku'), 1);
        assert.strictEqual(findColumnIndex(row, 'categories', 'name'), 2);
    });

    test('nie myli kolumn o tej samej nazwie z różnych tabel (join)', () => {
        // products.name i categories.name - ta sama nazwa kolumny, różne tabele źródłowe
        const row = [meta('products', 'id'), meta('products', 'name'), meta('categories', 'name')];
        assert.strictEqual(findColumnIndex(row, 'categories', 'name'), 2);
    });

    test('zwraca -1 gdy kolumna w ogóle nie występuje w wynikach', () => {
        const row = [meta('products', 'id'), meta('products', 'sku')];
        assert.strictEqual(findColumnIndex(row, 'products', 'price'), -1);
    });
});

suite('resolvePrimaryKeyColumns', () => {
    test('pojedynczy PK - znajduje kolumnę mimo że select ją duplikuje (np. p.id, p.*)', () => {
        // SELECT p.id, p.sku, c.name, p.* -> p.id i p.sku pojawiają się w meta dwukrotnie
        const row = [
            meta('products', 'id'),
            meta('products', 'sku'),
            meta('categories', 'name'),
            meta('products', 'id'),
            meta('products', 'sku'),
            meta('products', 'price'),
        ];

        const result = resolvePrimaryKeyColumns(row, 'products', ['id']);

        assert.strictEqual(result.missingNames.length, 0);
        assert.strictEqual(result.found.length, 1);
        assert.strictEqual(result.found[0].name, 'id');
        assert.strictEqual(result.found[0].index, 0); // pierwsze wystąpienie, nie drugie (index 3)
    });

    test('PK złożony - znajduje obie kolumny nawet przy duplikatach w select', () => {
        // tabela order_items z PK (order_id, product_id), select duplikuje product_id przez item.*
        const row = [
            meta('order_items', 'order_id'),
            meta('order_items', 'product_id'),
            meta('order_items', 'quantity'),
            meta('order_items', 'product_id'),
        ];

        const result = resolvePrimaryKeyColumns(row, 'order_items', ['order_id', 'product_id']);

        assert.strictEqual(result.missingNames.length, 0);
        assert.deepStrictEqual(
            result.found.map((c) => [c.name, c.index]),
            [['order_id', 0], ['product_id', 1]]
        );
    });

    test('zgłasza jako brakującą kolumnę PK, której nie ma wcale w wynikach SELECT', () => {
        // select nie zawiera product_id wcale, tylko order_id
        const row = [meta('order_items', 'order_id'), meta('order_items', 'quantity')];

        const result = resolvePrimaryKeyColumns(row, 'order_items', ['order_id', 'product_id']);

        assert.strictEqual(result.found.length, 1);
        assert.deepStrictEqual(result.missingNames, ['product_id']);
    });

    test('nie znajduje kolumny PK po samej nazwie, jeśli należy do innej tabeli (join z kolizją nazw)', () => {
        // orders.id i customers.id - ta sama nazwa, PK szukany dla "orders"
        const row = [meta('customers', 'id'), meta('customers', 'email')];

        const result = resolvePrimaryKeyColumns(row, 'orders', ['id']);

        assert.strictEqual(result.found.length, 0);
        assert.deepStrictEqual(result.missingNames, ['id']);
    });
});

suite('resolveTableColumns', () => {
    test('zwraca tylko kolumny danej tabeli, pomijając kolumny z innych tabel i wyliczane (bez orgName)', () => {
        const countStar: MetaFieldLike = { orgTable: () => '', orgName: () => '' }; // np. COUNT(*)
        const row = [
            meta('products', 'id'),
            meta('products', 'sku'),
            meta('categories', 'name'),
            countStar,
        ];

        const columns = resolveTableColumns(row, 'products');

        assert.deepStrictEqual(columns.map((c) => c.name), ['id', 'sku']);
    });

    test('deduplikuje kolumny o tej samej nazwie - wygrywa pierwsze wystąpienie', () => {
        // SELECT p.id, p.sku, p.* - p.id i p.sku występują w meta dwukrotnie
        const row = [
            meta('products', 'id'),
            meta('products', 'sku'),
            meta('products', 'id'),
            meta('products', 'sku'),
            meta('products', 'price'),
        ];

        const columns = resolveTableColumns(row, 'products');

        assert.deepStrictEqual(columns.map((c) => c.name), ['id', 'sku', 'price']);
        assert.deepStrictEqual(columns.map((c) => c.index), [0, 1, 4]); // pierwsze wystąpienia + jedyne wystąpienie price
    });
});
