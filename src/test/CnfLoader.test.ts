import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CnfLoader } from '../db/CnfLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// CnfLoader — tylko znane opcje liczbowe/logiczne wolno konwertować z typu string;
// hasła, nazwy użytkowników, hostów i baz muszą zawsze pozostać stringiem.
// ─────────────────────────────────────────────────────────────────────────────

async function withTempCnf(content: string, run: (filePath: string) => Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-client-cnf-'));
    const filePath = path.join(dir, 'test.cnf');
    fs.writeFileSync(filePath, content, 'utf-8');
    try {
        await run(filePath);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

suite('CnfLoader', () => {

    test('does not strip leading zeros from a numeric-looking password', async () => {
        await withTempCnf(
            '[client]\npassword = 001234\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.password, '001234');
            }
        );
    });

    test('does not convert a password of "true"/"false" into a boolean', async () => {
        await withTempCnf(
            '[client]\npassword = true\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.password, 'true');
                assert.strictEqual(typeof opts.password, 'string');
            }
        );
    });

    test('keeps user/host/database as strings even if numeric-looking', async () => {
        await withTempCnf(
            '[client]\nuser = 12345\nhost = 127.0.0.1\ndatabase = 007\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.user, '12345');
                assert.strictEqual(opts.host, '127.0.0.1');
                assert.strictEqual(opts.database, '007');
            }
        );
    });

    test('still converts known numeric options like port', async () => {
        await withTempCnf(
            '[client]\nport = 3306\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.port, 3306);
                assert.strictEqual(typeof opts.port, 'number');
            }
        );
    });

    test('still converts known boolean options like reconnect', async () => {
        await withTempCnf(
            '[client]\nreconnect = true\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.reconnect, true);
            }
        );
    });

    test('skip-ssl=true disables ssl', async () => {
        await withTempCnf(
            '[client]\nskip-ssl = true\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.ssl, false);
            }
        );
    });

    test('skip-ssl=false enables ssl', async () => {
        await withTempCnf(
            '[client]\nskip-ssl = false\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.ssl, true);
            }
        );
    });

    test('"#" starts an inline comment mid-line, per real MySQL/MariaDB option-file syntax', async () => {
        await withTempCnf(
            '[client]\ndatabase =  # your database name\nhost = 127.0.0.1 # local machine\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.database, '');
                assert.strictEqual(opts.host, '127.0.0.1');
            }
        );
    });

    test('a quoted value protects a literal "#" from being treated as a comment', async () => {
        await withTempCnf(
            '[client]\npassword = "my#pass" # not part of the password\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.password, 'my#pass');
            }
        );
    });

    test('parses production and readonly as booleans from the [db-client] section', async () => {
        await withTempCnf(
            '[client]\nhost = 127.0.0.1\n\n[db-client]\nproduction = true\nreadonly = true\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                assert.strictEqual(opts.production, true);
                assert.strictEqual(opts.readonly, true);
            }
        );
    });

    test('does not choke if production/readonly are mistakenly left in [client] (they are just ignored there)', async () => {
        await withTempCnf(
            '[client]\nhost = 127.0.0.1\nproduction = true\n',
            async (filePath) => {
                const opts = await CnfLoader.getOptionsFromCnf(filePath);
                // Celowo NIE oczekujemy opts.production === true - ta opcja działa
                // tylko w sekcji [db-client], nie w [client] (żeby ten sam plik dało
                // się nadal użyć jako --defaults-file dla prawdziwego klienta mysql/mariadb).
                assert.strictEqual(opts.production, undefined);
            }
        );
    });
});
