/**
 * The relay the app talks to. `http://` makes @moq/net fetch the relay's self-signed certificate
 * fingerprint from `/certificate.sha256` and pin it (local development). A production build defaults to the
 * page's own origin: the deployed relay shares the web server's hostname and certificate.
 */
export const RELAY_URL: string =
  import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? "http://localhost:4443/" : `${location.origin}/`);
