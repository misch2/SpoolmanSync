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
  if (sync?.operation === 'clear') {
    switch (sync.status) {
      case 'pending': return 'Removed from Spoolman — waiting to clear printer';
      case 'syncing': return 'Removed from Spoolman — clearing printer metadata';
      case 'cleared': return 'Removed from Spoolman — cleared and verified on printer';
      case 'failed': case 'expired':
        return sync.error === 'printer_rejected'
          ? 'Removed from Spoolman — printer rejected metadata clear'
          : `Removed from Spoolman — ${sync.reason || 'printer metadata clear failed'}`;
      case 'skipped': return `Removed from Spoolman — ${sync.reason || 'printer clear skipped'}`;
      case 'cancelled': return `Removed from Spoolman — ${sync.reason || 'printer clear cancelled'}`;
    }
  }
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
