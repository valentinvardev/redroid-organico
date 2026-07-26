/**
 * A minimal Android account config that passes androidCredentialsSchema, for
 * tests about account creation. Deliberately plain values — the point is a
 * valid shape, not a runnable flow.
 */
export function createAndroidAccountConfig(): Record<string, unknown> {
  return {
    appiumUrl: 'http://localhost:4723',
    adbHost: 'localhost',
    adbPort: 5037,
    packageName: 'com.target.app',
    apkPath: '/srv/apks/app.apk',
    remoteVideoPath: '/sdcard/DCIM/upload.mp4',
    redroid: {
      image: 'redroid/redroid:13.0.0-latest',
      connectVia: 'container-name',
      network: 'redroid-net',
    },
    flow: [
      { action: 'assertVisible', name: 'landed', using: 'id', value: 'com.target.app:id/home', timeoutMs: 15000 },
    ],
  };
}
