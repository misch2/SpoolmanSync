import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ findFirst: vi.fn(), getSpool: vi.fn(), unassign: vi.fn(), assign: vi.fn(),
  create: vi.fn(), activate: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/db', () => ({ default: { spoolmanConnection: { findFirst: m.findFirst } } }));
vi.mock('@/lib/api/spoolman', async original => ({ ...await original<typeof import('@/lib/api/spoolman')>(),
  SpoolmanClient: class { getSpool = m.getSpool; unassignSpoolFromTray = m.unassign; assignSpoolToTray = m.assign; setEntityIdResolver = vi.fn(); } }));
vi.mock('@/lib/api/homeassistant', () => ({ HomeAssistantClient: { fromConnection: vi.fn() } }));
vi.mock('@/lib/spool-location', () => ({ applyLocationSync: vi.fn() }));
vi.mock('@/lib/printer-sync', () => ({ createSyncIntent: m.create, activateSyncIntent: m.activate, cancelSyncIntent: m.cancel, prepareSpool: m.prepare }));
vi.mock('@/lib/activity-log', () => ({ createActivityLog: m.log }));
import { DELETE, POST } from './route';
const key = 'X2D_TEST_AMS_UNIT_tray_4';
const job = { id: 'job', trayKey: key, state: 'committing' };
const pending = { id: 'job', status: 'pending' };
const spool = { id: 12, extra: { active_tray: JSON.stringify(key) } };
const unassigned = { id: 12, extra: { active_tray: '""' } };
function request(body: unknown, method = 'DELETE') { return new NextRequest('http://localhost/api/spools', { method, body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.resetAllMocks(); m.findFirst.mockResolvedValue({ url: 'http://inventory' }); m.getSpool.mockResolvedValue(spool);
  m.unassign.mockResolvedValue(unassigned); m.assign.mockResolvedValue(spool);
  m.create.mockResolvedValue(job); m.activate.mockResolvedValue(pending); m.cancel.mockResolvedValue({ status: 'cancelled' }); m.log.mockResolvedValue(undefined);
});
describe('durable assignment API', () => {
  it('saves intent before assignment and activates afterward, without CLEAR', async () => {
    const order: string[] = [];
    m.create.mockImplementation(async () => { order.push('intent'); return job; });
    m.assign.mockImplementation(async () => { order.push('assign'); return spool; });
    m.activate.mockImplementation(async () => { order.push('activate'); return pending; });
    const response = await POST(request({ spoolId: 12, trayId: key }, 'POST'));
    expect(response.status).toBe(200); expect(order).toEqual(['intent', 'assign', 'activate']);
    expect(m.create).toHaveBeenCalledWith(key, 12, 'set');
    expect(await response.json()).toEqual({ spool, printerSync: pending });
  });
  it('never changes inventory when intent persistence fails', async () => {
    m.create.mockRejectedValue(new Error('database unavailable'));
    expect((await POST(request({ spoolId: 12, trayId: key }, 'POST'))).status).toBe(500);
    expect(m.assign).not.toHaveBeenCalled();
  });
  it('cancels an intent if assignment fails', async () => {
    m.assign.mockRejectedValue(new Error('inventory unavailable'));
    expect((await POST(request({ spoolId: 12, trayId: key }, 'POST'))).status).toBe(500);
    expect(m.cancel).toHaveBeenCalled(); expect(m.activate).not.toHaveBeenCalled();
  });
  it('keeps successful inventory commit successful if activation or activity logging fails', async () => {
    m.activate.mockRejectedValue(new Error('database unavailable')); m.log.mockRejectedValue(new Error('log unavailable'));
    const response = await POST(request({ spoolId: 12, trayId: key }, 'POST'));
    expect(response.status).toBe(200); expect((await response.json()).printerSync.status).toBe('pending');
  });
  it('prepares without setting the active spool', async () => {
    m.prepare.mockResolvedValue({ status: 'waiting_insertion' });
    const response = await POST(request({ spoolId: 12, trayId: key, prepare: true }, 'POST'));
    expect(response.status).toBe(200); expect(m.prepare).toHaveBeenCalled(); expect(m.assign).not.toHaveBeenCalled();
  });
});
describe('durable explicit unassign', () => {
  it('captures old tray and activates CLEAR only after successful Spoolman unassign', async () => {
    const order: string[] = [];
    m.create.mockImplementation(async () => { order.push('intent'); return job; });
    m.unassign.mockImplementation(async () => { order.push('unassign'); return unassigned; });
    m.activate.mockImplementation(async () => { order.push('activate'); return pending; });
    const response = await DELETE(request({ spoolId: 12 }));
    expect(response.status).toBe(200); expect(order).toEqual(['intent', 'unassign', 'activate']);
    expect(m.create).toHaveBeenCalledWith(key, 12, 'clear');
    expect(await response.json()).toEqual({ spool: unassigned, printerSync: pending });
  });
  it('does not activate CLEAR if unassign failed', async () => {
    m.unassign.mockRejectedValue(new Error('failed'));
    expect((await DELETE(request({ spoolId: 12 }))).status).toBe(500);
    expect(m.activate).not.toHaveBeenCalled(); expect(m.cancel).toHaveBeenCalled();
  });
  it.each([undefined, '""', ''])('does not queue CLEAR for unassigned spool (%s)', async active_tray => {
    m.getSpool.mockResolvedValue({ id: 12, extra: { active_tray } });
    expect((await DELETE(request({ spoolId: 12 }))).status).toBe(200); expect(m.create).not.toHaveBeenCalled();
  });
  it('preserves success when queue activation fails', async () => {
    m.activate.mockRejectedValue(new Error('failed'));
    const response = await DELETE(request({ spoolId: 12 }));
    expect(response.status).toBe(200); expect((await response.json()).printerSync.status).toBe('pending');
  });
  it.each([{}, { spoolId: '12' }])('validates before mutation: %j', async body => {
    expect((await DELETE(request(body))).status).toBe(400); expect(m.create).not.toHaveBeenCalled(); expect(m.unassign).not.toHaveBeenCalled();
  });
});
