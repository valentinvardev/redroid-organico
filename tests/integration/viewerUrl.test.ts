import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewerUrl } from '@/app/components/viewerUrl';

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
