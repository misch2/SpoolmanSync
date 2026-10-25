import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient, parseExtraValue } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { applyLocationSync } from '@/lib/spool-location';
import { withAssignmentLock } from '@/lib/assignment-lock';
import { createSyncIntent, activateSyncIntent, cancelSyncIntent, prepareSpool } from '@/lib/printer-sync';
import { bridgeFailure } from '@/lib/bambu-diagnostics';

export async function GET() {
  try {
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);
    const spools = await client.getSpools();

    // Filter out archived spools
    const activeSpools = spools.filter(s => !s.archived);

    return NextResponse.json({ spools: activeSpools });
  } catch (error) {
    console.error('Error fetching spools:', error);
    return NextResponse.json({ error: 'Failed to fetch spools' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return withAssignmentLock(() => assign(request));
}
async function assign(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId, trayId, prepare = false } = body;
    if (typeof prepare !== 'boolean') return NextResponse.json({ error: 'prepare must be boolean' }, { status: 400 });

    // Validate inputs before touching Spoolman to avoid malformed requests / 500s
    if (typeof spoolId !== 'number' || !Number.isFinite(spoolId)) {
      return NextResponse.json({ error: 'spoolId is required and must be a number' }, { status: 400 });
    }
    if (typeof trayId !== 'string' || trayId.trim() === '') {
      return NextResponse.json({ error: 'trayId is required and must be a non-empty string' }, { status: 400 });
    }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let entityIdMap: Map<string, string> | null = null;
    const resolveTray = async (entityId: string) => {
      if (!entityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) entityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!entityIdMap) entityIdMap = new Map();
      }
      return entityIdMap.get(entityId) || entityId;
    };
    client.setEntityIdResolver(resolveTray);

    // Location sync (no-op unless enabled) — keep Spoolman's location field in
    // step with the tray this spool is being assigned to.
    await applyLocationSync(client);

    if (prepare) {
      try {
        const printerSync = await prepareSpool(client, spoolId, trayId);
        return NextResponse.json({ spool: await client.getSpool(spoolId), printerSync });
      } catch (error) {
        console.warn('[printer-sync]', JSON.stringify({ time: new Date().toISOString(), event: 'preparation_failed', spoolId, ...bridgeFailure(error) }));
        return NextResponse.json({ error: 'Could not prepare spool. Check bridge connection and use a regular Bambu AMS slot.' }, { status: 400 });
      }
    }
    const job = await createSyncIntent(await resolveTray(trayId), spoolId, 'set');
    let updatedSpool;
    try {
      updatedSpool = await client.assignSpoolToTray(spoolId, trayId);
    } catch {
      await cancelSyncIntent(job, 'Spoolman assignment failed');
      throw new Error('Spoolman assignment failed');
    }
    // Intent already exists if the process stops after the Spoolman commit.
    // Recovery verifies current inventory before issuing any printer command.
    let printerSync;
    try { printerSync = await activateSyncIntent(job); }
    catch { printerSync = { status: 'pending', reason: 'Assigned in Spoolman — synchronization will recover from saved intent' }; }

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Assigned spool #${spoolId} to tray ${trayId}`,
      details: { spoolId, trayId, printerSync },
    }).catch(() => console.warn('[printer-sync] Assignment activity log unavailable'));

    return NextResponse.json({ spool: updatedSpool, printerSync });
  } catch (error) {
    console.error('Error assigning spool:', error);
    return NextResponse.json({ error: 'Failed to assign spool' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  return withAssignmentLock(() => unassign(request));
}
async function unassign(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId } = body;

    // Validate inputs before touching Spoolman to avoid malformed requests / 500s
    if (typeof spoolId !== 'number' || !Number.isFinite(spoolId)) {
      return NextResponse.json({ error: 'spoolId is required and must be a number' }, { status: 400 });
    }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let deleteEntityIdMap: Map<string, string> | null = null;
    client.setEntityIdResolver(async (entityId: string) => {
      if (!deleteEntityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) deleteEntityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!deleteEntityIdMap) deleteEntityIdMap = new Map();
      }
      return deleteEntityIdMap.get(entityId) || entityId;
    });

    // Location sync (no-op unless enabled) — the guarded clear/holding-pen write
    // in unassignSpoolFromTray only applies if we set the location.
    await applyLocationSync(client);

    // Capture the old assignment before Spoolman clears active_tray.
    const spool = await client.getSpool(spoolId);
    const oldTrayKey = parseExtraValue(spool.extra?.['active_tray']);
    const job = oldTrayKey ? await createSyncIntent(oldTrayKey, spoolId, 'clear') : undefined;
    let updatedSpool;
    try { updatedSpool = await client.unassignSpoolFromTray(spoolId); }
    catch {
      if (job) await cancelSyncIntent(job, 'Spoolman unassignment failed');
      throw new Error('Spoolman unassignment failed');
    }
    let printerSync;
    if (job) {
      try { printerSync = await activateSyncIntent(job); }
      catch { printerSync = { status: 'pending', reason: 'Unassigned in Spoolman — synchronization will recover from saved intent' }; }
    }

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Unassigned spool #${spoolId} from tray`,
      details: { spoolId, trayId: oldTrayKey || undefined, printerSync },
    }).catch(() => console.warn('[printer-sync] Unassignment activity log unavailable'));

    return NextResponse.json({ spool: updatedSpool, printerSync });
  } catch (error) {
    console.error('Error unassigning spool:', error);
    return NextResponse.json({ error: 'Failed to unassign spool' }, { status: 500 });
  }
}
