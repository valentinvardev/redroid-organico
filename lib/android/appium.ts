interface AppiumResponse<T> {
  value: T;
  sessionId?: string;
}

/**
 * Appium was unreachable: server down, container still starting, socket dropped
 * mid-flow. Worth retrying — the environment may simply not be up yet.
 */
export class AppiumTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppiumTransportError';
  }
}

/**
 * Appium answered, and the answer was a refusal. `appiumError` carries the W3C
 * error code, which is what tells "this element is not on screen" (expected
 * while polling) apart from "your session is gone" (fatal).
 */
export class AppiumProtocolError extends Error {
  readonly status: number;
  readonly appiumError: string;

  constructor(message: string, options: { status: number; appiumError: string }) {
    super(message);
    this.name = 'AppiumProtocolError';
    this.status = options.status;
    this.appiumError = options.appiumError;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  // Order matters: stripping trailing slashes first means a URL ending in
  // "/wd/hub/" still has its suffix recognised. Appium 2 serves at the root, so
  // a base URL copied from Appium 1 docs is normalised rather than rejected.
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/wd\/hub$/, '')
    .replace(/\/+$/, '');
}

function extractAppiumError(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return 'unknown error';
  }

  const value = (payload as Record<string, unknown>).value;

  if (typeof value === 'object' && value !== null) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === 'string') {
      return error;
    }
  }

  return 'unknown error';
}

async function appiumFetch<T>(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw new Error(`Appium request cancelled: ${method} ${url}`);
    }

    throw new AppiumTransportError(
      `Could not reach Appium at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (cause) {
    // An HTML error page or a truncated body means something other than Appium
    // answered, or it died mid-response. Either way the endpoint is not usable.
    throw new AppiumTransportError(
      `Appium response from ${url} was not valid JSON (HTTP ${response.status}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new AppiumProtocolError(
      `Appium request failed ${response.status} ${response.statusText} at ${url}: ${JSON.stringify(payload)}`,
      { status: response.status, appiumError: extractAppiumError(payload) },
    );
  }

  return payload as T;
}

function extractElementId(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Unexpected Appium element response: ${JSON.stringify(value)}`);
  }

  const element = (value as Record<string, unknown>)['element-6066-11e4-a52e-4f735466cecf'] ??
    (value as Record<string, unknown>).ELEMENT;

  if (typeof element !== 'string' || element.length === 0) {
    throw new Error(`Unexpected Appium element id: ${JSON.stringify(value)}`);
  }

  return element;
}

export interface AppiumSessionInfo {
  baseUrl: string;
  sessionId: string;
}

export async function createAppiumSession(
  baseUrl: string,
  capabilities: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AppiumSessionInfo> {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await appiumFetch<AppiumResponse<{ sessionId: string }>>(
    `${normalized}/session`,
    'POST',
    { capabilities: { alwaysMatch: capabilities } },
    signal,
  );

  if (!response.value || typeof response.value.sessionId !== 'string') {
    throw new AppiumTransportError(
      `Appium session did not return a valid sessionId: ${JSON.stringify(response)}`,
    );
  }

  return { baseUrl: normalized, sessionId: response.value.sessionId };
}

export async function deleteAppiumSession(session: AppiumSessionInfo, signal?: AbortSignal): Promise<void> {
  await appiumFetch<unknown>(`${session.baseUrl}/session/${session.sessionId}`, 'DELETE', undefined, signal);
}

export async function findElement(
  session: AppiumSessionInfo,
  using: string,
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await appiumFetch<AppiumResponse<unknown>>(
    `${session.baseUrl}/session/${session.sessionId}/element`,
    'POST',
    { using, value },
    signal,
  );

  return extractElementId(response.value);
}

export async function findElements(
  session: AppiumSessionInfo,
  using: string,
  value: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await appiumFetch<AppiumResponse<unknown>>(
    `${session.baseUrl}/session/${session.sessionId}/elements`,
    'POST',
    { using, value },
    signal,
  );

  if (!Array.isArray(response.value)) {
    return [];
  }

  return response.value.map(extractElementId);
}

export async function clickElement(session: AppiumSessionInfo, elementId: string, signal?: AbortSignal): Promise<void> {
  await appiumFetch<unknown>(
    `${session.baseUrl}/session/${session.sessionId}/element/${encodeURIComponent(elementId)}/click`,
    'POST',
    {},
    signal,
  );
}

export async function setValue(session: AppiumSessionInfo, elementId: string, value: string, signal?: AbortSignal): Promise<void> {
  await appiumFetch<unknown>(
    `${session.baseUrl}/session/${session.sessionId}/element/${encodeURIComponent(elementId)}/value`,
    'POST',
    { text: value },
    signal,
  );
}

export async function clearElement(session: AppiumSessionInfo, elementId: string, signal?: AbortSignal): Promise<void> {
  await appiumFetch<unknown>(
    `${session.baseUrl}/session/${session.sessionId}/element/${encodeURIComponent(elementId)}/clear`,
    'POST',
    {},
    signal,
  );
}

export async function getElementText(session: AppiumSessionInfo, elementId: string, signal?: AbortSignal): Promise<string> {
  const response = await appiumFetch<AppiumResponse<unknown>>(
    `${session.baseUrl}/session/${session.sessionId}/element/${encodeURIComponent(elementId)}/text`,
    'GET',
    undefined,
    signal,
  );

  return typeof response.value === 'string' ? response.value : '';
}

/** The full UI hierarchy as XML — the single most useful artefact when a selector misses. */
export async function getPageSource(session: AppiumSessionInfo, signal?: AbortSignal): Promise<string> {
  const response = await appiumFetch<AppiumResponse<unknown>>(
    `${session.baseUrl}/session/${session.sessionId}/source`,
    'GET',
    undefined,
    signal,
  );

  return typeof response.value === 'string' ? response.value : '';
}

/** Base64-encoded PNG of the current screen. */
export async function takeScreenshot(session: AppiumSessionInfo, signal?: AbortSignal): Promise<string> {
  const response = await appiumFetch<AppiumResponse<unknown>>(
    `${session.baseUrl}/session/${session.sessionId}/screenshot`,
    'GET',
    undefined,
    signal,
  );

  return typeof response.value === 'string' ? response.value : '';
}

/** W3C error codes that mean "keep polling" rather than "give up". */
const RETRYABLE_LOOKUP_ERRORS = new Set(['no such element', 'stale element reference']);

export async function waitForElement(
  session: AppiumSessionInfo,
  using: string,
  value: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    if (signal?.aborted) {
      throw new Error('Appium wait cancelled');
    }

    try {
      return await findElement(session, using, value, signal);
    } catch (error) {
      attempts += 1;

      // Only "not on screen yet" is worth another round. A dead session or an
      // invalid selector would otherwise burn the whole timeout re-asking a
      // question that can never start succeeding.
      const retryable =
        error instanceof AppiumProtocolError && RETRYABLE_LOOKUP_ERRORS.has(error.appiumError);

      if (!retryable) {
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new AppiumProtocolError(
          `Timed out after ${timeoutMs}ms and ${attempts} attempts waiting for element ${using}=${value}`,
          { status: 404, appiumError: 'no such element' },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Waits until the locator matches nothing — a spinner clearing, a dialog closing. */
export async function waitForElementGone(
  session: AppiumSessionInfo,
  using: string,
  value: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new Error('Appium wait cancelled');
    }

    const matches = await findElements(session, using, value, signal);

    if (matches.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new AppiumProtocolError(
        `Timed out after ${timeoutMs}ms waiting for element ${using}=${value} to disappear (${matches.length} still present)`,
        { status: 408, appiumError: 'element still present' },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
