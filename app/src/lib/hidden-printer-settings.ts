import prisma from '@/lib/db';
import type { HiddenPrinterRecord } from '@/lib/hidden-printers';

// Shared helpers cannot be exported from a Next.js route module: generated
// route types permit only HTTP handlers and supported route configuration.
export async function loadHiddenPrinterRecords(): Promise<HiddenPrinterRecord[]> {
  const setting = await prisma.settings.findUnique({ where: { key: 'hidden_printers' } });
  if (!setting) return [];
  try {
    const parsed = JSON.parse(setting.value);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return parsed.map((id: string) => ({ entryId: id, title: '' }));
    }
    return parsed;
  } catch { return []; }
}
