import { randomUUID } from 'node:crypto';
import prisma from '@/lib/db';
import type { PrinterSyncJob } from '@/generated/prisma/client';
import { SpoolmanClient, normalizeTag, parseExtraValue } from '@/lib/api/spoolman';
import { BambuBridgeClient, BambuBridgeError } from '@/lib/api/bambu-bridge';
import { syncSpoolToBambuTray, clearBambuTray, resolveBambuTrayTarget } from '@/lib/bambu-filament-sync';
import { bridgeFailure, safeScalar } from '@/lib/bambu-diagnostics';
import { withAssignmentLock } from '@/lib/assignment-lock';
import { applyLocationSync } from '@/lib/spool-location';
import { isValidTrayUuid } from '@/lib/webhook-helpers';
import { spoolEvents, SPOOL_UPDATED } from '@/lib/events';
import { createActivityLog } from '@/lib/activity-log';
import type { PrinterSyncStatus } from '@/lib/printer-sync-status';

const ACTIVE = ['committing', 'pending', 'syncing', 'waiting_insertion'];
const RETRYABLE = new Set(['printer_not_ready', 'printer_busy', 'send_failed', 'bridge_unavailable',
  'bridge_timeout', 'printer_reply_timeout', 'verification_timeout', 'verification_request_failed', 'slot_state_timeout']);
const delays = [2000, 5000, 10000, 20000];
type Result = { status?: string; reason?: string; error?: string; verified?: boolean; [key: string]: unknown };

function boundedResult(result: Result): Result {
  const clean: Result = {};
  for (const field of ['status', 'reason', 'error', 'verified', 'httpStatus', 'sequenceId', 'elapsedMs', 'amsId', 'trayId']) {
    const value = safeScalar(result[field]);
    if (value !== undefined) clean[field] = value;
  }
  if (result.diagnostics) clean.diagnostics = bridgeFailure(new BambuBridgeError('', undefined, { diagnostics: result.diagnostics })).diagnostics;
  return clean;
}

export function syncStatus(job: PrinterSyncJob): PrinterSyncStatus {
  const result = JSON.parse(job.result) as Result;
  return { id: job.id, trayKey: job.trayKey, spoolId: job.spoolId, operation: job.operation,
    status: job.state, attempts: job.attempts, reason: result.reason, error: result.error,
    verified: result.verified === true && ['synced', 'cleared'].includes(job.state) };
}

function log(job: PrinterSyncJob, event: string, result: Result = {}) {
  console.log('[printer-sync]', JSON.stringify({ time: new Date().toISOString(), event,
    jobId: job.id, trayKey: job.trayKey, spoolId: job.spoolId, operation: job.operation,
    state: job.state, attempt: job.attempts, ...boundedResult(result) }));
}

async function update(job: PrinterSyncJob, data: Partial<PrinterSyncJob>, result?: Result) {
  if (result) result = boundedResult(result);
  // A stale completion cannot update a replacement job, including after restart.
  await prisma.printerSyncJob.updateMany({ where: { trayKey: job.trayKey, id: job.id },
    data: { ...data, ...(result ? { result: JSON.stringify(result) } : {}) } });
  const next = { ...job, ...data, ...(result ? { result: JSON.stringify(result) } : {}) };
  if (data.state && data.state !== job.state || result?.error && JSON.stringify(result) !== job.result) log(next, 'transition', result);
  spoolEvents.emit(SPOOL_UPDATED, { type: 'tray_change', trayId: job.trayKey, timestamp: Date.now() });
  return next;
}

async function finish(job: PrinterSyncJob, state: string, result: Result) {
  const next = await update(job, { state }, result);
  // Logging must never change the outcome of a successful inventory mutation.
  try {
    await createActivityLog({ type: 'printer_sync', message: `Printer sync ${state}: spool #${job.spoolId}`,
      details: { jobId: job.id, trayId: job.trayKey, attempts: job.attempts, ...boundedResult(result) } });
  } catch { console.warn('[printer-sync] Activity log unavailable'); }
  return next;
}

export async function createSyncIntent(trayKey: string, spoolId: number, operation: string,
  state = 'committing', baseline = '{}') {
  const now = new Date();
  const data = { id: randomUUID(), spoolId, operation, state, baseline,
    attempts: 0, sawEmpty: false, presentSince: null, presentTag: null, result: '{}',
    createdAt: now, nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + (operation === 'prepare' ? 15 * 60000 : 60000)) };
  const job = await prisma.printerSyncJob.upsert({ where: { trayKey },
    create: { trayKey, ...data }, update: data });
  log(job, 'created');
  return job;
}

export async function activateSyncIntent(job: PrinterSyncJob) {
  return syncStatus(await update(job, { state: 'pending' }));
}

export async function cancelSyncIntent(job: PrinterSyncJob, reason: string) {
  return syncStatus(await finish(job, 'cancelled', { reason }));
}

export async function prepareSpool(client: SpoolmanClient, spoolId: number, trayKey: string) {
  const resolution = await resolveBambuTrayTarget(trayKey);
  if (!('target' in resolution) || resolution.target.external || resolution.amsId < 0 || resolution.amsId > 3)
    throw new Error('Preparation requires a discovered regular Bambu AMS slot (AMS 0–3)');
  const canonical = resolution.target.tray.unique_id || resolution.target.tray.entity_id;
  const bridge = BambuBridgeClient.fromEnvironment();
  if (!bridge) throw new Error('Bambu bridge is not configured');
  const health = await bridge.getHealth();
  if (health.printerId.toUpperCase() !== resolution.target.printerId.toUpperCase())
    throw new Error('Bambu bridge controls a different printer');
  let sawEmpty = false;
  if (health.ready && health.connected) {
    try {
      const state = await bridge.getSlotState(resolution.amsId, resolution.trayId);
      if (state.printerId.toUpperCase() !== resolution.target.printerId.toUpperCase())
        throw new BambuBridgeError('Printer identity mismatch', 409, { error: 'printer_identity_mismatch' });
      sawEmpty = state.ready && state.present === false && state.presentAgeMs >= 0 && state.presentAgeMs <= 6000;
    } catch (error) {
      if (!(error instanceof BambuBridgeError) || !RETRYABLE.has(bridgeFailure(error).error)) throw error;
    }
  }
  const spool = await client.getSpool(spoolId);
  if (spool.archived) throw new Error('Archived spool cannot be prepared');
  const spools = await client.getSpools();
  const targetIds = spools.filter(s => [canonical, resolution.target.tray.entity_id].includes(parseExtraValue(s.extra?.active_tray)))
    .map(s => s.id).sort((a, b) => a - b);
  const job = await createSyncIntent(canonical, spoolId, 'prepare', 'waiting_insertion',
    JSON.stringify({ previousTray: parseExtraValue(spool.extra?.active_tray), targetIds }));
  return syncStatus(sawEmpty ? await update(job, { sawEmpty: true }) : job);
}

async function retryOrFail(job: PrinterSyncJob, result: Result) {
  const state = RETRYABLE.has(result.error || '') ? 'pending' : result.status === 'skipped' ? 'skipped' : 'failed';
  if (state !== 'pending') return finish(job, state, result);
  return update(job, { state, nextAttemptAt: new Date(Math.min(job.expiresAt.getTime(), Date.now() +
    delays[Math.min(Math.max(0, job.attempts - 1), delays.length - 1)] * (0.95 + Math.random() * 0.1))) }, result);
}

// Called under the same lock as assignment/unassignment and tray-change webhooks.
export async function processSyncJob(job: PrinterSyncJob) {
  const current = await prisma.printerSyncJob.findUnique({ where: { trayKey: job.trayKey } });
  if (!current || current.id !== job.id || !ACTIVE.includes(current.state)) return;
  job = current;
  if (Date.now() >= job.expiresAt.getTime()) {
    await finish(job, 'expired', { reason: 'Synchronization expired — retry or prepare the spool again' });
    return;
  }
  const connection = await prisma.spoolmanConnection.findFirst();
  if (!connection) { await finish(job, 'failed', { error: 'spoolman_not_configured' }); return; }
  const client = new SpoolmanClient(connection.url);
  let stage = 'inventory_read';
  try {
    const spool = await client.getSpool(job.spoolId);
    const spools = await client.getSpools();
    stage = 'tray_discovery';
    const resolution = await resolveBambuTrayTarget(job.trayKey);
    if (!('target' in resolution)) {
      if (resolution.error === 'unsupported_printer') { await finish(job, 'skipped', { ...resolution }); return; }
      // HA/discovery may be temporarily unavailable. Do not discard an intent.
      await update(job, { nextAttemptAt: new Date(Date.now() + 5000) }, { reason: resolution.reason });
      return;
    }
    const { target, amsId, trayId } = resolution;
    const keys = [job.trayKey, target.tray.entity_id, target.tray.unique_id];
    const assigned = keys.includes(parseExtraValue(spool.extra?.active_tray));
    const occupants = spools.filter(s => keys.includes(parseExtraValue(s.extra?.active_tray)));
    if (job.operation === 'prepare' && job.state === 'waiting_insertion') {
      const baseline = JSON.parse(job.baseline) as { previousTray: string; targetIds: number[] };
      if (spool.archived || parseExtraValue(spool.extra?.active_tray) !== baseline.previousTray ||
          JSON.stringify(occupants.map(s => s.id).sort((a, b) => a - b)) !== JSON.stringify(baseline.targetIds)) {
        await finish(job, 'cancelled', { reason: 'Assignment changed after preparation' }); return;
      }
      const bridge = BambuBridgeClient.fromEnvironment();
      if (!bridge) { await finish(job, 'failed', { error: 'bridge_not_configured' }); return; }
      stage = 'slot_state';
      const state = await bridge.getSlotState(amsId, trayId);
      if (state.printerId.toUpperCase() !== target.printerId.toUpperCase()) {
        await finish(job, 'failed', { error: 'printer_identity_mismatch' }); return;
      }
      const fresh = (age: number) => age >= 0 && age <= 6000;
      if (!state.ready || !fresh(state.presentAgeMs) || state.present === null) {
        await update(job, { presentSince: null, nextAttemptAt: new Date(Date.now() + 2000) },
          { reason: 'Waiting for fresh filament presence telemetry' }); return;
      }
      if (!state.present) {
        await update(job, { sawEmpty: true, presentSince: null, nextAttemptAt: new Date(Date.now() + 2000) },
          { reason: 'Prepared — insert filament' }); return;
      }
      if (!job.sawEmpty) {
        await update(job, { presentSince: null, nextAttemptAt: new Date(Date.now() + 2000) },
          { reason: 'Prepared — remove previous filament, then insert this spool' }); return;
      }
      if (state.reading !== false || !fresh(state.readingAgeMs) || !fresh(state.trayUuidAgeMs) || state.trayUuid === null ||
          !fresh(state.gcodeStateAgeMs) || !['IDLE', 'FINISH', 'FAILED'].includes(state.gcodeState || '')) {
        await update(job, { presentSince: null, nextAttemptAt: new Date(Date.now() + 2000) },
          { reason: 'Waiting for RFID reading to finish and printer to become idle' }); return;
      }
      const tag = normalizeTag(state.trayUuid);
      const expectedTag = normalizeTag(spool.extra?.tag);
      if (isValidTrayUuid(state.trayUuid) && (expectedTag && expectedTag !== tag ||
          spools.some(s => s.id !== spool.id && normalizeTag(s.extra?.tag) === tag))) {
        await finish(job, 'failed', { error: 'rfid_conflict', reason: 'Inserted RFID spool differs from prepared spool' }); return;
      }
      if (!job.presentSince || job.presentTag !== tag) {
        await update(job, { presentSince: new Date(), presentTag: tag, nextAttemptAt: new Date(Date.now() + 2000) }); return;
      }
      if (Date.now() - job.presentSince.getTime() < 2000) return;
      // Commit intent before the external mutation. After a crash, 'committing'
      // is reconciled against Spoolman; it is never blindly reassigned.
      job = await update(job, { state: 'committing', operation: 'set', expiresAt: new Date(Date.now() + 60000) });
      await applyLocationSync(client);
      client.setEntityIdResolver(async key => keys.includes(key) ? job.trayKey : key);
      stage = 'inventory_assignment';
      await client.assignSpoolToTray(job.spoolId, job.trayKey);
      job = await update(job, { state: 'pending' });
    } else {
      if (spool.archived || job.operation !== 'clear' && !assigned ||
          job.operation === 'clear' && occupants.length > 0) {
        await finish(job, 'cancelled', { reason: 'A newer inventory assignment superseded this request' }); return;
      }
    }
    // Prepared jobs that already activated are normal SETs. A crash in the
    // external inventory operation is checked above on the next worker pass.
    job = await update(job, { state: 'syncing', attempts: job.attempts + 1 });
    stage = 'inventory_recheck';
    const latestSpool = await client.getSpool(job.spoolId);
    const latestOccupants = (await client.getSpools()).filter(s => keys.includes(parseExtraValue(s.extra?.active_tray)));
    if (job.operation === 'clear' ? latestOccupants.length > 0 :
        !keys.includes(parseExtraValue(latestSpool.extra?.active_tray)) || latestOccupants.some(s => s.id !== job.spoolId)) {
      await finish(job, 'cancelled', { reason: 'Inventory changed before printer write' }); return;
    }
    stage = 'printer_write';
    const result = job.operation === 'clear' ? await clearBambuTray(job.trayKey)
      : await syncSpoolToBambuTray(latestSpool, job.trayKey);
    const detail = { ...result } as Result;
    if (result.verified === true && (result.status === 'synced' || result.status === 'cleared'))
      await finish(job, result.status, detail);
    else await retryOrFail(job, detail);
  } catch (error) {
    const failure = bridgeFailure(error);
    failure.diagnostics.clientStage = stage;
    if (failure.diagnostics.upstreamService === 'Spoolman' && failure.diagnostics.upstreamHttpStatus === 404) {
      await finish(job, 'cancelled', { ...failure, reason: 'Spool no longer exists in Spoolman' }); return;
    }
    if (!(error instanceof BambuBridgeError)) {
      // Includes transient HA/Spoolman failures. No raw Error or URL is logged.
      failure.error = 'bridge_unavailable';
      failure.reason = 'Inventory or discovery unavailable; will retry';
    }
    if (job.state === 'waiting_insertion' && RETRYABLE.has(failure.error))
      await update(job, { presentSince: null, nextAttemptAt: new Date(Date.now() + 5000) }, failure);
    else await retryOrFail(job, failure);
  }
}

export async function runPrinterSyncOnce() {
  const jobs = await prisma.printerSyncJob.findMany({ where: {
    state: { in: ACTIVE }, OR: [{ nextAttemptAt: { lte: new Date() } }, { expiresAt: { lte: new Date() } }] }, orderBy: { nextAttemptAt: 'asc' } });
  for (const job of jobs) await withAssignmentLock(() => processSyncJob(job));
}

const worker = globalThis as typeof globalThis & { printerSyncWorker?: { stopped: boolean; timer?: ReturnType<typeof setTimeout> } };
export function startPrinterSyncWorker() {
  if (worker.printerSyncWorker) return;
  const state = { stopped: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  worker.printerSyncWorker = state;
  let unavailable = false;
  const tick = async () => {
    try {
      await runPrinterSyncOnce();
      if (unavailable) console.log('[printer-sync] Worker/database recovered');
      unavailable = false;
    }
    catch {
      if (!unavailable) console.error('[printer-sync] Worker/database unavailable; retrying');
      unavailable = true;
    }
    if (!state.stopped) { state.timer = setTimeout(tick, 1000); state.timer.unref(); }
  };
  state.timer = setTimeout(tick, 1000);
  state.timer.unref();
  const stop = () => { state.stopped = true; clearTimeout(state.timer); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
