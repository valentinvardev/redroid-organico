import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { AndroidDevice } from '@/lib/android/device';
import {
  PackageNotInstalledError,
  type AcquireContext,
  type AcquiredDevice,
  type DeviceProvider,
} from '@/lib/android/deviceProvider';

const W3C_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

interface FakeElement {
  text?: string;
  /** Element only becomes findable from this poll onwards, to simulate a slow screen. */
  appearsAfterLookups?: number;
}

/**
 * A stand-in Appium server. The publisher talks real HTTP to it, so the client,
 * the polling and the error classification are all exercised for real — only
 * the device behind it is fake.
 */
export class FakeAppium {
  private readonly server: Server;
  private readonly ids = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private lookups = new Map<string, number>();

  readonly elements = new Map<string, FakeElement>();
  readonly clicks: string[] = [];
  readonly typed: Array<{ element: string; text: string }> = [];
  readonly cleared: string[] = [];
  readonly sessionsCreated: Array<Record<string, unknown>> = [];

  sessionId = 'fake-session';
  pageSource = '<hierarchy><node text="fake"/></hierarchy>';
  screenshotBase64 = Buffer.from('fake-png-bytes').toString('base64');
  /** Set to make every request fail, simulating an Appium server that went away. */
  offline = false;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req.method ?? 'GET', req.url ?? '/', req, res);
    });
  }

  static async start(): Promise<FakeAppium> {
    const fake = new FakeAppium();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Registers an element the flow will be able to find. */
  present(using: string, value: string, element: FakeElement = {}): this {
    this.elements.set(`${using}|${value}`, element);
    return this;
  }

  private elementId(key: string): string {
    let id = this.ids.get(key);

    if (!id) {
      id = `el-${this.ids.size + 1}`;
      this.ids.set(key, id);
      this.keys.set(id, key);
    }

    return id;
  }

  private resolve(key: string): FakeElement | undefined {
    const element = this.elements.get(key);

    if (!element) {
      return undefined;
    }

    const seen = (this.lookups.get(key) ?? 0) + 1;
    this.lookups.set(key, seen);

    if (element.appearsAfterLookups && seen < element.appearsAfterLookups) {
      return undefined;
    }

    return element;
  }

  private async handle(
    method: string,
    url: string,
    req: NodeJS.ReadableStream,
    res: import('http').ServerResponse,
  ): Promise<void> {
    const send = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (this.offline) {
      res.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const segments = url.split('?')[0].split('/').filter(Boolean);

    // POST /session
    if (method === 'POST' && segments.length === 1 && segments[0] === 'session') {
      const capabilities = (body.capabilities as { alwaysMatch?: Record<string, unknown> })?.alwaysMatch ?? {};
      this.sessionsCreated.push(capabilities);
      send(200, { value: { sessionId: this.sessionId, capabilities } });
      return;
    }

    if (segments[0] !== 'session' || segments.length < 2) {
      send(404, { value: { error: 'unknown command', message: url } });
      return;
    }

    // DELETE /session/:id
    if (method === 'DELETE' && segments.length === 2) {
      send(200, { value: null });
      return;
    }

    const tail = segments.slice(2);

    // POST /session/:id/element(s)
    if (method === 'POST' && (tail[0] === 'element' || tail[0] === 'elements') && tail.length === 1) {
      const key = `${String(body.using)}|${String(body.value)}`;
      const found = this.resolve(key);

      if (tail[0] === 'elements') {
        send(200, { value: found ? [{ [W3C_ELEMENT]: this.elementId(key) }] : [] });
        return;
      }

      if (!found) {
        send(404, {
          value: { error: 'no such element', message: `An element could not be located: ${key}`, stacktrace: '' },
        });
        return;
      }

      send(200, { value: { [W3C_ELEMENT]: this.elementId(key) } });
      return;
    }

    // /session/:id/element/:elementId/<action>
    if (tail[0] === 'element' && tail.length === 3) {
      const elementId = decodeURIComponent(tail[1]);
      const action = tail[2];

      if (method === 'POST' && action === 'click') {
        this.clicks.push(elementId);
        send(200, { value: null });
        return;
      }

      if (method === 'POST' && action === 'value') {
        this.typed.push({ element: elementId, text: String(body.text ?? '') });
        send(200, { value: null });
        return;
      }

      if (method === 'POST' && action === 'clear') {
        this.cleared.push(elementId);
        send(200, { value: null });
        return;
      }

      if (method === 'GET' && action === 'text') {
        const key = this.keys.get(elementId);
        send(200, { value: key ? (this.elements.get(key)?.text ?? '') : '' });
        return;
      }
    }

    if (method === 'GET' && tail[0] === 'source') {
      send(200, { value: this.pageSource });
      return;
    }

    if (method === 'GET' && tail[0] === 'screenshot') {
      send(200, { value: this.screenshotBase64 });
      return;
    }

    send(404, { value: { error: 'unknown command', message: `${method} ${url}` } });
  }
}

export interface FakeDeviceOptions {
  bootsWithin?: boolean;
  /** Size the device reports after a push; defaults to the pushed file's real size. */
  reportedSize?: number | null;
  appRuns?: boolean;
  packageInstalled?: boolean;
  /** `adb install` reports a failure. */
  installFails?: boolean;
  /** What the device answers when asked for its own address. */
  egressIp?: string;
  /** Which fetch tools exist on the device. Empty means the check has none. */
  egressTools?: string[];
}

/** An AndroidDevice that answers from memory, so no emulator is needed. */
export class FakeDevice implements AndroidDevice {
  readonly pushes: Array<{ localPath: string; remotePath: string }> = [];
  readonly launches: Array<{ packageName: string; activityName?: string }> = [];
  readonly scanned: string[] = [];
  readonly removed: string[] = [];
  readonly installed: string[] = [];
  readonly probes: string[][] = [];

  constructor(private readonly options: FakeDeviceOptions = {}) {}

  async waitUntilReady(): Promise<void> {
    if (this.options.bootsWithin === false) {
      throw new Error('sys.boot_completed never became 1');
    }
  }

  /** Used by FakeDeviceProvider, which does the boot wait during acquisition. */
  async bootsOk(): Promise<boolean> {
    return this.options.bootsWithin !== false;
  }

  async pushMedia(localPath: string, remotePath: string): Promise<number | null> {
    this.pushes.push({ localPath, remotePath });

    if (this.options.reportedSize !== undefined) {
      return this.options.reportedSize;
    }

    const { stat } = await import('fs/promises');
    return (await stat(localPath)).size;
  }

  async scanMedia(remotePath: string): Promise<void> {
    this.scanned.push(remotePath);
  }

  async launch(packageName: string, activityName: string | undefined): Promise<void> {
    this.launches.push({ packageName, activityName });
  }

  async isAppRunning(): Promise<boolean> {
    return this.options.appRuns !== false;
  }

  async isPackageInstalled(): Promise<boolean> {
    // Once installed, it stays installed — the point of the install path is
    // that the second check succeeds where the first did not.
    return this.options.packageInstalled !== false || this.installed.length > 0;
  }

  async installPackage(localApkPath: string): Promise<void> {
    if (this.options.installFails) {
      throw new Error(`adb install ${localApkPath} failed: INSTALL_FAILED_INVALID_APK`);
    }

    this.installed.push(localApkPath);
  }

  async removeFile(remotePath: string): Promise<void> {
    this.removed.push(remotePath);
  }

  /**
   * Answers as a device with `curl` and no `wget` unless told otherwise, which
   * is what a golden image built with `--tool curl` looks like.
   */
  async probe(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    this.probes.push(args);

    const tools = this.options.egressTools ?? ['curl'];

    if (!tools.includes(args[0])) {
      return { stdout: '', stderr: `${args[0]}: inaccessible or not found`, code: 127 };
    }

    return { stdout: `${this.options.egressIp ?? '203.0.113.7'}\n`, stderr: '', code: 0 };
  }
}

/**
 * Wraps a FakeDevice as a provider, mirroring AttachedDeviceProvider but
 * without any adb. `released` is what the lifecycle tests assert on.
 */
export class FakeDeviceProvider implements DeviceProvider {
  readonly kind = 'fake';
  released = 0;
  acquired = 0;

  constructor(
    readonly device: FakeDevice,
    private readonly options: { failAcquireWith?: Error; serial?: string } = {},
  ) {}

  async acquire(context: AcquireContext): Promise<AcquiredDevice> {
    this.acquired += 1;

    if (this.options.failAcquireWith) {
      throw this.options.failAcquireWith;
    }

    if (!(await this.device.isPackageInstalled())) {
      throw new PackageNotInstalledError(context.packageName);
    }

    if (!(await this.device.bootsOk())) {
      throw new Error('sys.boot_completed never became 1');
    }

    return {
      device: this.device,
      serial: this.options.serial ?? 'fake-device:5555',
      release: async () => {
        this.released += 1;
      },
    };
  }
}
