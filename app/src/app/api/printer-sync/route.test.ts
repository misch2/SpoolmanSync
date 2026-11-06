import { describe, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/db', () => ({ default: { printerSyncJob: { findUnique: m.find, update: m.update, findMany: m.list } } }));
vi.mock('@/lib/printer-sync', () => ({ syncStatus: (job: { state: string }) => ({ status: job.state }) }));
import { POST } from './route';
const request = (body: unknown) => new NextRequest('http://localhost/api/printer-sync', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); m.update.mockResolvedValue({ state: 'pending' }); });
describe('printer sync actions', () => {
  it.each([null, {}, { id: 'x', action: 'invalid' }])('rejects invalid action: %j', async body => {
    expect((await POST(request(body))).status).toBe(400);
  });
  it('rejects a replaced intent instead of retrying it', async () => {
    m.find.mockResolvedValue(null); expect((await POST(request({ id: 'old', action: 'retry' }))).status).toBe(409);
    expect(m.update).not.toHaveBeenCalled();
  });
  it('does not mark already verified work cancelled after waiting for the command lock', async () => {
    m.find.mockResolvedValue({ state: 'synced' });
    expect((await POST(request({ id: 'current', action: 'cancel' }))).status).toBe(409); expect(m.update).not.toHaveBeenCalled();
  });
  it('renews the retry budget without changing inventory', async () => {
    m.find.mockResolvedValue({ state: 'failed', operation: 'set' });
    expect((await POST(request({ id: 'current', action: 'retry' }))).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'pending', attempts: 0, sawEmpty: false }) }));
  });
  it('requires a fresh insertion transition when restarting an expired preparation', async () => {
    m.find.mockResolvedValue({ state: 'expired', operation: 'prepare' });
    await POST(request({ id: 'current', action: 'retry' }));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'waiting_insertion', presentSince: null, presentTag: null }) }));
  });
});
