import { BambuBridgeError } from '@/lib/api/bambu-bridge';

// Never persist arbitrary response bodies, fetch URLs, headers or stack traces.
const fields = ['failureStage', 'backendReturnCode', 'backendException', 'connectionStatus',
  'connectionReason', 'replyReceived', 'replyAccepted', 'freshStatuses', 'targetSeen',
  'printerStateAgeMs', 'reason', 'mismatchedFields', 'transportErrorCode',
  'clientStage', 'upstreamService', 'upstreamHttpStatus', 'exceptionName'] as const;
const groups: Record<string, string[]> = {
  printerReply: ['result', 'reason', 'errCode', 'errno', 'code', 'message', 'msg'],
  printerState: ['gcode_state', 'ams_status', 'print_error'],
};

export function safeScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') {
    for (const secret of [process.env.BAMBU_BRIDGE_TOKEN, process.env.HA_TOKEN]) {
      if (secret) value = (value as string).split(secret).join('[redacted]');
    }
    return (value as string).slice(0, 256);
  }
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) return value as number | boolean | null;
}

export function bridgeFailure(error: unknown) {
  const typed = error instanceof BambuBridgeError ? error : undefined;
  const response = typed?.response;
  const code = typeof response?.error === 'string' && /^[a-z_]{1,64}$/.test(response.error)
    ? response.error : typed?.httpStatus ? 'bridge_http_error' : typed ? 'bridge_unavailable' : 'sync_internal_error';
  const diagnostics: Record<string, unknown> = {};
  const source = response?.diagnostics;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const input = source as Record<string, unknown>;
    for (const field of fields) {
      const value = safeScalar(input[field]);
      if (value !== undefined) diagnostics[field] = value;
    }
    for (const [group, names] of Object.entries(groups)) {
      const values = input[group];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const filtered: Record<string, unknown> = {};
      for (const name of names) {
        const value = safeScalar((values as Record<string, unknown>)[name]);
        if (value !== undefined) filtered[name] = value;
      }
      diagnostics[group] = filtered;
    }
  }
  if (!typed && error instanceof Error) {
    diagnostics.exceptionName = /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
    const http = /^(Spoolman|HA) API error: (\d{3})\b/.exec(error.message);
    if (http) { diagnostics.upstreamService = http[1]; diagnostics.upstreamHttpStatus = Number(http[2]); }
    if (error.cause && typeof error.cause === 'object' && 'code' in error.cause &&
        typeof error.cause.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.cause.code))
      diagnostics.transportErrorCode = error.cause.code;
  }
  return {
    error: code,
    httpStatus: typed?.httpStatus,
    sequenceId: typeof response?.sequenceId === 'string' && /^\d{1,24}$/.test(response.sequenceId) ? response.sequenceId : undefined,
    diagnostics,
    reason: typed ? `Bambu bridge: ${code}` : 'Printer synchronization failed; see server log',
  };
}
