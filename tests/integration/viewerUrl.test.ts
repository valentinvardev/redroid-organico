import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewerUrl } from '@/app/components/viewerUrl';
import { describeAddress, resetLocationCache } from '@/lib/android/geo';

describe('device viewer URL', () => {
  it('resolves {host} against the address the dashboard was loaded from', () => {
    // The worker builds this URL and has no request to look at, so a literal
    // host only works from wherever the operator happened to be when it was
    // configured. A new public IP, a domain or an SSH tunnel each leave the
    // iframe pointing at something that means one thing on the server and
    // another in the browser — and the failure is a blank viewer while the rest
    // of the dashboard works perfectly.
    const url =
      'http://{host}:8000/#!action=stream&udid=dev%3A5555&ws=ws%3A%2F%2F{host}%3A8000%2F%3Fudid%3Ddev%253A5555';

    assert.equal(
      resolveViewerUrl(url, '13.59.234.226'),
      'http://13.59.234.226:8000/#!action=stream&udid=dev%3A5555&ws=ws%3A%2F%2F13.59.234.226%3A8000%2F%3Fudid%3Ddev%253A5555',
      'every occurrence, including the one inside the encoded ws parameter',
    );
  });

  it('leaves a template that carries a literal host exactly as it was', () => {
    // An existing deployment keeps working without being touched.
    assert.equal(resolveViewerUrl('http://10.0.0.5:8000/x', 'localhost'), 'http://10.0.0.5:8000/x');
    assert.equal(resolveViewerUrl(undefined, 'localhost'), undefined);
  });
});

describe('egress address', () => {
  const answer = (body: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('reads the place and what the address is', async () => {
    resetLocationCache();

    assert.deepEqual(
      await describeAddress(
        '74.0.102.132',
        5_000,
        answer({
          status: 'success',
          city: 'Dallas',
          regionName: 'Texas',
          country: 'United States',
          isp: 'Datacamp Limited',
          hosting: true,
          proxy: false,
          mobile: false,
        }),
      ),
      { location: 'Dallas, Texas, United States · Datacamp Limited', kind: 'hosting' },
    );
  });

  it('ranks a listed proxy above a hosting range', async () => {
    // An address can be both. Being on a proxy list is the louder signal:
    // somebody already published this address as one.
    resetLocationCache();

    const { kind } = await describeAddress(
      '203.0.113.7',
      5_000,
      answer({ status: 'success', hosting: true, proxy: true, mobile: false }),
    );

    assert.equal(kind, 'proxy');
  });

  it('says unflagged rather than claiming residential', async () => {
    // The absence of a marking is evidence, not proof, and a badge that
    // overstates it is worse than no badge.
    resetLocationCache();

    const { kind } = await describeAddress(
      '198.51.100.1',
      5_000,
      answer({ status: 'success', hosting: false, proxy: false, mobile: false }),
    );

    assert.equal(kind, 'unflagged');
  });

  it('answers empty rather than failing a run it is only decorating', async () => {
    resetLocationCache();

    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    assert.deepEqual(await describeAddress('203.0.113.9', 5_000, failing), {
      location: null,
      kind: null,
    });

    // Cached even when it failed: a service that is refusing now will refuse
    // for the length of a session.
    await describeAddress('203.0.113.9', 5_000, failing);
    assert.equal(calls, 1);

    resetLocationCache();
  });
});
