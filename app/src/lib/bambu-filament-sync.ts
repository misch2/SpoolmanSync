import {
  HomeAssistantClient,
  type HATray,
} from '@/lib/api/homeassistant';
import {
  parseExtraValue,
  type Spool,
} from '@/lib/api/spoolman';

interface BambuProfile {
  id: string;
  trayType: string;
  minTemp: number;
  maxTemp: number;
}

export interface BambuFilamentSyncResult {
  status: 'synced' | 'skipped';
  reason?: string;
  printer?: string;
  entityId?: string;
  profileId?: string;
  trayType?: string;
  color?: string;
}

type FilamentWithSyncMetadata = Spool['filament'] & {
  settings_extruder_temp?: number | null;
  extra?: Record<string, string>;
};

/*
 * Bambu's stable generic filament IDs.
 *
 * These are used unless the Spoolman filament has a bambu_filament_id
 * custom field containing a more specific/custom Bambu profile ID.
 */
const GENERIC_PROFILES: Record<string, BambuProfile> = {
  PLA: {
    id: 'GFL99',
    trayType: 'PLA',
    minTemp: 190,
    maxTemp: 240,
  },
  PLAPLUS: {
    id: 'GFL99',
    trayType: 'PLA',
    minTemp: 190,
    maxTemp: 240,
  },
  PETG: {
    id: 'GFG99',
    trayType: 'PETG',
    minTemp: 220,
    maxTemp: 260,
  },
  PETGHF: {
    id: 'GFG96',
    trayType: 'PETG',
    minTemp: 230,
    maxTemp: 270,
  },
  PCTG: {
    id: 'GFG97',
    trayType: 'PCTG',
    minTemp: 240,
    maxTemp: 270,
  },
  ASA: {
    id: 'GFB98',
    trayType: 'ASA',
    minTemp: 240,
    maxTemp: 280,
  },
  TPU: {
    id: 'GFU99',
    trayType: 'TPU',
    minTemp: 190,
    maxTemp: 240,
  },
  TPU95A: {
    id: 'GFU99',
    trayType: 'TPU',
    minTemp: 190,
    maxTemp: 240,
  },
};

function normalizeMaterialKey(value: string | null | undefined): string {
  return (value || '')
    .toUpperCase()
    .replace(/\+/g, 'PLUS')
    .replace(/[^A-Z0-9]/g, '');
}

function getExtraString(
  filament: FilamentWithSyncMetadata,
  key: string,
): string | undefined {
  const raw = filament.extra?.[key];
  if (!raw) return undefined;

  const value = parseExtraValue(raw).trim();
  return value || undefined;
}

function getExtraNumber(
  filament: FilamentWithSyncMetadata,
  key: string,
): number | undefined {
  const value = getExtraString(filament, key);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Convert Spoolman's RRGGBB / RRGGBBAA color to the RRGGBBAA
 * format expected by bambu_lab.set_filament.
 */
function normalizeTrayColor(
  filament: FilamentWithSyncMetadata,
): string | null {
  let raw = filament.color_hex;

  // Bambu only accepts one tray color. For a multi-color filament use
  // the first color when no normal color_hex is available.
  if (!raw && filament.multi_color_hexes) {
    raw = filament.multi_color_hexes.split(',')[0];
  }

  if (!raw) return null;

  const hex = raw
    .trim()
    .replace(/^#/, '')
    .toUpperCase();

  if (/^[0-9A-F]{6}$/.test(hex)) {
    return `${hex}FF`;
  }

  if (/^[0-9A-F]{8}$/.test(hex)) {
    return hex;
  }

  return null;
}

function resolveProfile(
  filament: FilamentWithSyncMetadata,
): {
  profileId: string;
  trayType: string;
  minTemp: number;
  maxTemp: number;
} | null {
  const key = normalizeMaterialKey(filament.material);
  const generic = GENERIC_PROFILES[key];

  /*
   * Optional overrides stored on the FILAMENT definition in Spoolman.
   *
   * This is intentionally filament-level rather than spool-level: every
   * spool of e.g. "Elegoo Rapid PETG Space Grey" should use the same
   * Bambu profile.
   */
  const customProfileId = getExtraString(
    filament,
    'bambu_filament_id',
  );

  const customTrayType = getExtraString(
    filament,
    'bambu_tray_type',
  );

  const customMinTemp = getExtraNumber(
    filament,
    'bambu_nozzle_temp_min',
  );

  const customMaxTemp = getExtraNumber(
    filament,
    'bambu_nozzle_temp_max',
  );

  if (!customProfileId && !generic) {
    return null;
  }

  const profileId = customProfileId || generic!.id;

  const trayType =
    customTrayType ||
    generic?.trayType ||
    filament.material;

  /*
   * When using one of our Generic mappings, use Bambu's matching
   * temperature range.
   *
   * For a custom profile, explicit Spoolman extra fields win. If only
   * Spoolman's normal single extruder temperature is known, create a
   * sensible range around it.
   */
  let minTemp =
    customMinTemp ??
    generic?.minTemp;

  let maxTemp =
    customMaxTemp ??
    generic?.maxTemp;

  if (
    customProfileId &&
    filament.settings_extruder_temp != null
  ) {
    if (customMinTemp === undefined) {
      minTemp = filament.settings_extruder_temp - 20;
    }
    if (customMaxTemp === undefined) {
      maxTemp = filament.settings_extruder_temp + 20;
    }
  }

  if (
    !trayType ||
    minTemp === undefined ||
    maxTemp === undefined
  ) {
    return null;
  }

  return {
    profileId,
    trayType,
    minTemp,
    maxTemp,
  };
}

function trayMatches(
  tray: HATray,
  trayKey: string,
): boolean {
  return (
    tray.entity_id === trayKey ||
    tray.unique_id === trayKey
  );
}

/**
 * Propagate a Spoolman spool assignment into the corresponding
 * Bambu AMS/external tray.
 *
 * This function deliberately does nothing for Creality/virtual printers.
 */
export async function syncSpoolToBambuTray(
  spool: Spool,
  trayKey: string,
): Promise<BambuFilamentSyncResult> {
  const ha = await HomeAssistantClient.fromConnection();

  if (!ha) {
    return {
      status: 'skipped',
      reason: 'Home Assistant is not connected',
    };
  }

  const printers = await ha.discoverPrinters();

  let target:
    | {
        tray: HATray;
        printerName: string;
      }
    | undefined;

  for (const printer of printers) {
    if (printer.brand !== 'bambu_lab') {
      continue;
    }

    for (const ams of printer.ams_units) {
      const tray = ams.trays.find((candidate) =>
        trayMatches(candidate, trayKey),
      );

      if (tray) {
        target = {
          tray,
          printerName: printer.name,
        };
        break;
      }
    }

    if (!target) {
      const tray = printer.external_spools.find((candidate) =>
        trayMatches(candidate, trayKey),
      );

      if (tray) {
        target = {
          tray,
          printerName: printer.name,
        };
      }
    }

    if (target) {
      break;
    }
  }

  /*
   * trayKey might belong to a Creality printer or a virtual printer.
   * That is not an error.
   */
  if (!target) {
    return {
      status: 'skipped',
      reason: 'Tray is not a discovered Bambu Lab tray',
    };
  }

  const filament =
    spool.filament as FilamentWithSyncMetadata;

  const profile = resolveProfile(filament);

  if (!profile) {
    return {
      status: 'skipped',
      reason:
        `No Bambu profile mapping for material "${filament.material}"`,
      printer: target.printerName,
      entityId: target.tray.entity_id,
    };
  }

  const color = normalizeTrayColor(filament);

  if (!color) {
    return {
      status: 'skipped',
      reason: 'Spoolman filament has no valid color',
      printer: target.printerName,
      entityId: target.tray.entity_id,
    };
  }

  await ha.callService(
    'bambu_lab',
    'set_filament',
    {
      entity_id: target.tray.entity_id,
      tray_info_idx: profile.profileId,
      tray_color: color,
      tray_type: profile.trayType,
      nozzle_temp_min: profile.minTemp,
      nozzle_temp_max: profile.maxTemp,
    },
  );

  console.log(
    `[bambu-filament-sync] ${target.printerName} / ` +
      `${target.tray.entity_id}: spool #${spool.id} -> ` +
      `${profile.profileId} ${profile.trayType} ${color}`,
  );

  return {
    status: 'synced',
    printer: target.printerName,
    entityId: target.tray.entity_id,
    profileId: profile.profileId,
    trayType: profile.trayType,
    color,
  };
}