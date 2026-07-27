/**
 * Resolves `{host}` in a device viewer URL against whatever address the
 * operator actually used to reach the dashboard.
 *
 * The URL is built by the worker, which cannot know that: it has no request to
 * look at, and the machine's own idea of its address is not the browser's. A
 * template with a literal host therefore only works from one place, and breaks
 * the moment the box gets a new public IP, gets a domain, or is reached through
 * an SSH tunnel — the viewer silently shows nothing while the rest of the
 * dashboard works, because the iframe is pointing at a host that means
 * something different in the browser than it did on the server.
 *
 * Substituting here instead makes one configuration correct from every one of
 * those, since the viewer and the dashboard are served by the same machine.
 */
export function resolveViewerUrl(url: string | undefined, host: string): string | undefined {
  if (!url) {
    return undefined;
  }

  // Left alone when the template carries a literal host, so an existing
  // deployment keeps whatever it had.
  return url.split('{host}').join(host);
}

/** The address this page was loaded from, or empty when rendering on the server. */
export function browserHost(): string {
  return typeof window === 'undefined' ? '' : window.location.hostname;
}
