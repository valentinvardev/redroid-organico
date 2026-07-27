/**
 * Turns an exit address into something a person can read at a glance.
 *
 * Shown next to the phone while an operator is logging in, because "this
 * session is coming out of Dallas" is the one piece of context that decides
 * whether what the app is doing makes sense — a login challenge is expected
 * from a new region and suspicious from the usual one.
 *
 * Best effort by construction: the lookup is a nicety attached to a device that
 * is already verified. Nothing here may fail a run, so every path ends in null.
 */

interface Located {
  city?: string;
  region?: string;
  country_code?: string;
  connection?: { org?: string };
}

const cache = new Map<string, string | null>();

/** e.g. "Dallas, Texas, US · Datacamp Limited" */
export async function describeLocation(
  ip: string,
  timeoutMs = 5_000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const known = cache.get(ip);

  if (known !== undefined) {
    return known;
  }

  let description: string | null = null;

  try {
    const response = await fetchImpl(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      const body = (await response.json()) as Located;
      const place = [body.city, body.region, body.country_code].filter(Boolean).join(', ');
      const org = body.connection?.org;

      description = [place, org].filter(Boolean).join(' · ') || null;
    }
  } catch {
    description = null;
  }

  // Cached either way, including the failure: an address does not move, and a
  // service that is down stays down for the length of a session.
  cache.set(ip, description);
  return description;
}

/** Test seam; the cache is process-wide and would leak between cases. */
export function resetLocationCache(): void {
  cache.clear();
}
