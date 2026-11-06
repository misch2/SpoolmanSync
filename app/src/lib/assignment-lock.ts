// Shared across Next.js route bundles and the instrumentation worker. All local
// inventory changes and printer attempts use the same lock, including webhooks.
// A deployment must run one server process per persistent SQLite volume.
const shared = globalThis as typeof globalThis & { assignmentTail?: Promise<void> };

export async function withAssignmentLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = shared.assignmentTail || Promise.resolve();
  let release!: () => void;
  shared.assignmentTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}
