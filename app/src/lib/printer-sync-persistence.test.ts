import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

describe('printer sync SQLite migration and recovery', () => {
  it('persists intent/diagnostics across client restart and rejects old generation updates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spoolmansync-intent-'));
    const url = join(directory, 'test.db');
    const connect = () => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    let client = connect();
    try {
      const migration = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261025190000_printer_sync/migration.sql', import.meta.url)), 'utf8');
      for (const statement of migration.split(';').filter(s => s.trim())) await client.$executeRawUnsafe(statement);
      const intent = await client.printerSyncJob.create({ data: { trayKey: 'TEST/0/3', spoolId: 12,
        operation: 'set', state: 'committing', expiresAt: new Date(Date.now() + 60000),
        result: JSON.stringify({ error: 'send_failed', diagnostics: { backendReturnCode: -4 } }) } });
      await client.$disconnect(); client = connect();
      const restored = await client.printerSyncJob.findUniqueOrThrow({ where: { trayKey: 'TEST/0/3' } });
      expect(restored.id).toBe(intent.id); expect(restored.state).toBe('committing');
      expect(restored.expiresAt).toBeInstanceOf(Date);
      expect(JSON.parse(restored.result).diagnostics.backendReturnCode).toBe(-4);
      await client.printerSyncJob.update({ where: { trayKey: restored.trayKey }, data: { id: 'new-intent', spoolId: 13 } });
      expect((await client.printerSyncJob.updateMany({ where: { trayKey: restored.trayKey, id: intent.id }, data: { state: 'synced' } })).count).toBe(0);
      expect((await client.printerSyncJob.findUniqueOrThrow({ where: { trayKey: restored.trayKey } })).spoolId).toBe(13);
    } finally { await client.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
  });
});
