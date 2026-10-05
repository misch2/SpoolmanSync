export interface BambuBridgeHealth {
  status: 'ready' | 'not_ready';
  connected: boolean;
  ready: boolean;
  reconnecting?: boolean;
  printerId: string;
  printerIp?: string;
  pluginVersion?: string;
  firmware?: string;
  lastMessageAgeMs?: number;
}

export interface BambuBridgeFilamentRequest {
  profile: string;
  setting: string;
  type: string;
  color: string;
  tempMin: number;
  tempMax: number;
}

export interface BambuBridgeFilamentResult {
  status: 'synced';
  verified: true;
  elapsedMs: number;
  sequenceId: string;
  amsId: number;
  trayId: number;
}

interface BambuBridgeErrorResponse {
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export class BambuBridgeError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly response?: BambuBridgeErrorResponse,
  ) {
    super(message);
    this.name = 'BambuBridgeError';
  }
}

export class BambuBridgeClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(
    baseUrl: string,
    token?: string,
  ) {
    this.baseUrl =
      baseUrl.replace(/\/+$/, '');

    this.token =
      token?.trim() || undefined;
  }

  static fromEnvironment(): BambuBridgeClient | null {
    const url =
      process.env.BAMBU_BRIDGE_URL?.trim();

    if (!url) {
      return null;
    }

    const token =
      process.env.BAMBU_BRIDGE_TOKEN?.trim();

    return new BambuBridgeClient(
      url,
      token,
    );
  }

  private async fetchWithTimeout(
    path: string,
    init: RequestInit = {},
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    try {
      const headers =
        new Headers(init.headers);

      if (this.token) {
        headers.set(
          'Authorization',
          `Bearer ${this.token}`,
        );
      }

      return await fetch(
        `${this.baseUrl}${path}`,
        {
          ...init,
          headers,
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new BambuBridgeError(
          `Bambu bridge request timed out after ${timeoutMs} ms`,
        );
      }

      throw new BambuBridgeError(
        error instanceof Error
          ? `Bambu bridge request failed: ${error.message}`
          : 'Bambu bridge request failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson<T>(
    response: Response,
  ): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new BambuBridgeError(
        `Bambu bridge returned invalid JSON (HTTP ${response.status})`,
        response.status,
      );
    }
  }

  async getHealth(): Promise<BambuBridgeHealth> {
    const response = await this.fetchWithTimeout(
      '/health',
      {},
      3000,
    );

    const body =
      await this.readJson<BambuBridgeHealth>(response);

    // 503 is a valid bridge state: alive, but printer not ready.
    if (!response.ok && response.status !== 503) {
      throw new BambuBridgeError(
        `Bambu bridge health check failed (HTTP ${response.status})`,
        response.status,
        body as unknown as BambuBridgeErrorResponse,
      );
    }

    if (
      typeof body.printerId !== 'string' ||
      typeof body.ready !== 'boolean' ||
      typeof body.connected !== 'boolean'
    ) {
      throw new BambuBridgeError(
        'Bambu bridge returned an invalid health response',
        response.status,
      );
    }

    return body;
  }

  async setFilament(
    amsId: number,
    trayId: number,
    request: BambuBridgeFilamentRequest,
  ): Promise<BambuBridgeFilamentResult> {
    const response = await this.fetchWithTimeout(
      `/api/v1/ams/${amsId}/trays/${trayId}/filament`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },

      // Bridge itself can wait for printer reply + fresh push_status.
      12000,
    );

    const body =
      await this.readJson<
        BambuBridgeFilamentResult | BambuBridgeErrorResponse
      >(response);

    if (!response.ok) {
      const errorBody =
        body as BambuBridgeErrorResponse;

      throw new BambuBridgeError(
        errorBody.error
          ? `Bambu bridge: ${errorBody.error}`
          : `Bambu bridge returned HTTP ${response.status}`,
        response.status,
        errorBody,
      );
    }

    const result =
      body as BambuBridgeFilamentResult;

    if (
      result.status !== 'synced' ||
      result.verified !== true
    ) {
      throw new BambuBridgeError(
        'Bambu bridge did not verify the filament update',
        response.status,
        body as unknown as BambuBridgeErrorResponse,
      );
    }

    return result;
  }
}