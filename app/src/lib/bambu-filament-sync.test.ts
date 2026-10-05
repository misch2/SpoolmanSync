import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Spool } from './api/spoolman';

const {
  fromConnection,
  discoverPrinters,

  bridgeFromEnvironment,
  bridgeGetHealth,
  bridgeSetFilament,
} = vi.hoisted(() => ({
  fromConnection: vi.fn(),
  discoverPrinters: vi.fn(),

  bridgeFromEnvironment: vi.fn(),
  bridgeGetHealth: vi.fn(),
  bridgeSetFilament: vi.fn(),
}));

vi.mock('@/lib/api/homeassistant', () => ({
  HomeAssistantClient: {
    fromConnection,
  },
}));

vi.mock('@/lib/api/bambu-bridge', () => ({
  BambuBridgeClient: {
    fromEnvironment:
      bridgeFromEnvironment,
  },
}));

const {
  syncSpoolToBambuTray,
} = await import('./bambu-filament-sync');

const PRINTER_ID =
  '20P5BJ660701399';

const TRAY_ENTITY =
  'sensor.barca_x2d_ams_1_tray_4';

const TRAY_UNIQUE_ID =
  'X2D_20P5BJ660701399_AMS_19C51A6516003GQ_tray_4';

const EXTERNAL_LEFT_ENTITY =
  'sensor.barca_x2d_external_spool';

const EXTERNAL_LEFT_UNIQUE_ID =
  'X2D_20P5BJ660701399_ExternalSpool_external_spool';

const EXTERNAL_RIGHT_ENTITY =
  'sensor.barca_x2d_external_spool_2';

const EXTERNAL_RIGHT_UNIQUE_ID =
  'X2D_20P5BJ660701399_ExternalSpool2_external_spool';

function bambuPrinter() {
  return {
    brand: 'bambu_lab',
    entity_id:
      'sensor.barca_x2d_print_status',
    name: 'Barča',
    state: 'idle',

    /*
     * Real HA discovery derives this from:
     *
     * X2D_<serial>_print_status
     *          ↓
     * x2d_<serial>
     */
    prefix:
      `x2d_${PRINTER_ID.toLowerCase()}`,

    ams_units: [
      {
        entity_id:
          'sensor.barca_x2d_ams_1',
        name: 'AMS 1',

        // HA numbering is 1-based.
        ams_number: 1,

        trays: [
          {
            entity_id:
              TRAY_ENTITY,
            unique_id:
              TRAY_UNIQUE_ID,

            // HA numbering is 1-based.
            tray_number: 4,
          },
        ],
      },
    ],

    external_spools: [
      {
        entity_id:
          EXTERNAL_LEFT_ENTITY,
        unique_id:
          EXTERNAL_LEFT_UNIQUE_ID,
        tray_number: 0,
        is_external: true,
        slot_name:
          'External 1',
      },
      {
        entity_id:
          EXTERNAL_RIGHT_ENTITY,
        unique_id:
          EXTERNAL_RIGHT_UNIQUE_ID,
        tray_number: 0,
        is_external: true,
        slot_name:
          'External 2',
      },
    ],
  };
}

function makeSpool({
  material = 'ASA',
  colorHex = '2864DC',
  multiColorHexes = null,
  filamentExtra = {},
  extruderTemp,
}: {
  material?: string;
  colorHex?: string | null;
  multiColorHexes?: string | null;
  filamentExtra?: Record<string, string>;
  extruderTemp?: number;
} = {}): Spool {
  return {
    id: 123,

    filament: {
      id: 42,
      name: 'Test filament',
      vendor: null,
      material,
      color_hex: colorHex,
      multi_color_hexes:
        multiColorHexes,
      multi_color_direction: null,
      density: 1.24,
      diameter: 1.75,
      weight: 1000,

      extra:
        filamentExtra,

      settings_extruder_temp:
        extruderTemp ?? null,
    } as unknown as Spool['filament'],

    remaining_weight: 900,
    used_weight: 100,
    initial_weight: 1000,
    registered:
      '2026-10-04T00:00:00Z',
    extra: {},
    archived: false,
  };
}

beforeEach(() => {
  fromConnection.mockReset();
  discoverPrinters.mockReset();

  bridgeFromEnvironment.mockReset();
  bridgeGetHealth.mockReset();
  bridgeSetFilament.mockReset();

  fromConnection.mockResolvedValue({
    discoverPrinters,
  });

  discoverPrinters.mockResolvedValue([
    bambuPrinter(),
  ]);

  bridgeFromEnvironment.mockReturnValue({
    getHealth:
      bridgeGetHealth,
    setFilament:
      bridgeSetFilament,
  });

  bridgeGetHealth.mockResolvedValue({
    status: 'ready',
    connected: true,
    ready: true,
    reconnecting: false,
    printerId:
      PRINTER_ID,
    printerIp:
      '10.52.4.143',
    pluginVersion:
      '02.08.02.54',
    firmware:
      '01.02.00.00',
    lastMessageAgeMs: 500,
  });

  bridgeSetFilament.mockResolvedValue({
    status: 'synced',
    verified: true,
    elapsedMs: 1204,
    sequenceId: '20009',
    amsId: 0,
    trayId: 3,
  });
});

describe(
  'syncSpoolToBambuTray',
  () => {
    it(
      'sets Generic ASA through the bridge for a tray found by unique_id',
      async () => {
        const spool =
          makeSpool({
            material: 'ASA',
            colorHex: '2864DC',
          });

        const result =
          await syncSpoolToBambuTray(
            spool,
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeGetHealth,
        ).toHaveBeenCalledOnce();

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledOnce();

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          {
            profile: 'GFB98',
            setting:
              'GFSB98_14',
            type: 'ASA',
            color:
              '2864DCFF',
            tempMin: 240,
            tempMax: 280,
          },
        );

        expect(result).toEqual({
          status: 'synced',
          printer: 'Barča',
          entityId:
            TRAY_ENTITY,
          profileId: 'GFB98',
          settingId:
            'GFSB98_14',
          trayType: 'ASA',
          color: '2864DCFF',
          amsId: 0,
          trayId: 3,
          verified: true,
          elapsedMs: 1204,
          sequenceId:
            '20009',
        });
      },
    );

    it(
      'also finds a tray by entity_id',
      async () => {
        await syncSpoolToBambuTray(
          makeSpool({
            material: 'PLA',
            colorHex: 'FF0000',
          }),
          TRAY_ENTITY,
        );

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          {
            profile: 'GFL99',
            setting:
              'GFSL99_17',
            type: 'PLA',
            color:
              'FF0000FF',
            tempMin: 190,
            tempMax: 240,
          },
        );
      },
    );

    it(
      'keeps an existing 8-digit RGBA color unchanged',
      async () => {
        await syncSpoolToBambuTray(
          makeSpool({
            material: 'PETG',
            colorHex:
              '11223380',
          }),
          TRAY_UNIQUE_ID,
        );

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          expect.objectContaining({
            color:
              '11223380',
          }),
        );
      },
    );

    it(
      'uses the first multi-color value when color_hex is missing',
      async () => {
        await syncSpoolToBambuTray(
          makeSpool({
            material: 'PLA',
            colorHex: null,
            multiColorHexes:
              'FF0000,00FF00,0000FF',
          }),
          TRAY_UNIQUE_ID,
        );

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          expect.objectContaining({
            color:
              'FF0000FF',
          }),
        );
      },
    );

    it(
      'uses custom Bambu profile metadata from the filament',
      async () => {
        const spool =
          makeSpool({
            material: 'PETG',
            colorHex: '808080',

            filamentExtra: {
              bambu_filament_id:
                JSON.stringify(
                  'P12345678',
                ),

              bambu_setting_id:
                JSON.stringify(
                  'P12345678_X2D_04',
                ),

              bambu_tray_type:
                JSON.stringify(
                  'PETG',
                ),

              bambu_nozzle_temp_min:
                JSON.stringify(
                  225,
                ),

              bambu_nozzle_temp_max:
                JSON.stringify(
                  245,
                ),
            },
          });

        await syncSpoolToBambuTray(
          spool,
          TRAY_UNIQUE_ID,
        );

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          {
            profile:
              'P12345678',
            setting:
              'P12345678_X2D_04',
            type: 'PETG',
            color:
              '808080FF',
            tempMin: 225,
            tempMax: 245,
          },
        );
      },
    );

    it(
      'derives a temperature range around settings_extruder_temp for a custom profile',
      async () => {
        const spool =
          makeSpool({
            material: 'PETG',
            extruderTemp: 235,

            filamentExtra: {
              bambu_filament_id:
                JSON.stringify(
                  'P12345678',
                ),

              bambu_setting_id:
                JSON.stringify(
                  'P12345678_X2D_04',
                ),
            },
          });

        await syncSpoolToBambuTray(
          spool,
          TRAY_UNIQUE_ID,
        );

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          0,
          3,
          expect.objectContaining({
            profile:
              'P12345678',
            setting:
              'P12345678_X2D_04',
            tempMin: 215,
            tempMax: 255,
          }),
        );
      },
    );

    it(
      'requires bambu_setting_id for a custom filament profile',
      async () => {
        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',

              filamentExtra: {
                bambu_filament_id:
                  JSON.stringify(
                    'P12345678',
                  ),
              },
            }),
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          status: 'skipped',
          reason:
            'Custom bambu_filament_id requires bambu_setting_id',
          printer: 'Barča',
          entityId:
            TRAY_ENTITY,
        });
      },
    );

    it(
      'skips an unsupported material without a custom profile',
      async () => {
        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material:
                'MAGICIUM',
            }),
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          status: 'skipped',
          reason:
            'No Bambu profile mapping for material "MAGICIUM"',
          printer: 'Barča',
          entityId:
            TRAY_ENTITY,
        });
      },
    );

    it(
      'skips a tray which does not belong to a Bambu printer',
      async () => {
        discoverPrinters
          .mockResolvedValue([
            {
              brand:
                'creality',
              name:
                'Other printer',
              state: 'idle',
              prefix:
                'other',
              entity_id:
                'sensor.other',

              ams_units: [
                {
                  entity_id:
                    'sensor.cfs',
                  name:
                    'CFS',
                  ams_number: 1,

                  trays: [
                    {
                      entity_id:
                        'sensor.other_tray_1',
                      unique_id:
                        'other_tray_unique',
                      tray_number: 1,
                    },
                  ],
                },
              ],

              external_spools:
                [],
            },
          ]);

        const result =
          await syncSpoolToBambuTray(
            makeSpool(),
            'other_tray_unique',
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          status: 'skipped',
          reason:
            'Tray is not a discovered Bambu Lab tray',
        });
      },
    );

    it(
      'skips cleanly when Home Assistant is unavailable',
      async () => {
        fromConnection
          .mockResolvedValue(
            null,
          );

        const result =
          await syncSpoolToBambuTray(
            makeSpool(),
            TRAY_UNIQUE_ID,
          );

        expect(
          discoverPrinters,
        ).not.toHaveBeenCalled();

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          status: 'skipped',
          reason:
            'Home Assistant is not connected',
        });
      },
    );

    it(
      'skips cleanly when the bridge is not configured',
      async () => {
        bridgeFromEnvironment
          .mockReturnValue(
            null,
          );

        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',
            }),
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          status: 'skipped',
          reason:
            'Bambu bridge is not configured (BAMBU_BRIDGE_URL)',
          printer: 'Barča',
          entityId:
            TRAY_ENTITY,
        });
      },
    );

    it(
      'returns failed when the bridge printer is not ready',
      async () => {
        bridgeGetHealth
          .mockResolvedValueOnce({
            status:
              'not_ready',
            connected: false,
            ready: false,
            reconnecting: true,
            printerId:
              PRINTER_ID,
          });

        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',
            }),
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual(
          expect.objectContaining({
            status: 'failed',
            reason:
              'Bambu bridge is reconnecting to the printer',
            printer: 'Barča',
            entityId:
              TRAY_ENTITY,
            amsId: 0,
            trayId: 3,
          }),
        );
      },
    );

    it(
      'does not send to a bridge connected to a different printer',
      async () => {
        bridgeGetHealth
          .mockResolvedValueOnce({
            status: 'ready',
            connected: true,
            ready: true,
            reconnecting: false,
            printerId:
              'DIFFERENT_SERIAL',
          });

        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',
            }),
            TRAY_UNIQUE_ID,
          );

        expect(
          bridgeSetFilament,
        ).not.toHaveBeenCalled();

        expect(result).toEqual(
          expect.objectContaining({
            status:
              'skipped',
            reason:
              expect.stringContaining(
                'DIFFERENT_SERIAL',
              ),
          }),
        );
      },
    );

    it(
      'returns failed when the bridge rejects the update',
      async () => {
        bridgeSetFilament
          .mockRejectedValueOnce(
            new Error(
              'Bambu bridge: printer_not_ready',
            ),
          );

        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',
            }),
            TRAY_UNIQUE_ID,
          );

        expect(result).toEqual(
          expect.objectContaining({
            status: 'failed',
            reason:
              'Bambu bridge: printer_not_ready',
            printer: 'Barča',
            entityId:
              TRAY_ENTITY,
            profileId:
              'GFG99',
            settingId:
              'GFSG99_15',
            amsId: 0,
            trayId: 3,
          }),
        );
      },
    );

    it(
      'syncs the left X2D external spool through virtual tray 254',
      async () => {
        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PETG',
              colorHex: '1D8F99',
            }),
            EXTERNAL_LEFT_UNIQUE_ID,
          );

        expect(
          bridgeGetHealth,
        ).toHaveBeenCalledOnce();

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          254,
          0,
          {
            profile: 'GFG99',
            setting:
              'GFSG99_15',
            type: 'PETG',
            color:
              '1D8F99FF',
            tempMin: 220,
            tempMax: 260,
          },
        );

        expect(result).toEqual({
          status: 'synced',
          printer: 'Barča',
          entityId:
            EXTERNAL_LEFT_ENTITY,
          profileId: 'GFG99',
          settingId:
            'GFSG99_15',
          trayType: 'PETG',
          color: '1D8F99FF',
          amsId: 254,
          trayId: 0,
          verified: true,
          elapsedMs: 1204,
          sequenceId:
            '20009',
        });
      },
    );

    it(
      'syncs the right X2D external spool through virtual tray 255',
      async () => {
        const result =
          await syncSpoolToBambuTray(
            makeSpool({
              material: 'PLA',
              colorHex: '1D8F99',
            }),
            EXTERNAL_RIGHT_UNIQUE_ID,
          );

        expect(
          bridgeGetHealth,
        ).toHaveBeenCalledOnce();

        expect(
          bridgeSetFilament,
        ).toHaveBeenCalledWith(
          255,
          0,
          {
            profile: 'GFL99',
            setting:
              'GFSL99_17',
            type: 'PLA',
            color:
              '1D8F99FF',
            tempMin: 190,
            tempMax: 240,
          },
        );

        expect(result).toEqual({
          status: 'synced',
          printer: 'Barča',
          entityId:
            EXTERNAL_RIGHT_ENTITY,
          profileId: 'GFL99',
          settingId:
            'GFSL99_17',
          trayType: 'PLA',
          color: '1D8F99FF',
          amsId: 255,
          trayId: 0,
          verified: true,
          elapsedMs: 1204,
          sequenceId:
            '20009',
        });
      },
    );
  },
);