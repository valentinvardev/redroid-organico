import { z } from 'zod';

/**
 * Everything about a proxy that does not need the database or the encryption
 * key. Imported by the dashboard as well as the worker, so it must stay free of
 * server-only imports — a `@/lib/db` in here would drag Prisma into the browser
 * bundle.
 */

export const PROXY_TYPES = ['HTTP', 'SOCKS5'] as const;

export type ProxyTypeName = (typeof PROXY_TYPES)[number];

/** URL scheme tun2socks expects for each type. */
const SCHEMES: Record<ProxyTypeName, string> = {
  HTTP: 'http',
  SOCKS5: 'socks5',
};

/**
 * A proxy as the gateway needs it: password in the clear, because it is about
 * to be handed to tun2socks. Only ever assembled inside the worker.
 */
export interface ProxyRuntimeConfig {
  type: ProxyTypeName;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

/**
 * Rejects a host that carries anything but a host.
 *
 * People paste `http://user:pass@1.2.3.4:8080` into a field labelled "host"
 * constantly, and the result is a proxy URL like `socks5://http://user:pass@…`
 * — accepted by the database, rejected by tun2socks, and only visible as a
 * container that exits three minutes into a job.
 */
function checkHost(host: string, ctx: z.RefinementCtx): void {
  const add = (message: string) => ctx.addIssue({ code: 'custom', message });

  if (host.length === 0) {
    // The length check on the field already said this; saying it twice reads
    // like two different problems.
    return;
  }

  if (host.includes('://')) {
    add('Host must not include a scheme — pick HTTP or SOCKS5 above instead');
    return;
  }

  if (host.includes('@')) {
    add('Host must not include credentials — use the username and password fields');
    return;
  }

  if (host.includes('/')) {
    add('Host must not include a path');
    return;
  }

  if (/\s/.test(host)) {
    add('Host must not contain spaces');
    return;
  }

  let parsed: URL;

  try {
    // The parser decides what a hostname is, rather than a regex that gets
    // punycode, IPv6 literals or trailing dots subtly wrong.
    parsed = new URL(`http://${host}`);
  } catch {
    add(`"${host}" is not a valid hostname or IP address`);
    return;
  }

  if (parsed.hostname !== host) {
    add(
      host.includes(':')
        ? 'Host must not include the port — there is a separate field for it'
        : `"${host}" is not a valid hostname or IP address`,
    );
  }
}

/** Empty inputs from a form are absent values, not empty usernames. */
const optionalSecret = z
  .string()
  .max(255)
  .nullish()
  .transform((value) => {
    const text = value ?? '';
    return text.length === 0 ? null : text;
  });

const proxyFieldsSchema = z.object({
  label: z.string().trim().min(1, 'Give the proxy a name').max(60),
  type: z.enum(PROXY_TYPES),
  host: z.string().trim().toLowerCase().min(1, 'Host is required').max(255).superRefine(checkHost),
  port: z.coerce
    .number({ error: 'Port must be a number' })
    .int('Port must be a whole number')
    .min(1, 'Port must be between 1 and 65535')
    .max(65_535, 'Port must be between 1 and 65535'),
  // Trimmed, because a trailing space pasted from a provider's dashboard is
  // never part of the username.
  username: optionalSecret.transform((value) => value?.trim() || null),
  // Deliberately not trimmed: a password may legitimately end in a space, and
  // silently changing it produces an authentication failure nobody can see.
  password: optionalSecret,
});

export const proxyInputSchema = proxyFieldsSchema.superRefine((proxy, ctx) => {
  if (proxy.password && !proxy.username) {
    ctx.addIssue({
      code: 'custom',
      path: ['username'],
      message: 'A password needs a username to go with it',
    });
  }
});

/**
 * An edit. A key that is absent means "leave this alone", which is the only way
 * to let an operator fix a typo in the host without retyping the password —
 * the API never sends one back, so the form has nothing to resubmit.
 */
export const proxyPatchSchema = proxyFieldsSchema.partial();

export type ProxyInput = z.infer<typeof proxyInputSchema>;
export type ProxyPatch = z.infer<typeof proxyPatchSchema>;

/**
 * The value of tun2socks' PROXY variable.
 *
 * Credentials are percent-encoded: residential providers hand out passwords
 * containing `@` and `:` often enough, and an unencoded one silently moves the
 * host boundary — `socks5://user:pa@ss@host:1080` parses as host `ss@host`.
 */
export function proxyUrl(config: ProxyRuntimeConfig): string {
  const credentials = config.username
    ? `${encodeURIComponent(config.username)}${
        config.password ? `:${encodeURIComponent(config.password)}` : ''
      }@`
    : '';

  return `${SCHEMES[config.type]}://${credentials}${config.host}:${config.port}`;
}

/** The same URL with the password blanked, for logs and error messages. */
export function redactProxyUrl(config: ProxyRuntimeConfig): string {
  return proxyUrl({ ...config, password: config.password ? '***' : null });
}

/**
 * Best-effort parse of the two shapes providers actually hand out:
 *
 *   socks5://user:pass@gate.example.com:1080
 *   gate.example.com:1080:user:pass
 *
 * Returns null when it recognises neither, so the caller can fall back to the
 * individual fields rather than saving something half-understood.
 */
export function parseProxyUrl(raw: string): Partial<ProxyInput> | null {
  const text = raw.trim();

  if (text.length === 0) {
    return null;
  }

  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(text);

  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const type = scheme.startsWith('socks') ? 'SOCKS5' : scheme.startsWith('http') ? 'HTTP' : null;

    if (!type) {
      return null;
    }

    let url: URL;

    try {
      // Every scheme parses the same once it is http: URL only exposes
      // username/password/hostname/port for "special" schemes.
      url = new URL(`http://${text.slice(schemeMatch[0].length)}`);
    } catch {
      return null;
    }

    if (!url.hostname || !url.port) {
      return null;
    }

    return {
      type,
      host: url.hostname,
      port: Number(url.port),
      username: decodeURIComponent(url.username) || null,
      password: decodeURIComponent(url.password) || null,
    };
  }

  const parts = text.split(':');

  if (parts.length < 2 || parts.length > 4) {
    return null;
  }

  const port = Number(parts[1]);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return {
    host: parts[0],
    port,
    username: parts[2] || null,
    password: parts[3] || null,
  };
}
