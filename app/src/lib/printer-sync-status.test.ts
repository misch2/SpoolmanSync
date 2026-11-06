import { describe, expect, it } from 'vitest';
import { printerSyncMessage } from './printer-sync-status';

describe('printer removal messages', () => {
  it('keeps inventory removal distinct from pending printer work', () => {
    expect(printerSyncMessage({ operation: 'clear', status: 'pending' }))
      .toBe('Removed from Spoolman — waiting to clear printer');
  });

  it('explains explicit rejection without implying inventory removal failed', () => {
    expect(printerSyncMessage({ operation: 'clear', status: 'failed', error: 'printer_rejected', reason: 'Bambu bridge: printer_rejected' }))
      .toBe('Removed from Spoolman — printer rejected metadata clear');
  });

  it('reports an already-empty slot without claiming a verified write', () => {
    expect(printerSyncMessage({ operation: 'clear', status: 'skipped', reason: 'Printer slot already empty; no clear needed' }))
      .toBe('Removed from Spoolman — Printer slot already empty; no clear needed');
  });

  it('preserves assignment wording', () => {
    expect(printerSyncMessage({ operation: 'set', status: 'pending' })).toBe('Assigned in Spoolman — waiting for printer');
  });
});
