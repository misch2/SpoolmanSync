import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BambuBridgeClient, BambuBridgeError } from './bambu-bridge';

const cleared = { status: 'cleared', verified: true, elapsedMs: 1234, sequenceId: '20001', amsId: 0, trayId: 3 };
const fetchMock = vi.fn();
const client = new BambuBridgeClient('http://bridge:8000/', ' secret ');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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
    await expect(client.clearFilament(0, 3)).rejects.toThrow(new BambuBridgeError('Bambu bridge request failed: Connection refused'));
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
