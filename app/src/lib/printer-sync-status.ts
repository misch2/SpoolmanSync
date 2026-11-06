// Browser-safe types and wording shared by dashboard and QR/NFC flows.
export interface PrinterSyncStatus {
  id: string;
  trayKey: string;
  spoolId: number;
  operation: string;
  status: string;
  attempts: number;
  reason?: string;
  error?: string;
  verified?: boolean;
}

export function printerSyncMessage(sync?: Partial<PrinterSyncStatus>): string {
  switch (sync?.status) {
    case 'synced': return 'Verified on printer';
    case 'cleared': return 'Cleared and verified on printer';
    case 'waiting_insertion': return sync.reason || 'Prepared — insert filament';
    case 'pending': return 'Assigned in Spoolman — waiting for printer';
    case 'syncing': return 'Synchronizing with printer';
    case 'failed': case 'expired': return sync.reason || 'Printer synchronization failed';
    case 'cancelled': return sync.reason || 'Synchronization cancelled';
    case 'skipped': return sync.reason || 'Printer synchronization skipped';
    default: return 'Assigned in Spoolman';
  }
}
