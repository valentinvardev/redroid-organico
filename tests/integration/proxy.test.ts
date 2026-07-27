import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { jobLogger } from '@/lib/logging/jobLogger';
import {
  parseProxyUrl,
  proxyInputSchema,
  proxyUrl,
  redactProxyUrl,
  type ProxyRuntimeConfig,
} from '@/lib/proxy/config';
import {
  assignProxy,
  createProxy,
  deleteProxy,
  listProxies,
  openProxy,
  ProxyConflictError,
  ProxyValidationError,
  updateProxy,
} from '@/lib/proxy/service';
import { serializeProxy } from '@/lib/serialize';
import { createAccount, createUser, reset, teardown } from '../helpers/harness';

after(async () => {
  await teardown();
});

describe('proxy configuration', () => {
  it('builds the URL tun2socks expects for each type', () => {
    assert.equal(
      proxyUrl({ type: 'SOCKS5', host: 'gate.example.com', port: 1080 }),
      'socks5://gate.example.com:1080',
    );

    assert.equal(
      proxyUrl({ type: 'HTTP', host: '10.0.0.9', port: 8080, username: 'user', password: 'secret' }),
      'http://user:secret@10.0.0.9:8080',
    );
  });

  it('percent-encodes credentials so a password cannot move the host boundary', () => {
    // Unencoded, this reads as host "ss@gate.example.com" — a proxy URL that
    // parses fine and points somewhere else entirely.
    const url = proxyUrl({
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      username: 'user@corp',
      password: 'pa@ss:word',
    });

    assert.equal(url, 'socks5://user%40corp:pa%40ss%3Aword@gate.example.com:1080');
    assert.equal(new URL(url).hostname, 'gate.example.com');
  });

  it('never puts a password in the redacted form used for logs', () => {
    const config: ProxyRuntimeConfig = {
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      username: 'user',
      password: 'hunter2',
    };

    const redacted = redactProxyUrl(config);

    assert.ok(!redacted.includes('hunter2'), redacted);
    assert.equal(redacted, 'socks5://user:***@gate.example.com:1080');
  });

  it('accepts hostnames and IP addresses', () => {
    for (const host of ['gate.example.com', '10.0.0.9', 'xn--bcher-kva.example']) {
      const parsed = proxyInputSchema.safeParse({ label: 'p', type: 'SOCKS5', host, port: 1080 });
      assert.equal(parsed.success, true, `${host} should be accepted`);
    }
  });

  it('rejects a host that is really a whole URL, which is what people paste', () => {
    const cases: Array<[string, RegExp]> = [
      ['socks5://gate.example.com', /scheme/],
      ['user:pass@gate.example.com', /credentials/],
      ['gate.example.com:1080', /port/],
      ['gate.example.com/path', /path/],
      ['not a host', /spaces/],
    ];

    for (const [host, expected] of cases) {
      const parsed = proxyInputSchema.safeParse({ label: 'p', type: 'SOCKS5', host, port: 1080 });

      assert.equal(parsed.success, false, `${host} should be rejected`);
      assert.match(
        parsed.error?.issues.map((issue) => issue.message).join(' ') ?? '',
        expected,
        `wrong explanation for ${host}`,
      );
    }
  });

  it('rejects ports outside the range and passwords with nobody to send them as', () => {
    for (const port of [0, 70_000, 1.5]) {
      const parsed = proxyInputSchema.safeParse({ label: 'p', type: 'HTTP', host: 'h.example', port });
      assert.equal(parsed.success, false, `port ${port} should be rejected`);
    }

    const orphan = proxyInputSchema.safeParse({
      label: 'p',
      type: 'HTTP',
      host: 'h.example',
      port: 8080,
      password: 'secret',
    });

    assert.equal(orphan.success, false);
    assert.match(orphan.error?.issues[0].message ?? '', /username/);
  });

  it('understands the two shapes providers hand out', () => {
    assert.deepEqual(parseProxyUrl('socks5://user:pass@gate.example.com:1080'), {
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });

    assert.deepEqual(parseProxyUrl('gate.example.com:1080:user:pass'), {
      host: 'gate.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });

    // Anything else is left to the individual fields rather than half-parsed.
    assert.equal(parseProxyUrl('ftp://gate.example.com:21'), null);
    assert.equal(parseProxyUrl('gate.example.com'), null);
  });
});

describe('proxy service', () => {
  let userId: string;

  before(async () => {
    await reset();
    userId = (await createUser()).id;
  });

  beforeEach(async () => {
    await prisma.account.deleteMany({});
    await prisma.proxy.deleteMany({});
  });

  after(async () => {
    await reset();
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    label: 'Residential ES',
    type: 'SOCKS5',
    host: 'gate.example.com',
    port: 1080,
    username: 'user',
    password: 'hunter2',
    ...overrides,
  });

  it('seals the password, and never hands it back through the API shape', async () => {
    const created = await createProxy(userId, input());

    const row = await prisma.proxy.findUniqueOrThrow({ where: { id: created.id } });

    assert.ok(row.password, 'a password was given, so one must be stored');
    assert.ok(
      !Buffer.from(row.password).toString('utf8').includes('hunter2'),
      'the password must not be readable in the row',
    );

    // The worker is the only place it comes back out.
    assert.equal(openProxy(row).password, 'hunter2');

    const serialized = serializeProxy(created) as Record<string, unknown>;
    assert.equal(serialized.hasPassword, true);
    assert.equal('password' in serialized, false);
    assert.ok(!JSON.stringify(serialized).includes('hunter2'));
  });

  it('refuses a second proxy with the same name', async () => {
    await createProxy(userId, input());

    await assert.rejects(createProxy(userId, input({ host: 'other.example' })), ProxyConflictError);
  });

  it('keeps the stored password when an edit does not mention it', async () => {
    const created = await createProxy(userId, input());

    const updated = await updateProxy(userId, created.id, { host: 'moved.example.com' });

    assert.equal(updated.host, 'moved.example.com');
    assert.equal(openProxy(updated).password, 'hunter2');
  });

  it('replaces the password when an edit does mention it, and clears it on null', async () => {
    const created = await createProxy(userId, input());

    const rotated = await updateProxy(userId, created.id, { password: 'hunter3' });
    assert.equal(openProxy(rotated).password, 'hunter3');

    const cleared = await updateProxy(userId, created.id, { username: null, password: null });
    assert.equal(cleared.password, null);
    assert.equal(openProxy(cleared).username, null);
  });

  it('normalises the host instead of storing what was typed', async () => {
    const created = await createProxy(userId, input({ host: '  GATE.Example.COM  ' }));

    assert.equal(created.host, 'gate.example.com');
  });

  it('refuses to delete a proxy an account still uses, naming the accounts', async () => {
    const proxy = await createProxy(userId, input());
    const account = await createAccount(userId, { name: 'Partner one' });
    await assignProxy(userId, account.id, proxy.id);

    await assert.rejects(deleteProxy(userId, proxy.id), (error: Error) => {
      assert.ok(error instanceof ProxyConflictError);
      assert.match(error.message, /Partner one/);
      return true;
    });

    // Detaching first is what makes the deletion legal, and it is deliberate.
    await assignProxy(userId, account.id, null);
    await deleteProxy(userId, proxy.id);

    assert.deepEqual(await listProxies(userId), []);
  });

  it('reports how many accounts share a proxy, because sharing an IP defeats the point', async () => {
    const proxy = await createProxy(userId, input());
    const first = await createAccount(userId, { name: 'One' });
    const second = await createAccount(userId, { name: 'Two' });

    await assignProxy(userId, first.id, proxy.id);
    await assignProxy(userId, second.id, proxy.id);

    const [listed] = await listProxies(userId);
    assert.equal(listed._count.accounts, 2);
  });

  it('will not attach another tenant’s proxy to an account', async () => {
    const stranger = await createUser();
    const theirProxy = await createProxy(stranger.id, input({ label: 'Theirs' }));
    const account = await createAccount(userId);

    await assert.rejects(assignProxy(userId, account.id, theirProxy.id), ProxyValidationError);

    const unchanged = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(unchanged.proxyId, null);

    // And the same in the other direction: the proxy's owner cannot reach an
    // account that is not theirs.
    await assert.rejects(assignProxy(stranger.id, account.id, theirProxy.id), ProxyValidationError);
  });

  it('blanks a proxy config that reaches a job log by accident', async () => {
    // The worker logs a deliberately redacted `egress` string. This is the
    // backstop for the call site that some day logs the whole config instead.
    const account = await createAccount(userId);
    const job = await prisma.job.create({
      data: { userId, accountId: account.id, idempotencyKey: randomUUID() },
    });

    await jobLogger(job.id).info('careless', {
      proxy: { host: 'gate.example.com', password: 'hunter2' },
    });

    const [entry] = await prisma.jobLog.findMany({ where: { jobId: job.id } });

    assert.equal((entry.data as Record<string, unknown>).proxy, '[redacted]');
    assert.ok(!JSON.stringify(entry.data).includes('hunter2'));
  });

  it('does not let a proxy outlive the user it belongs to', async () => {
    const doomed = await createUser();
    await createProxy(doomed.id, input({ label: 'Theirs' }));

    await prisma.user.delete({ where: { id: doomed.id } });

    assert.equal(await prisma.proxy.count({ where: { userId: doomed.id } }), 0);
  });
});

describe('device persona on a proxy', () => {
  let userId: string;

  before(async () => {
    await reset();
    userId = (await createUser()).id;
  });

  after(async () => {
    await reset();
  });

  it('accepts an IANA zone and rejects what people write instead', () => {
    const base = { label: 'p', type: 'SOCKS5', host: 'gate.example.com', port: 1080 };

    assert.equal(proxyInputSchema.safeParse({ ...base, timezone: 'America/Chicago' }).success, true);
    assert.equal(proxyInputSchema.safeParse({ ...base, timezone: '' }).success, true, 'optional');

    // The two forms people reach for first, and neither is a zone: an offset
    // has no daylight saving and an abbreviation is ambiguous across countries.
    for (const wrong of ['GMT-5', 'CST', 'Chicago']) {
      const parsed = proxyInputSchema.safeParse({ ...base, timezone: wrong });
      assert.equal(parsed.success, false, `${wrong} should be rejected`);
      assert.match(parsed.error?.issues[0].message ?? '', /IANA/);
    }
  });

  it('accepts a BCP-47 tag and rejects a sentence', () => {
    const base = { label: 'p', type: 'SOCKS5', host: 'gate.example.com', port: 1080 };

    assert.equal(proxyInputSchema.safeParse({ ...base, locale: 'en-US' }).success, true);
    assert.equal(proxyInputSchema.safeParse({ ...base, locale: 'es' }).success, true);
    assert.equal(proxyInputSchema.safeParse({ ...base, locale: 'English (US)' }).success, false);
  });

  it('carries the region through to the worker, where the device reads it', async () => {
    const created = await createProxy(userId, {
      label: 'Dallas',
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      timezone: 'America/Chicago',
      locale: 'en-US',
    });

    const runtime = openProxy(await prisma.proxy.findUniqueOrThrow({ where: { id: created.id } }));

    assert.equal(runtime.timezone, 'America/Chicago');
    assert.equal(runtime.locale, 'en-US');
  });
});
