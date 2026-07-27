import type { JobLogger } from '@/lib/logging/jobLogger';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';
import type { AndroidDevice } from './device';

/**
 * Makes the device's story agree with where its traffic comes out.
 *
 * The network work guarantees the packets leave through the right address. It
 * says nothing about the device claiming to be somewhere else: a session
 * exiting in Dallas with the clock in GMT-3 and a locale of es-AR contradicts
 * itself, and the contradiction costs nothing to notice from the other side.
 *
 * These live on the proxy rather than the account on purpose. The exit address
 * is what decides the region, so moving an account to another egress should
 * move its story with it — not leave it insisting on the old one.
 *
 * Never fatal. Getting this wrong weakens a disguise; getting the routing wrong
 * breaks the guarantee. Only the second is worth failing a job over, so
 * everything here warns and continues.
 */

/** Android reads the zone from here, and it survives in the session volume. */
const TIMEZONE_PROP = 'persist.sys.timezone';

/** Read at boot, so a change lands on the device's next run, not this one. */
const LOCALE_PROP = 'persist.sys.locale';

export interface PersonaResult {
  timezone?: { wanted: string; applied: boolean };
  locale?: { wanted: string; pending: boolean };
}

export async function alignDeviceToEgress(
  device: AndroidDevice,
  proxy: ProxyRuntimeConfig,
  log: JobLogger,
  signal: AbortSignal,
): Promise<PersonaResult> {
  const result: PersonaResult = {};

  if (proxy.timezone) {
    result.timezone = { wanted: proxy.timezone, applied: await applyTimezone(device, proxy.timezone, signal) };

    if (!result.timezone.applied) {
      await log.warn('Could not set the device time zone; its clock disagrees with where it exits', {
        wanted: proxy.timezone,
      });
    }
  }

  if (proxy.locale) {
    const current = await readProp(device, LOCALE_PROP, signal);
    const pending = current !== proxy.locale;

    if (pending) {
      await device.probe(['setprop', LOCALE_PROP, proxy.locale], signal);
    }

    result.locale = { wanted: proxy.locale, pending };
  }

  if (result.timezone || result.locale) {
    // The device's own idea of the time, for the record. A property that reads
    // back correctly and a clock that did not move are different failures.
    const clock = await device.probe(['date'], signal).catch(() => null);

    await log.info('Device aligned to its egress region', {
      timezone: result.timezone?.wanted,
      timezoneApplied: result.timezone?.applied,
      locale: result.locale?.wanted,
      // Honest about the delay rather than implying it took: the framework
      // reads the locale at boot, and this container was already running.
      localeAppliesNextRun: result.locale?.pending,
      deviceClock: clock?.stdout.trim() || undefined,
    });
  }

  return result;
}

async function applyTimezone(device: AndroidDevice, zone: string, signal: AbortSignal): Promise<boolean> {
  if ((await readProp(device, TIMEZONE_PROP, signal)) === zone) {
    return true;
  }

  await device.probe(['setprop', TIMEZONE_PROP, zone], signal);

  // Read back rather than trust the exit code: `setprop` is happy to accept a
  // value the property service then refuses to keep, and a silently ignored
  // time zone is exactly the kind of thing nobody notices until it matters.
  return (await readProp(device, TIMEZONE_PROP, signal)) === zone;
}

async function readProp(device: AndroidDevice, prop: string, signal: AbortSignal): Promise<string | null> {
  const result = await device.probe(['getprop', prop], signal).catch(() => null);

  return result?.code === 0 ? result.stdout.trim() || null : null;
}
