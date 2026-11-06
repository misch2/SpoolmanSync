import { afterEach, describe, expect, it } from 'vitest';
import { BambuBridgeError } from './api/bambu-bridge';
import { bridgeFailure } from './bambu-diagnostics';
const oldToken = process.env.BAMBU_BRIDGE_TOKEN;
afterEach(() => { if (oldToken === undefined) delete process.env.BAMBU_BRIDGE_TOKEN; else process.env.BAMBU_BRIDGE_TOKEN = oldToken; });
describe('bounded printer failure diagnostics', () => {
  it('retains actual return/rejection codes and sequence while removing unknown payloads and secrets', () => {
    process.env.BAMBU_BRIDGE_TOKEN = 'PRIVATE_TOKEN';
    const result = bridgeFailure(new BambuBridgeError('ignored', 502, { error: 'printer_rejected', sequenceId: '20001',
      diagnostics: { failureStage: 'send', backendReturnCode: -4, connectionReason: 'PRIVATE_TOKEN disconnected',
        printerReply: { result: 'fail', errCode: 42, message: 'x'.repeat(400), nested: { token: 'PRIVATE_TOKEN' } },
        arbitrary: 'SECRET_PAYLOAD' } }));
    expect(result.httpStatus).toBe(502); expect(result.sequenceId).toBe('20001');
    expect(result.diagnostics.backendReturnCode).toBe(-4);
    expect(result.diagnostics.connectionReason).toBe('[redacted] disconnected');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN'); expect(JSON.stringify(result)).not.toContain('SECRET_PAYLOAD');
    expect((result.diagnostics.printerReply as Record<string, string>).message.length).toBe(256);
  });
  it('records upstream HTTP status and native transport code without arbitrary exception text', () => {
    const error = new Error('Spoolman API error: 503 - SECRET_RESPONSE', { cause: { code: 'ECONNRESET' } });
    const result = bridgeFailure(error);
    expect(result.diagnostics.upstreamHttpStatus).toBe(503);
    expect(result.diagnostics.transportErrorCode).toBe('ECONNRESET'); expect(JSON.stringify(result)).not.toContain('SECRET_RESPONSE');
  });
});
