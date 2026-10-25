// Offline production-container smoke: real Next server/worker/SQLite, loopback
// mock HA/Spoolman/bridge only. Never connect this script to a real printer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'printer-sync-smoke-'));
const dbPath = join(dir, 'smoke.db');
const base = 'http://127.0.0.1:39082';
const app = 'http://127.0.0.1:39081';
const key = 'X2D_TEST_AMS_UNIT_tray_4';
const env = { ...process.env, DATABASE_URL: `file:${dbPath}`, PORT: '39081', HOSTNAME: '127.0.0.1',
  BAMBU_BRIDGE_URL: `${base}/bridge`, BAMBU_BRIDGE_TOKEN: 'SMOKE_TOKEN_ONLY',
  HA_MODE: 'external', SUPERVISOR_TOKEN: '', NEXT_TELEMETRY_DISABLED: '1' };
const spool = id => ({ id, archived: false, registered: '2026-10-25', remaining_weight: 1000,
  initial_weight: 1000, used_weight: 0, extra: { active_tray: JSON.stringify(id === 12 ? key : '') },
  filament: { id, name: 'Smoke PLA', material: 'PLA', color_hex: 'FFFFFF', multi_color_hexes: null,
    multi_color_direction: null, vendor: null, diameter: 1.75, density: 1.24 } });
const spools = [spool(12), spool(13)];
let writes = 0, allowWrite = false, present = false, db, child, output = '';
const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, base).pathname;
    if (path === '/bridge/health') return send(res, { printerId: 'TEST', ready: true, connected: true, status: 'ready' });
    if (path === '/bridge/api/v1/ams/0/trays/3/filament') {
      assert.equal(req.headers.authorization, 'Bearer SMOKE_TOKEN_ONLY');
      if (req.method === 'GET') return send(res, { printerId: 'TEST', ready: true, amsId: 0, trayId: 3,
        present, reading: false, trayUuid: '00000000000000000000000000000000', gcodeState: 'IDLE',
        presentAgeMs: 0, readingAgeMs: 0, trayUuidAgeMs: 0, gcodeStateAgeMs: 0 });
      ++writes;
      if (!allowWrite) return send(res, { error: 'send_failed', diagnostics: { backendReturnCode: -4 }, sequenceId: String(20000 + writes) }, 502);
      return send(res, { status: 'synced', verified: true, sequenceId: String(20000 + writes), elapsedMs: 1, amsId: 0, trayId: 3 });
    }
    if (path === '/api/v1/spool') return send(res, spools);
    const match = /^\/api\/v1\/spool\/(\d+)$/.exec(path);
    if (match) {
      const item = spools.find(s => s.id === Number(match[1]));
      if (!item) return send(res, {}, 404);
      if (req.method === 'PATCH') { let body = ''; for await (const chunk of req) body += chunk; Object.assign(item, JSON.parse(body)); }
      return send(res, item);
    }
    if (path === '/api/states') return send(res, [
      { entity_id: 'sensor.print_status', state: 'idle', attributes: {}, last_changed: '', last_updated: '' },
      { entity_id: 'sensor.tray_4', state: 'PLA', attributes: { name: 'PLA', type: 'PLA' }, last_changed: '', last_updated: '' },
    ]);
    send(res, { error: 'unexpected_mock_route' }, 404);
  } catch (error) { send(res, { error: String(error) }, 500); }
});
const ws = new WebSocketServer({ server });
ws.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'auth_required' }));
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'auth') { socket.send(JSON.stringify({ type: 'auth_ok' })); return; }
    const entities = [
      { entity_id: 'sensor.print_status', platform: 'bambu_lab', device_id: 'printer', translation_key: 'print_status', unique_id: 'X2D_TEST_print_status', disabled_by: null },
      { entity_id: 'sensor.tray_4', platform: 'bambu_lab', device_id: 'ams', translation_key: 'tray_4', unique_id: key, disabled_by: null },
    ];
    const devices = [{ id: 'printer', name: 'Test printer', config_entry_id: 'entry' },
      { id: 'ams', name: 'X2D_TEST_AMS_1', via_device_id: 'printer' }];
    socket.send(JSON.stringify({ id: message.id, type: 'result', success: true,
      result: message.type === 'config/entity_registry/list' ? entities : devices }));
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(100); }
  throw new Error(`Smoke timeout; server output:\n${output.slice(-6000)}`);
}
const job = () => db.prepare('SELECT * FROM PrinterSyncJob WHERE trayKey=?').get(key);
async function start() {
  child = spawn('/app/entrypoint.sh', [], { cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}
async function stop() {
  const owned = child;
  if (!owned || owned.exitCode !== null) return;
  owned.kill('SIGTERM');
  await wait(() => owned.exitCode !== null || owned.signalCode !== null, 15000);
  child = undefined;
}
try {
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: '/app', env, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  db = new Database(dbPath);
  db.prepare('INSERT INTO HAConnection (id,url,accessToken,updatedAt) VALUES (?,?,?,?)').run('ha', base, 'MOCK_HA_TOKEN', Date.now());
  db.prepare('INSERT INTO SpoolmanConnection (id,url,updatedAt) VALUES (?,?,?)').run('inventory', base, Date.now());
  db.prepare('INSERT INTO PrinterSyncJob (trayKey,id,spoolId,operation,state,nextAttemptAt,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(key, 'saved-before-restart', 12, 'set', 'committing', Date.now(), Date.now() + 60000, Date.now(), Date.now());
  await new Promise(resolve => server.listen(39082, '127.0.0.1', resolve));
  await start();
  // No HTTP/browser request to the app: startup instrumentation must run it.
  await wait(() => job().attempts === 1 && job().state === 'pending');
  assert.equal(JSON.parse(job().result).diagnostics.backendReturnCode, -4);
  await stop(); allowWrite = true; await start();
  await wait(() => job().state === 'synced');
  assert.equal(job().attempts, 2); assert.equal(writes, 2);
  const firstId = job().id;
  const prepared = await fetch(`${app}/api/spools`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spoolId: 13, trayId: key, prepare: true }) });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  assert.equal((await prepared.json()).printerSync.status, 'waiting_insertion');
  assert.equal(spools[0].extra.active_tray, JSON.stringify(key));
  assert.equal(spools[1].extra.active_tray, '""');
  present = true;
  await wait(() => job().state === 'synced' && job().spoolId === 13);
  assert.equal(spools[0].extra.active_tray, '""'); assert.equal(spools[1].extra.active_tray, JSON.stringify(key));
  const stale = await fetch(`${app}/api/printer-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: firstId, action: 'retry' }) });
  assert.equal(stale.status, 409);
  assert.ok(!output.includes('SMOKE_TOKEN_ONLY')); assert.ok(!output.includes('MOCK_HA_TOKEN'));
  console.log('Offline smoke passed: startup worker, saved intent, real send diagnostics, restart retry, prepared insertion, inventory ordering, stale generation, secret-free logs');
} finally {
  await stop(); for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve));
  await new Promise(resolve => server.close(resolve)); db?.close(); rmSync(dir, { recursive: true, force: true });
}
