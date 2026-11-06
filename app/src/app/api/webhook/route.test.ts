import { describe, beforeEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ find: vi.fn(), assign: vi.fn(), unassign: vi.fn() }));
vi.mock('@/lib/db', () => ({ default: { spoolmanConnection: { findFirst: async () => ({ url: 'http://inventory' }) }, printerSyncJob: { findUnique: m.find } } }));
vi.mock('@/lib/api/spoolman', async original => ({ ...await original<typeof import('@/lib/api/spoolman')>(), SpoolmanClient: class {
  getSpools = async () => []; assignSpoolToTray = m.assign; unassignSpoolFromTray = m.unassign; setEntityIdResolver() {}
} }));
vi.mock('@/lib/api/homeassistant', () => ({ HomeAssistantClient: { fromConnection: async () => ({ getTrayEntityRegistry: async () => new Map([
  ['sensor.tray_4', { uniqueId: 'X2D_TEST_AMS_UNIT_tray_4', platform: 'bambu_lab' }],
]) }) } }));
vi.mock('@/lib/webhook-secret', () => ({ isWebhookAuthEnabled: async () => false, getWebhookSecret: vi.fn(), tokensMatch: vi.fn(), WEBHOOK_TOKEN_HEADER: 'x-test-token' }));
vi.mock('@/lib/spool-location', () => ({ applyLocationSync: vi.fn() }));
vi.mock('@/lib/activity-log', () => ({ createActivityLog: vi.fn() }));
vi.mock('@/lib/alerts', () => ({ checkAndUpdateAlerts: vi.fn() }));
vi.mock('@/lib/printer-sync', () => ({ syncStatus: () => ({ status: 'waiting_insertion' }) }));
import { POST } from './route';
beforeEach(() => { vi.clearAllMocks(); m.find.mockResolvedValue({ operation: 'prepare', state: 'waiting_insertion', expiresAt: new Date(Date.now() + 60000) }); });
describe('tray change during a prepared insertion', () => {
  it.each(['Empty', 'PLA'])('preserves the preparation and old inventory when name is %s', async name => {
    const response = await POST(new NextRequest('http://localhost/api/webhook', { method: 'POST', body: JSON.stringify({
      event: 'tray_change', tray_entity_id: 'sensor.tray_4', name, tray_uuid: 'ABCD', material: 'PLA',
    }) }));
    expect(response.status).toBe(200); expect((await response.json()).status).toBe('pending');
    expect(m.assign).not.toHaveBeenCalled(); expect(m.unassign).not.toHaveBeenCalled();
  });
});
