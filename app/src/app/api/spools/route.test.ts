import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(), getSpool: vi.fn(), unassign: vi.fn(), assign: vi.fn(),
  resolver: vi.fn(), locationSync: vi.fn(), clear: vi.fn(), sync: vi.fn(), log: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ default: { spoolmanConnection: { findFirst: mocks.findFirst } } }));
vi.mock('@/lib/api/spoolman', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/spoolman')>();
  return { ...original, SpoolmanClient: class {
    getSpool = mocks.getSpool;
    unassignSpoolFromTray = mocks.unassign;
    assignSpoolToTray = mocks.assign;
    setEntityIdResolver = mocks.resolver;
  } };
});
vi.mock('@/lib/api/homeassistant', () => ({ HomeAssistantClient: { fromConnection: vi.fn() } }));
vi.mock('@/lib/spool-location', () => ({ applyLocationSync: mocks.locationSync }));
vi.mock('@/lib/bambu-filament-sync', () => ({ clearBambuTray: mocks.clear, syncSpoolToBambuTray: mocks.sync }));
vi.mock('@/lib/activity-log', () => ({ createActivityLog: mocks.log }));

import { DELETE, POST } from './route';
const oldTray = 'X2D_SERIAL_AMS_ID_tray_4';
const diagnostics = { status: 'cleared', printer: 'X2D', entityId: 'sensor.tray_4', amsId: 0, trayId: 3, verified: true, elapsedMs: 1234, sequenceId: '20001' };
const updated = { id: 123, extra: { active_tray: JSON.stringify('') } };
function request(body: unknown, method = 'DELETE') {
  return new NextRequest('http://localhost/api/spools', { method, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findFirst.mockResolvedValue({ url: 'http://spoolman' });
  mocks.getSpool.mockResolvedValue({ id: 123, extra: { active_tray: JSON.stringify(oldTray) } });
  mocks.unassign.mockResolvedValue(updated);
  mocks.clear.mockResolvedValue(diagnostics);
});

describe('explicit unassign', () => {
  it('captures the old tray before unassign mutates it and clears only after success', async () => {
    const spool = { id: 123, extra: { active_tray: JSON.stringify(oldTray) } };
    const order: string[] = [];
    mocks.getSpool.mockImplementation(async () => { order.push('load'); return spool; });
    mocks.unassign.mockImplementation(async () => { order.push('unassign'); spool.extra.active_tray = JSON.stringify(''); return spool; });
    mocks.clear.mockImplementation(async () => { order.push('clear'); return diagnostics; });
    const response = await DELETE(request({ spoolId: 123 }));
    expect(response.status).toBe(200);
    expect(order).toEqual(['load', 'unassign', 'clear']);
    expect(mocks.clear).toHaveBeenCalledWith(oldTray);
    expect(await response.json()).toEqual({ spool, printerSync: diagnostics });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ details: { spoolId: 123, trayId: oldTray, printerSync: diagnostics } }));
  });

  it('does not clear when Spoolman unassign fails', async () => {
    mocks.unassign.mockRejectedValue(new Error('Spoolman down'));
    expect((await DELETE(request({ spoolId: 123 }))).status).toBe(500);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each(['failed', 'skipped'])('returns HTTP success and logs a %s printer result', async status => {
    const result = { ...diagnostics, status, verified: false, reason: 'Bridge unavailable' };
    mocks.clear.mockResolvedValue(result);
    const response = await DELETE(request({ spoolId: 123 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ spool: updated, printerSync: result });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ details: { spoolId: 123, trayId: oldTray, printerSync: result } }));
  });

  it('contains an unexpected clear exception without failing unassign', async () => {
    mocks.clear.mockRejectedValue(new Error('Discovery unavailable'));
    const response = await DELETE(request({ spoolId: 123 }));
    expect(response.status).toBe(200);
    const printerSync = { status: 'failed', reason: 'Discovery unavailable' };
    expect(await response.json()).toEqual({ spool: updated, printerSync });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ printerSync }) }));
  });

  it.each([undefined, JSON.stringify(''), ''])('does not clear an unassigned spool (%s)', async activeTray => {
    mocks.getSpool.mockResolvedValue({ id: 123, extra: { active_tray: activeTray } });
    const response = await DELETE(request({ spoolId: 123 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ spool: updated });
    expect(mocks.unassign).toHaveBeenCalledWith(123);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it.each([{}, { spoolId: '123' }])('validates before loading or clearing', async body => {
    expect((await DELETE(request(body))).status).toBe(400);
    expect(mocks.getSpool).not.toHaveBeenCalled();
    expect(mocks.unassign).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});

describe('assignment', () => {
  it('continues setting metadata without issuing a redundant clear', async () => {
    mocks.assign.mockResolvedValue(updated);
    mocks.sync.mockResolvedValue({ status: 'synced' });
    const response = await POST(request({ spoolId: 123, trayId: oldTray }, 'POST'));
    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(updated, oldTray);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ spool: updated, printerSync: { status: 'synced' } });
  });
});
