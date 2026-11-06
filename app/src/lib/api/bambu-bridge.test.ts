import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BambuBridgeClient } from './bambu-bridge';

const cleared = { status: 'cleared', verified: true, elapsedMs: 1234, sequenceId: '20001', amsId: 0, trayId: 3 };
const fetchMock = vi.fn();
const client = new BambuBridgeClient('http://bridge:8000/', ' secret ');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('BambuBridgeClient.getSlotState metadata observations', () => {
  const state = { printerId: 'TEST', ready: true, amsId: 0, trayId: 3,
    present: false, reading: false, trayUuid: '', gcodeState: 'IDLE',
    presentAgeMs: 0, readingAgeMs: 0, trayUuidAgeMs: 0, gcodeStateAgeMs: 0 };

  it.each([true, false, null])('accepts metadataCleared=%s with its observation age', async metadataCleared => {
    const body = { ...state, metadataCleared, metadataClearedAgeMs: 10 };
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await client.getSlotState(0, 3)).toEqual(body);
  });

  it('accepts older responses without metadata observations', async () => {
    fetchMock.mockResolvedValue(Response.json(state));
    expect(await client.getSlotState(0, 3)).toEqual(state);
  });

  it.each([
    { metadataCleared: true }, { metadataClearedAgeMs: 0 },
    { metadataCleared: 'true', metadataClearedAgeMs: 0 },
    { metadataCleared: true, metadataClearedAgeMs: -2 },
    { metadataCleared: true, metadataClearedAgeMs: 0.5 },
  ])('rejects malformed metadata observations: %j', async extra => {
    fetchMock.mockResolvedValue(Response.json({ ...state, ...extra }));
    await expect(client.getSlotState(0, 3)).rejects.toMatchObject({ response: { error: 'invalid_slot_state' } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BambuBridgeClient.clearFilament', () => {
  it('sends DELETE to the addressed filament endpoint with Bearer auth and no body', async () => {
    fetchMock.mockResolvedValue(Response.json(cleared));
    expect(await client.clearFilament(0, 3)).toEqual(cleared);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://bridge:8000/api/v1/ams/0/trays/3/filament');
    expect(init.method).toBe('DELETE');
    expect(init.headers.get('Authorization')).toBe('Bearer secret');
    expect(init).not.toHaveProperty('body');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([{ ...cleared, status: 'synced' }, { ...cleared, verified: false }])('rejects an unverified or wrong-status result', async body => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(client.clearFilament(0, 3)).rejects.toMatchObject({ name: 'BambuBridgeError', message: 'Bambu bridge did not verify the filament clear', httpStatus: 200, response: body });
  });

  it.each([{ error: 'printer_not_ready' }, {}])('rejects non-2xx responses', async body => {
    fetchMock.mockResolvedValue(Response.json(body, { status: 503 }));
    await expect(client.clearFilament(0, 3)).rejects.toMatchObject({ name: 'BambuBridgeError', httpStatus: 503, response: body });
  });

  it('rejects invalid JSON consistently', async () => {
    fetchMock.mockResolvedValue(new Response('invalid'));
    await expect(client.clearFilament(0, 3)).rejects.toThrow('invalid JSON');
  });

  it('wraps network errors', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    await expect(client.clearFilament(0, 3)).rejects.toMatchObject({ name: 'BambuBridgeError', response: { error: 'bridge_unavailable' } });
  });

  it.each(['clear', 'set'])('uses the same 12-second timeout for %s', async operation => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = operation === 'clear' ? client.clearFilament(254, 0) : client.setFilament(254, 0, { profile: 'GFL99', setting: 'GFSL99_17', type: 'PLA', color: 'FFFFFFFF', tempMin: 190, tempMax: 240 });
    const assertion = expect(pending).rejects.toThrow('Bambu bridge request timed out after 12000 ms');
    await vi.advanceTimersByTimeAsync(11999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
