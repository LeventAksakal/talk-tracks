/**
 * The relay the app talks to. `http://` makes @moq/net fetch the relay's self-signed certificate
 * fingerprint from `/certificate.sha256` and pin it (local development); use `https://` in production.
 */
export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL || "http://localhost:4443/";
