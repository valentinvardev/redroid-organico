/**
 * What an exit address is, in the terms that decide whether a platform will
 * argue with it.
 *
 * Shown next to the phone while an operator is logging in, because the two
 * questions in their head at that moment are "where does this look like it is
 * coming from" and "is this address the kind that gets challenged". The second
 * one is answerable — a datacentre range is a fact about the address — and it
 * is the difference between "the login is broken" and "this IP was always going
 * to be argued with".
 *
 * What this is not: a verdict about whether a given platform has blocked this
 * address. Nothing outside that platform knows, and a badge implying otherwise
 * would be worse than no badge.
 *
 * Best effort by construction: the lookup decorates a device that is already
 * verified, so nothing here may fail a run. Every path ends in null.
 */

interface Classified {
  status?: string;
  country?: string;
  regionName?: string;
  city?: string;
  isp?: string;
  as?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
}

/**
 * What the address is, as far as an outside observer can tell.
 *
 * `unflagged` is deliberately not called "residential": the absence of a
 * datacentre marking is evidence, not proof, and naming it after a conclusion
 * it does not support is how a badge starts lying.
 */
export type AddressKind = 'hosting' | 'proxy' | 'mobile' | 'unflagged';

export interface EgressAddress {
  /** "Dallas, Texas, US · Datacamp Limited" */
  location: string | null;
  kind: AddressKind | null;
}

// Plain HTTP on purpose: the free tier of this service refuses TLS, and what
// travels is a public address in one direction and its country in the other.
// Nothing here is worth a key, and a key is what the alternatives cost.
const ENDPOINT = 'http://ip-api.com/json';
const FIELDS = 'status,country,regionName,city,isp,as,mobile,proxy,hosting';

const cache = new Map<string, EgressAddress>();

export async function describeAddress(
  ip: string,
  timeoutMs = 5_000,
  fetchImpl: typeof fetch = fetch,
): Promise<EgressAddress> {
  const known = cache.get(ip);

  if (known) {
    return known;
  }

  let described: EgressAddress = { location: null, kind: null };

  try {
    const response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(ip)}?fields=${FIELDS}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      const body = (await response.json()) as Classified;

      if (body.status === 'success') {
        described = { location: placeOf(body), kind: kindOf(body) };
      }
    }
  } catch {
    // Left as the empty description; the caller renders the address alone.
  }

  // Cached including the failure: an address does not move, and a service that
  // is refusing now will refuse for the length of a session.
  cache.set(ip, described);
  return described;
}

function placeOf(body: Classified): string | null {
  const place = [body.city, body.regionName, body.country].filter(Boolean).join(', ');

  return [place, body.isp].filter(Boolean).join(' · ') || null;
}

/**
 * Ordered by what an operator should react to first. An address can be both
 * hosted and a known proxy; being on a proxy list is the louder signal, because
 * it means somebody already published this address as one.
 */
function kindOf(body: Classified): AddressKind {
  if (body.proxy) {
    return 'proxy';
  }

  if (body.hosting) {
    return 'hosting';
  }

  return body.mobile ? 'mobile' : 'unflagged';
}

/** Test seam; the cache is process-wide and would leak between cases. */
export function resetLocationCache(): void {
  cache.clear();
}
