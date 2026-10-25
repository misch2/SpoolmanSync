import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAssignmentLock } from '@/lib/assignment-lock';
import { syncStatus } from '@/lib/printer-sync';

export async function GET() {
  const jobs = await prisma.printerSyncJob.findMany();
  return NextResponse.json({ jobs: jobs.map(syncStatus) });
}

export async function POST(request: NextRequest) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body || typeof body.id !== 'string' || body.id.length > 64 || !['retry', 'cancel'].includes(body.action))
    return NextResponse.json({ error: 'id and action (retry/cancel) are required' }, { status: 400 });
  return withAssignmentLock(async () => {
    const job = await prisma.printerSyncJob.findUnique({ where: { id: body.id } });
    if (!job) return NextResponse.json({ error: 'Request was superseded' }, { status: 409 });
    if (body.action === 'cancel' && !['committing', 'pending', 'syncing', 'waiting_insertion'].includes(job.state))
      return NextResponse.json({ error: 'Synchronization already completed or stopped' }, { status: 409 });
    if (body.action === 'retry' && !['failed', 'expired'].includes(job.state))
      return NextResponse.json({ error: 'Only failed or expired requests can be retried' }, { status: 409 });
    // Expired preparations must observe a new empty->present transition.
    const prepare = job.operation === 'prepare' && !['pending', 'syncing'].includes(job.state);
    const next = await prisma.printerSyncJob.update({ where: { id: body.id }, data: body.action === 'cancel'
      ? { state: 'cancelled', result: JSON.stringify({ reason: 'Cancelled by user' }) }
      : { state: prepare ? 'waiting_insertion' : 'pending', attempts: 0, sawEmpty: false, presentSince: null, presentTag: null,
          result: '{}', nextAttemptAt: new Date(), expiresAt: new Date(Date.now() + (prepare ? 15 * 60000 : 60000)) } });
    return NextResponse.json({ printerSync: syncStatus(next) });
  });
}
