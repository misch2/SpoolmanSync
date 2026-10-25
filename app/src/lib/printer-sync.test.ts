import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PrinterSyncJob } from '@/generated/prisma/client';
import type { Spool } from '@/lib/api/spoolman';

const m = vi.hoisted(() => ({
  jobs: new Map<string, PrinterSyncJob>(), getSpool: vi.fn(), getSpools: vi.fn(), assign: vi.fn(),
  resolve: vi.fn(), sync: vi.fn(), clear: vi.fn(), slot: vi.fn(), health: vi.fn(), log: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ default: {
  spoolmanConnection: { findFirst: vi.fn(async () => ({ url: 'http://inventory' })) },
  printerSyncJob: {
    upsert: vi.fn(async ({ where, create, update }) => {
      const row = m.jobs.has(where.trayKey) ? { ...m.jobs.get(where.trayKey), ...update } : create;
      m.jobs.set(where.trayKey, row); return row;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const row = m.jobs.get(where.trayKey);
      if (!row || row.id !== where.id) return { count: 0 };
      m.jobs.set(where.trayKey, { ...row, ...data }); return { count: 1 };
    }),
    findUnique: vi.fn(async ({ where }) => m.jobs.get(where.trayKey) || null),
    findMany: vi.fn(async () => [...m.jobs.values()].filter(j => ['committing', 'pending', 'syncing', 'waiting_insertion'].includes(j.state) && j.nextAttemptAt <= new Date())),
  },
} }));
vi.mock('@/lib/api/spoolman', async original => ({ ...await original<typeof import('@/lib/api/spoolman')>(),
  SpoolmanClient: class {
    getSpool = m.getSpool; getSpools = m.getSpools; assignSpoolToTray = m.assign;
    setEntityIdResolver = vi.fn();
  },
}));
vi.mock('@/lib/bambu-filament-sync', () => ({ resolveBambuTrayTarget: m.resolve,
  syncSpoolToBambuTray: m.sync, clearBambuTray: m.clear }));
vi.mock('@/lib/api/bambu-bridge', async original => ({ ...await original<typeof import('@/lib/api/bambu-bridge')>(),
  BambuBridgeClient: { fromEnvironment: () => ({ getSlotState: m.slot, getHealth: m.health }) },
}));
vi.mock('@/lib/spool-location', () => ({ applyLocationSync: vi.fn() }));
vi.mock('@/lib/activity-log', () => ({ createActivityLog: m.log }));
import { BambuBridgeError } from '@/lib/api/bambu-bridge';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { createSyncIntent, processSyncJob, runPrinterSyncOnce, prepareSpool } from './printer-sync';
import { withAssignmentLock } from './assignment-lock';

const key = 'X2D_TEST_AMS_UNIT_tray_4';
const spool = (): Spool => ({ id: 12, archived: false, extra: { active_tray: JSON.stringify(key) },
  filament: { id: 1, name: 'Test', material: 'PLA', color_hex: 'FFFFFF', vendor: null,
    density: 1.24, diameter: 1.75, multi_color_hexes: null, multi_color_direction: null },
  registered: '2026-10-25', remaining_weight: 1000, used_weight: 0, initial_weight: 1000 });
const current = () => m.jobs.get(key)!;
const state = (extra = {}) => ({ printerId: 'TEST', ready: true, amsId: 0, trayId: 3,
  present: false, reading: false, trayUuid: '00000000000000000000000000000000', gcodeState: 'IDLE',
  presentAgeMs: 0, readingAgeMs: 0, trayUuidAgeMs: 0, gcodeStateAgeMs: 0, ...extra });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T19:00:00Z')); vi.clearAllMocks(); m.jobs.clear();
  m.getSpool.mockResolvedValue(spool()); m.getSpools.mockResolvedValue([spool()]);
  m.assign.mockImplementation(async () => {
    m.getSpool.mockResolvedValue(spool()); m.getSpools.mockResolvedValue([spool()]); return spool();
  });
  m.resolve.mockResolvedValue({ target: { printerId: 'TEST', external: false,
    tray: { entity_id: 'sensor.tray_4', unique_id: key } }, amsId: 0, trayId: 3 });
  m.health.mockResolvedValue({ printerId: 'TEST' }); m.slot.mockResolvedValue(state());
  m.sync.mockResolvedValue({ status: 'synced', verified: true, sequenceId: '20001' });
  m.clear.mockResolvedValue({ status: 'cleared', verified: true }); m.log.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('durable printer synchronization', () => {
  it('retains a failed send and its real diagnostic, then completes a later attempt', async () => {
    const failure = { status: 'failed', error: 'send_failed', diagnostics: { backendReturnCode: -4 }, sequenceId: '20000' };
    m.sync.mockResolvedValueOnce(failure);
    await createSyncIntent(key, 12, 'set');
    await runPrinterSyncOnce();
    expect(current().state).toBe('pending'); expect(current().attempts).toBe(1);
    expect(JSON.parse(current().result)).toEqual(failure);
    vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(current().state).toBe('synced'); expect(current().attempts).toBe(2);
    expect(m.sync).toHaveBeenCalledTimes(2);
  });
  it.each(['printer_not_ready', 'printer_busy', 'printer_reply_timeout', 'verification_timeout'])('bounds retry of %s by expiry', async error => {
    m.sync.mockResolvedValue({ status: 'failed', error }); await createSyncIntent(key, 12, 'set');
    await runPrinterSyncOnce(); expect(current().state).toBe('pending');
    vi.setSystemTime(current().expiresAt); await runPrinterSyncOnce();
    expect(current().state).toBe('expired'); expect(m.sync).toHaveBeenCalledTimes(1);
  });
  it('does not retry explicit rejection or accept unverified success', async () => {
    m.sync.mockResolvedValue({ status: 'failed', error: 'printer_rejected', verified: false });
    await createSyncIntent(key, 12, 'set'); await runPrinterSyncOnce(); await runPrinterSyncOnce();
    expect(current().state).toBe('failed'); expect(m.sync).toHaveBeenCalledTimes(1);
    m.sync.mockResolvedValue({ status: 'synced', verified: false });
    await createSyncIntent(key, 12, 'set'); await runPrinterSyncOnce(); expect(current().state).toBe('failed');
  });
  it('rejects stale job generations', async () => {
    const old = await createSyncIntent(key, 12, 'set');
    await createSyncIntent(key, 13, 'set'); await processSyncJob(old);
    expect(m.sync).not.toHaveBeenCalled(); expect(current().spoolId).toBe(13);
  });
  it('cancels SET when the spool was moved elsewhere', async () => {
    m.getSpool.mockResolvedValue({ ...spool(), extra: { active_tray: JSON.stringify('other') } });
    await createSyncIntent(key, 12, 'set'); await runPrinterSyncOnce();
    expect(current().state).toBe('cancelled'); expect(m.sync).not.toHaveBeenCalled();
  });
  it('never clears a newly occupied slot or a failed unassignment recovered after restart', async () => {
    await createSyncIntent(key, 12, 'clear'); await runPrinterSyncOnce();
    expect(current().state).toBe('cancelled'); expect(m.clear).not.toHaveBeenCalled();
  });
  it('recovers a committed unassignment and clears only the empty inventory target', async () => {
    m.getSpool.mockResolvedValue({ ...spool(), extra: { active_tray: '""' } }); m.getSpools.mockResolvedValue([]);
    await createSyncIntent(key, 12, 'clear'); await runPrinterSyncOnce();
    expect(current().state).toBe('cleared'); expect(m.clear).toHaveBeenCalledWith(key);
  });
  it('recovers an interrupted SET without repeating the inventory mutation', async () => {
    const job = await createSyncIntent(key, 12, 'set'); m.jobs.set(key, { ...job, state: 'syncing' });
    await runPrinterSyncOnce(); expect(current().state).toBe('synced'); expect(m.assign).not.toHaveBeenCalled();
  });
  it('serializes local inventory changes with an in-flight printer operation', async () => {
    const order: string[] = []; let release!: () => void;
    const first = withAssignmentLock(async () => { order.push('write'); await new Promise<void>(r => { release = r; }); order.push('verified'); });
    const second = withAssignmentLock(async () => { order.push('replacement'); });
    await Promise.resolve(); expect(order).toEqual(['write']); release(); await Promise.all([first, second]);
    expect(order).toEqual(['write', 'verified', 'replacement']);
  });
});

async function prepared() {
  m.getSpool.mockResolvedValue({ ...spool(), extra: { active_tray: '""' } }); m.getSpools.mockResolvedValue([]);
  await prepareSpool(new SpoolmanClient('http://inventory'), 12, key);
}
describe('prepared spool insertion', () => {
  it('captures an already empty slot before returning, allowing immediate insertion', async () => {
    m.health.mockResolvedValue({ printerId: 'TEST', ready: true, connected: true });
    await prepared(); expect(current().sawEmpty).toBe(true);
    m.slot.mockResolvedValue(state({ present: true })); await runPrinterSyncOnce();
    expect(m.assign).not.toHaveBeenCalled();
    vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(current().state).toBe('synced');
  });
  it('keeps inventory unchanged until an empty->present transition settles', async () => {
    await prepared();
    m.slot.mockResolvedValue(state({ present: true })); await runPrinterSyncOnce();
    expect(m.assign).not.toHaveBeenCalled(); expect(current().sawEmpty).toBe(false);
    m.slot.mockResolvedValue(state()); vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(current().sawEmpty).toBe(true);
    m.slot.mockResolvedValue(state({ present: true })); vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(m.assign).not.toHaveBeenCalled();
    vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(m.assign).toHaveBeenCalledWith(12, key); expect(current().operation).toBe('set'); expect(current().state).toBe('synced');
  });
  it.each([{ present: null }, { present: true, reading: true }, { present: true, reading: null },
    { present: true, presentAgeMs: 6001 }, { present: true, gcodeState: 'RUNNING' },
    { present: true, trayUuid: null }])('waits safely for usable telemetry: %j', async extra => {
    await prepared(); await runPrinterSyncOnce();
    m.slot.mockResolvedValue(state(extra)); vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(m.assign).not.toHaveBeenCalled(); expect(m.sync).not.toHaveBeenCalled(); expect(current().state).toBe('waiting_insertion');
  });
  it('stops on RFID conflict', async () => {
    await prepared(); await runPrinterSyncOnce();
    m.getSpools.mockResolvedValue([{ ...spool(), id: 99, extra: { active_tray: '""', tag: 'ABCD' } }]);
    m.slot.mockResolvedValue(state({ present: true, trayUuid: 'ABCD' }));
    vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(current().state).toBe('failed'); expect(JSON.parse(current().result).error).toBe('rfid_conflict');
    expect(m.assign).not.toHaveBeenCalled();
  });
  it('preserves preparation across a bridge disconnect and rejects another printer', async () => {
    await prepared(); m.slot.mockRejectedValueOnce(new BambuBridgeError('offline'));
    await runPrinterSyncOnce(); expect(current().state).toBe('waiting_insertion');
    m.slot.mockResolvedValue(state({ printerId: 'OTHER' })); vi.setSystemTime(current().nextAttemptAt); await runPrinterSyncOnce();
    expect(current().state).toBe('failed'); expect(m.assign).not.toHaveBeenCalled();
  });
  it('cancels if the prepared spool is reassigned elsewhere', async () => {
    await prepared(); m.getSpool.mockResolvedValue(spool()); await runPrinterSyncOnce();
    expect(current().state).toBe('cancelled'); expect(m.assign).not.toHaveBeenCalled();
  });
});
