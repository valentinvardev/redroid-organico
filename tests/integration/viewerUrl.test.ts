import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewerUrl } from '@/app/components/viewerUrl';
import { describeLocation, resetLocationCache } from '@/lib/android/geo';

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

describe('egress location', () => {
  it('describes an address in a way a person can read at a glance', async () => {
    resetLocationCache();

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          city: 'Dallas',
          region: 'Texas',
          country_code: 'US',
          connection: { org: 'Datacamp Limited' },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    assert.equal(
      await describeLocation('74.0.102.132', 5_000, fetchImpl),
      'Dallas, Texas, US · Datacamp Limited',
    );
  });

  it('answers null rather than failing a run the lookup is only decorating', async () => {
    resetLocationCache();

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    assert.equal(await describeLocation('203.0.113.7', 5_000, fetchImpl), null);

    // Cached even when it failed: an address does not move, and a service that
    // is down stays down for the length of a session.
    assert.equal(await describeLocation('203.0.113.7', 5_000, fetchImpl), null);
    assert.equal(calls, 1);

    resetLocationCache();
  });
});
