import {
  HomeAssistantClient,
  type HATray,
} from '@/lib/api/homeassistant';

import {
  BambuBridgeClient,
} from '@/lib/api/bambu-bridge';

import {
  parseExtraValue,
  type Spool,
} from '@/lib/api/spoolman';

interface BambuProfile {
  id: string;
  trayType: string;
  minTemp: number;
  maxTemp: number;

  // Bambu setting_id is printer/nozzle-profile specific.
  settingIdByModel: Record<string, string>;
}

interface ResolvedBambuProfile {
  profileId: string;
  settingId: string;
  trayType: string;
  minTemp: number;
  maxTemp: number;
}

export interface BambuFilamentSyncResult {
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;

  printer?: string;
  entityId?: string;

  profileId?: string;
  settingId?: string;
  trayType?: string;
  color?: string;

  amsId?: number;
  trayId?: number;

  verified?: boolean;
  elapsedMs?: number;
  sequenceId?: string;
}

type FilamentWithSyncMetadata =
  Spool['filament'] & {
    settings_extruder_temp?: number | null;
    extra?: Record<string, string>;
  };

/*
 * Generic Bambu filament IDs plus the matching X2D 0.4 mm
 * system preset setting_ids.
 *
 * The filament ID itself is stable across printers. setting_id is not,
 * which is why the mapping is explicitly model-specific.
 */
const GENERIC_PROFILES:
  Record<string, BambuProfile> = {
  PLA: {
    id: 'GFL99',
    trayType: 'PLA',
    minTemp: 190,
    maxTemp: 240,
    settingIdByModel: {
      X2D: 'GFSL99_17',
    },
  },

  PLAPLUS: {
    id: 'GFL99',
    trayType: 'PLA',
    minTemp: 190,
    maxTemp: 240,
    settingIdByModel: {
      X2D: 'GFSL99_17',
    },
  },

  PETG: {
    id: 'GFG99',
    trayType: 'PETG',
    minTemp: 220,
    maxTemp: 260,
    settingIdByModel: {
      X2D: 'GFSG99_15',
    },
  },

  PETGHF: {
    id: 'GFG96',
    trayType: 'PETG',
    minTemp: 230,
    maxTemp: 270,
    settingIdByModel: {
      X2D: 'GFSG96_14',
    },
  },

  PCTG: {
    id: 'GFG97',
    trayType: 'PCTG',
    minTemp: 240,
    maxTemp: 270,
    settingIdByModel: {
      X2D: 'GFSG97_06',
    },
  },

  ASA: {
    id: 'GFB98',
    trayType: 'ASA',
    minTemp: 240,
    maxTemp: 280,
    settingIdByModel: {
      X2D: 'GFSB98_14',
    },
  },

  TPU: {
    id: 'GFU99',
    trayType: 'TPU',
    minTemp: 190,
    maxTemp: 240,
    settingIdByModel: {
      X2D: 'GFSU99_03',
    },
  },

  TPU95A: {
    id: 'GFU99',
    trayType: 'TPU',
    minTemp: 190,
    maxTemp: 240,
    settingIdByModel: {
      X2D: 'GFSU99_03',
    },
  },
};

function normalizeMaterialKey(
  value: string | null | undefined,
): string {
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

  if (!raw) {
    return undefined;
  }

  const value =
    parseExtraValue(raw).trim();

  return value || undefined;
}

function getExtraNumber(
  filament: FilamentWithSyncMetadata,
  key: string,
): number | undefined {
  const value =
    getExtraString(filament, key);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : undefined;
}

function normalizeTrayColor(
  filament: FilamentWithSyncMetadata,
): string | null {
  let raw = filament.color_hex;

  if (
    !raw &&
    filament.multi_color_hexes
  ) {
    raw =
      filament.multi_color_hexes
        .split(',')[0];
  }

  if (!raw) {
    return null;
  }

  const hex = raw
    .trim()
    .replace(/^#/, '')
    .toUpperCase();

  if (/^[0-9A-F]{6}$/.test(hex)) {
    return `${hex}FF`;
  }

  if (/^[0-9A-F]{8}$/.test(hex)) {
    // Preserve Spoolman's alpha byte.
    return hex;
  }

  return null;
}

function resolveProfile(
  filament: FilamentWithSyncMetadata,
  printerModel: string,
): {
  profile?: ResolvedBambuProfile;
  reason?: string;
} {
  const key =
    normalizeMaterialKey(
      filament.material,
    );

  const generic =
    GENERIC_PROFILES[key];

  const customProfileId =
    getExtraString(
      filament,
      'bambu_filament_id',
    );

  const customSettingId =
    getExtraString(
      filament,
      'bambu_setting_id',
    );

  const customTrayType =
    getExtraString(
      filament,
      'bambu_tray_type',
    );

  const customMinTemp =
    getExtraNumber(
      filament,
      'bambu_nozzle_temp_min',
    );

  const customMaxTemp =
    getExtraNumber(
      filament,
      'bambu_nozzle_temp_max',
    );

  if (!customProfileId && !generic) {
    return {
      reason:
        `No Bambu profile mapping for material "${filament.material}"`,
    };
  }

  /*
   * A custom filament_id must be accompanied by its actual Bambu
   * preset setting_id. Pairing a custom profile with a Generic
   * setting_id would produce inconsistent printer metadata.
   */
  if (
    customProfileId &&
    !customSettingId
  ) {
    return {
      reason:
        'Custom bambu_filament_id requires bambu_setting_id',
    };
  }

  const profileId =
    customProfileId ||
    generic!.id;

  const settingId =
    customSettingId ||
    generic?.settingIdByModel[
    printerModel.toUpperCase()
    ];

  if (!settingId) {
    return {
      reason:
        `No Bambu setting_id mapping for ${printerModel} / ` +
        `${filament.material}`,
    };
  }

  const trayType =
    customTrayType ||
    generic?.trayType ||
    filament.material;

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
    if (
      customMinTemp === undefined
    ) {
      minTemp =
        filament.settings_extruder_temp -
        20;
    }

    if (
      customMaxTemp === undefined
    ) {
      maxTemp =
        filament.settings_extruder_temp +
        20;
    }
  }

  if (
    !trayType ||
    minTemp === undefined ||
    maxTemp === undefined
  ) {
    return {
      reason:
        'Incomplete Bambu filament profile metadata',
    };
  }

  return {
    profile: {
      profileId,
      settingId,
      trayType,
      minTemp,
      maxTemp,
    },
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

/*
 * HAPrinter.prefix normally comes from the Bambu unique_id:
 *
 *   X2D_20P5BJ660701399_print_status
 *        ↓
 *   x2d_20p5bj660701399
 *
 * Keep this as a fallback only. For a specific tray, its own
 * unique_id is a better source of printer identity.
 */
function parsePrinterIdentity(
  prefix: string,
): {
  model: string;
  printerId: string;
} | null {
  const separator =
    prefix.indexOf('_');

  if (
    separator <= 0 ||
    separator >= prefix.length - 1
  ) {
    return null;
  }

  return {
    model:
      prefix
        .slice(0, separator)
        .toUpperCase(),

    printerId:
      prefix
        .slice(separator + 1)
        .toUpperCase(),
  };
}

/*
 * Bambu tray unique_ids start with:
 *
 *   X2D_20P5BJ660701399_AMS_...
 *   X2D_20P5BJ660701399_ExternalSpool_...
 *
 * The first two components therefore give us the printer model
 * and serial without depending on the printer entity prefix.
 */
function parsePrinterIdentityFromTray(
  tray: HATray,
): {
  model: string;
  printerId: string;
} | null {
  const uniqueId =
    tray.unique_id;

  if (!uniqueId) {
    return null;
  }

  const parts =
    uniqueId.split('_');

  if (
    parts.length < 2 ||
    !parts[0] ||
    !parts[1]
  ) {
    return null;
  }

  return {
    model:
      parts[0].toUpperCase(),

    printerId:
      parts[1].toUpperCase(),
  };
}

/*
 * HA's ams_number:
 *
 * regular AMS: 1..4
 * firmware:    0..3
 *
 * AMS HT IDs 128+ already match firmware IDs.
 */
function toBambuAmsId(
  amsNumber: number,
): number {
  return amsNumber >= 128
    ? amsNumber
    : amsNumber - 1;
}

export async function syncSpoolToBambuTray(
  spool: Spool,
  trayKey: string,
): Promise<BambuFilamentSyncResult> {
  const ha =
    await HomeAssistantClient
      .fromConnection();

  if (!ha) {
    return {
      status: 'skipped',
      reason:
        'Home Assistant is not connected',
    };
  }

  const printers =
    await ha.discoverPrinters();

  let target:
    | {
      tray: HATray;
      printerName: string;
      printerModel: string;
      printerId: string;
      amsNumber?: number;
      external: boolean;
    }
    | undefined;

  for (const printer of printers) {
    if (
      printer.brand !==
      'bambu_lab'
    ) {
      continue;
    }

    /*
     * Do not reject the whole printer just because its prefix
     * cannot be parsed. We can derive identity from the tray's
     * stable unique_id after finding the requested tray.
     */
    const prefixIdentity =
      parsePrinterIdentity(
        printer.prefix,
      );

    for (
      const ams of
      printer.ams_units
    ) {
      const tray =
        ams.trays.find(
          (candidate) =>
            trayMatches(
              candidate,
              trayKey,
            ),
        );

      if (tray) {
        const identity =
          parsePrinterIdentityFromTray(
            tray,
          ) ||
          prefixIdentity;

        if (!identity) {
          console.warn(
            `[bambu-filament-sync] Found tray ${trayKey}, ` +
            `but could not determine printer identity`,
          );

          continue;
        }

        target = {
          tray,
          printerName:
            printer.name,
          printerModel:
            identity.model,
          printerId:
            identity.printerId,
          amsNumber:
            ams.ams_number,
          external: false,
        };

        break;
      }
    }

    if (!target) {
      const tray =
        printer.external_spools.find(
          (candidate) =>
            trayMatches(
              candidate,
              trayKey,
            ),
        );

      if (tray) {
        const identity =
          parsePrinterIdentityFromTray(
            tray,
          ) ||
          prefixIdentity;

        if (!identity) {
          console.warn(
            `[bambu-filament-sync] Found external tray ${trayKey}, ` +
            `but could not determine printer identity`,
          );

          continue;
        }

        target = {
          tray,
          printerName:
            printer.name,
          printerModel:
            identity.model,
          printerId:
            identity.printerId,
          external: true,
        };
      }
    }

    if (target) {
      break;
    }
  }

  if (!target) {
    /*
     * Keep enough discovery detail in the add-on log to diagnose
     * unique_id/entity_id mismatches without enabling broad debug logging.
     */
    const discoveredTrays: string[] = [];

    for (const printer of printers) {
      if (
        printer.brand !==
        'bambu_lab'
      ) {
        continue;
      }

      for (
        const ams of
        printer.ams_units
      ) {
        for (const tray of ams.trays) {
          discoveredTrays.push(
            `${printer.name}:` +
            `AMS${ams.ams_number}/tray${tray.tray_number}` +
            ` entity=${tray.entity_id}` +
            ` unique=${tray.unique_id || '<none>'}`,
          );
        }
      }

      for (
        const tray of
        printer.external_spools
      ) {
        discoveredTrays.push(
          `${printer.name}:external` +
          ` entity=${tray.entity_id}` +
          ` unique=${tray.unique_id || '<none>'}`,
        );
      }
    }

    console.warn(
      `[bambu-filament-sync] Tray "${trayKey}" not found. ` +
      `Discovered Bambu trays: ` +
      (
        discoveredTrays.length > 0
          ? discoveredTrays.join(' | ')
          : '<none>'
      ),
    );

    return {
      status: 'skipped',
      reason:
        'Tray is not a discovered Bambu Lab tray',
    };
  }

  /*
   * External spool IDs are 255/254 on current dual-extruder
   * Bambu printers. Do not guess the HA External 1/2 → right/left
   * mapping until it has been verified on the X2D.
   */
  if (target.external) {
    return {
      status: 'skipped',
      reason:
        'Bambu bridge external spool sync is not enabled yet',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
    };
  }

  if (
    target.amsNumber === undefined ||
    target.tray.tray_number < 1
  ) {
    return {
      status: 'failed',
      reason:
        'Invalid Bambu AMS/tray addressing',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
    };
  }

  const filament =
    spool.filament as
    FilamentWithSyncMetadata;

  const profileResolution =
    resolveProfile(
      filament,
      target.printerModel,
    );

  if (!profileResolution.profile) {
    return {
      status: 'skipped',
      reason:
        profileResolution.reason ||
        'No Bambu profile mapping',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
    };
  }

  const profile =
    profileResolution.profile;

  const color =
    normalizeTrayColor(
      filament,
    );

  if (!color) {
    return {
      status: 'skipped',
      reason:
        'Spoolman filament has no valid color',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
    };
  }

  const bridge =
    BambuBridgeClient
      .fromEnvironment();

  if (!bridge) {
    return {
      status: 'skipped',
      reason:
        'Bambu bridge is not configured (BAMBU_BRIDGE_URL)',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
    };
  }

  const amsId =
    toBambuAmsId(
      target.amsNumber,
    );

  const trayId =
    target.tray.tray_number - 1;

  try {
    const health =
      await bridge.getHealth();

    if (
      !health.ready ||
      !health.connected
    ) {
      return {
        status: 'failed',
        reason:
          health.reconnecting
            ? 'Bambu bridge is reconnecting to the printer'
            : 'Bambu bridge printer is not ready',
        printer:
          target.printerName,
        entityId:
          target.tray.entity_id,
        amsId,
        trayId,
      };
    }

    if (
      health.printerId
        .toUpperCase() !==
      target.printerId
        .toUpperCase()
    ) {
      return {
        status: 'skipped',
        reason:
          `Bambu bridge controls printer ${health.printerId}, ` +
          `but tray belongs to ${target.printerId}`,
        printer:
          target.printerName,
        entityId:
          target.tray.entity_id,
      };
    }

    const result =
      await bridge.setFilament(
        amsId,
        trayId,
        {
          profile:
            profile.profileId,
          setting:
            profile.settingId,
          type:
            profile.trayType,
          color,
          tempMin:
            profile.minTemp,
          tempMax:
            profile.maxTemp,
        },
      );

    console.log(
      `[bambu-filament-sync] ${target.printerName} / ` +
      `${target.tray.entity_id}: spool #${spool.id} -> ` +
      `${profile.profileId}/${profile.settingId} ` +
      `${profile.trayType} ${color}; ` +
      `AMS ${amsId}/${trayId}; verified in ${result.elapsedMs} ms`,
    );

    return {
      status: 'synced',
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
      profileId:
        profile.profileId,
      settingId:
        profile.settingId,
      trayType:
        profile.trayType,
      color,
      amsId,
      trayId,
      verified:
        result.verified,
      elapsedMs:
        result.elapsedMs,
      sequenceId:
        result.sequenceId,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : 'Unknown Bambu bridge error';

    console.warn(
      `[bambu-filament-sync] ${target.printerName}: ${reason}`,
    );

    return {
      status: 'failed',
      reason,
      printer:
        target.printerName,
      entityId:
        target.tray.entity_id,
      profileId:
        profile.profileId,
      settingId:
        profile.settingId,
      trayType:
        profile.trayType,
      color,
      amsId,
      trayId,
    };
  }
}