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
  callService,
} = vi.hoisted(() => ({
  fromConnection: vi.fn(),
  discoverPrinters: vi.fn(),
  callService: vi.fn(),
}));

vi.mock('@/lib/api/homeassistant', () => ({
  HomeAssistantClient: {
    fromConnection,
  },
}));

const {
  syncSpoolToBambuTray,
} = await import('./bambu-filament-sync');

const TRAY_ENTITY =
  'sensor.barca_x2d_ams_1_tray_4';

const TRAY_UNIQUE_ID =
  'barca_x2d_ams_1_tray_4_unique';

function bambuPrinter() {
  return {
    brand: 'bambu_lab',
    entity_id: 'sensor.barca_x2d_status',
    name: 'Barča',
    state: 'idle',
    prefix: 'barca_x2d',
    ams_units: [
      {
        entity_id: 'sensor.barca_x2d_ams_1',
        name: 'AMS 1',
        ams_number: 1,
        trays: [
          {
            entity_id: TRAY_ENTITY,
            unique_id: TRAY_UNIQUE_ID,
            tray_number: 4,
          },
        ],
      },
    ],
    external_spools: [
      {
        entity_id:
          'sensor.barca_x2d_external_spool_1',
        unique_id:
          'barca_x2d_external_spool_1_unique',
        tray_number: 0,
        is_external: true,
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
      multi_color_hexes: multiColorHexes,
      multi_color_direction: null,
      density: 1.24,
      diameter: 1.75,
      weight: 1000,

      // These fields exist in current Spoolman responses,
      // although SpoolmanSync's Filament interface does not
      // currently declare them.
      extra: filamentExtra,
      settings_extruder_temp:
        extruderTemp ?? null,
    } as unknown as Spool['filament'],

    remaining_weight: 900,
    used_weight: 100,
    initial_weight: 1000,
    registered: '2026-10-04T00:00:00Z',
    extra: {},
    archived: false,
  };
}

beforeEach(() => {
  fromConnection.mockReset();
  discoverPrinters.mockReset();
  callService.mockReset();

  fromConnection.mockResolvedValue({
    discoverPrinters,
    callService,
  });

  discoverPrinters.mockResolvedValue([
    bambuPrinter(),
  ]);

  callService.mockResolvedValue(undefined);
});

describe('syncSpoolToBambuTray', () => {
  it(
    'sets Generic ASA on a Bambu tray found by unique_id',
    async () => {
      const spool = makeSpool({
        material: 'ASA',
        colorHex: '2864DC',
      });

      const result =
        await syncSpoolToBambuTray(
          spool,
          TRAY_UNIQUE_ID,
        );

      expect(callService).toHaveBeenCalledOnce();

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        {
          entity_id: TRAY_ENTITY,
          tray_info_idx: 'GFB98',
          tray_color: '2864DCFF',
          tray_type: 'ASA',
          nozzle_temp_min: 240,
          nozzle_temp_max: 280,
        },
      );

      expect(result).toEqual({
        status: 'synced',
        printer: 'Barča',
        entityId: TRAY_ENTITY,
        profileId: 'GFB98',
        trayType: 'ASA',
        color: '2864DCFF',
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

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        expect.objectContaining({
          entity_id: TRAY_ENTITY,
          tray_info_idx: 'GFL99',
          tray_type: 'PLA',
          tray_color: 'FF0000FF',
        }),
      );
    },
  );

  it(
    'keeps an existing 8-digit RGBA color unchanged',
    async () => {
      await syncSpoolToBambuTray(
        makeSpool({
          material: 'PETG',
          colorHex: '11223380',
        }),
        TRAY_UNIQUE_ID,
      );

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        expect.objectContaining({
          tray_color: '11223380',
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

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        expect.objectContaining({
          tray_color: 'FF0000FF',
        }),
      );
    },
  );

  it(
    'uses custom Bambu profile metadata from the filament',
    async () => {
      const spool = makeSpool({
        material: 'PETG',
        colorHex: '808080',
        filamentExtra: {
          bambu_filament_id:
            JSON.stringify('P12345678'),
          bambu_tray_type:
            JSON.stringify('PETG'),
          bambu_nozzle_temp_min:
            JSON.stringify(225),
          bambu_nozzle_temp_max:
            JSON.stringify(245),
        },
      });

      await syncSpoolToBambuTray(
        spool,
        TRAY_UNIQUE_ID,
      );

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        {
          entity_id: TRAY_ENTITY,
          tray_info_idx: 'P12345678',
          tray_color: '808080FF',
          tray_type: 'PETG',
          nozzle_temp_min: 225,
          nozzle_temp_max: 245,
        },
      );
    },
  );

  it(
    'derives a temperature range around settings_extruder_temp for a custom profile',
    async () => {
      const spool = makeSpool({
        material: 'PETG',
        extruderTemp: 235,
        filamentExtra: {
          bambu_filament_id:
            JSON.stringify('P12345678'),
        },
      });

      await syncSpoolToBambuTray(
        spool,
        TRAY_UNIQUE_ID,
      );

      expect(callService).toHaveBeenCalledWith(
        'bambu_lab',
        'set_filament',
        expect.objectContaining({
          tray_info_idx: 'P12345678',
          nozzle_temp_min: 215,
          nozzle_temp_max: 255,
        }),
      );
    },
  );

  it(
    'skips an unsupported material without a custom profile',
    async () => {
      const result =
        await syncSpoolToBambuTray(
          makeSpool({
            material: 'MAGICIUM',
          }),
          TRAY_UNIQUE_ID,
        );

      expect(callService).not.toHaveBeenCalled();

      expect(result).toEqual({
        status: 'skipped',
        reason:
          'No Bambu profile mapping for material "MAGICIUM"',
        printer: 'Barča',
        entityId: TRAY_ENTITY,
      });
    },
  );

  it(
    'skips a tray which does not belong to a Bambu printer',
    async () => {
      discoverPrinters.mockResolvedValue([
        {
          brand: 'creality',
          name: 'Other printer',
          state: 'idle',
          prefix: 'other',
          entity_id: 'sensor.other',
          ams_units: [
            {
              entity_id: 'sensor.cfs',
              name: 'CFS',
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
          external_spools: [],
        },
      ]);

      const result =
        await syncSpoolToBambuTray(
          makeSpool(),
          'other_tray_unique',
        );

      expect(callService).not.toHaveBeenCalled();

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
      fromConnection.mockResolvedValue(null);

      const result =
        await syncSpoolToBambuTray(
          makeSpool(),
          TRAY_UNIQUE_ID,
        );

      expect(discoverPrinters)
        .not.toHaveBeenCalled();

      expect(callService)
        .not.toHaveBeenCalled();

      expect(result).toEqual({
        status: 'skipped',
        reason:
          'Home Assistant is not connected',
      });
    },
  );

  it(
    'propagates a Home Assistant service error to the caller',
    async () => {
      callService.mockRejectedValueOnce(
        new Error('Printer offline'),
      );

      await expect(
        syncSpoolToBambuTray(
          makeSpool(),
          TRAY_UNIQUE_ID,
        ),
      ).rejects.toThrow('Printer offline');
    },
  );
});