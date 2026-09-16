import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { newClient, SCOPES, REDIRECT_URI, BASE_URL, setSession } from '@/lib/auth';
import { upsertTrader } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const fail = (msg: string) =>
    NextResponse.redirect(`${BASE_URL}/?error=${encodeURIComponent(msg)}`);

  // Microsoft reports consent problems here, not as an exception.
  const oauthError = params.get('error');
  if (oauthError) {
    const desc = params.get('error_description') ?? '';
    return fail(
      desc.includes('AADSTS65001')
        ? 'Your tenant requires an admin to grant consent for this app. See README part 1, step 8.'
        : `${oauthError}: ${desc.slice(0, 200)}`,
    );
  }

  const code = params.get('code');
  if (!code) return fail('No authorization code returned.');

  const jar = await cookies();
  const expected = jar.get('stemline_oauth_state')?.value;
  if (!expected || params.get('state') !== expected) {
    return fail('Sign-in state did not match. Start again.');
  }
  jar.delete('stemline_oauth_state');

  try {
    const cca = newClient();
    const result = await cca.acquireTokenByCode({
      code, scopes: SCOPES, redirectUri: REDIRECT_URI,
    });
    if (!result?.account) return fail('Microsoft returned no account.');

    const claims = result.idTokenClaims as Record<string, unknown>;
    const traderId = String(claims.oid ?? result.account.homeAccountId);

    await upsertTrader({
      id: traderId,
      display_name: result.account.name ?? 'Trader',
      email: result.account.username,
      home_account_id: result.account.homeAccountId,
      token_cache: cca.getTokenCache().serialize(),
    });
    await setSession(traderId);

    return NextResponse.redirect(BASE_URL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token exchange failed.';
    return fail(msg.slice(0, 240));
  }
}
