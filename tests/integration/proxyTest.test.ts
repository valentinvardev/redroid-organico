import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testProxy } from '@/lib/proxy/test';

describe('proxy reachability test', () => {
  it('reports a refused connection instead of throwing or hanging', async () => {
    // Port 1 on loopback: nothing listens, so the connect is refused at once.
    const result = await testProxy(
      { type: 'SOCKS5', host: '127.0.0.1', port: 1, username: null, password: null },
      3_000,
    );

    assert.equal(result.ok, false);
    assert.ok(result.error, 'a failure carries a message');
    assert.equal(result.exitIp, undefined);
  });

  it('gives up within the timeout on an unroutable address', async () => {
    // 203.0.113.0/24 is TEST-NET-3: reserved, guaranteed to go nowhere.
    const started = Date.now();
    const result = await testProxy(
      { type: 'SOCKS5', host: '203.0.113.1', port: 1080, username: null, password: null },
      2_000,
    );

    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 6_000, 'the timeout bounds how long a dead proxy can hang the request');
  });
});
