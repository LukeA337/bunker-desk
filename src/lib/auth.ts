import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';
import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import { getTrader, saveTokenCache } from './db';

/** Delegated scopes. `offline_access` is what gets us a refresh token, so the desk
 *  survives a restart without the trader signing in again. */
export const SCOPES = [
  'offline_access', 'User.Read', 'Mail.Read', 'Mail.Send', 'Mail.ReadWrite',
];

export const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';
export const REDIRECT_URI = `${BASE_URL}/api/auth/callback`;

const msalConfig: Configuration = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID ?? '',
    clientSecret: process.env.AZURE_CLIENT_SECRET ?? '',
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID ?? 'common'}`,
  },
};

/** A fresh client per request: serverless has no shared process, so the token cache
 *  is rehydrated from Postgres each time rather than held in memory. */
export function newClient(serializedCache?: string): ConfidentialClientApplication {
  const cca = new ConfidentialClientApplication(msalConfig);
  if (serializedCache) cca.getTokenCache().deserialize(serializedCache);
  return cca;
}

/* ---- session cookie: signed, holds only the trader id ------------------- */

const SECRET = process.env.SESSION_SECRET ?? 'dev-only-insecure-secret';
const COOKIE = 'stemline_session';

const signature = (value: string): string =>
  crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

export async function setSession(traderId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, `${traderId}.${signature(traderId)}`, {
    httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'),
    path: '/', maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function getSessionTraderId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 1) return null;
  const id = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = signature(id);
  // Constant-time compare — the lengths are fixed, so a mismatch is a forged cookie.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

/* ---- silent token acquisition ------------------------------------------ */

export interface Session { traderId: string; accessToken: string; deltaLink: string | null }

/**
 * Resolve the signed-in trader and a fresh Graph access token, refreshing silently.
 * Returns null when there is no valid session — the caller should render sign-in,
 * not throw.
 */
export async function requireSession(): Promise<Session | null> {
  const traderId = await getSessionTraderId();
  if (!traderId) return null;

  const trader = await getTrader(traderId);
  if (!trader) return null;

  const cca = newClient(trader.token_cache);
  const account = await cca.getTokenCache().getAccountByHomeId(trader.home_account_id);
  if (!account) return null;

  try {
    const result = await cca.acquireTokenSilent({ account, scopes: SCOPES });
    if (!result?.accessToken) return null;
    // MSAL may have rotated the refresh token — persist the cache every time.
    await saveTokenCache(traderId, cca.getTokenCache().serialize());
    return { traderId, accessToken: result.accessToken, deltaLink: trader.delta_link };
  } catch {
    // Refresh token expired or revoked — the trader signs in again.
    return null;
  }
}
