import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import { newClient, SCOPES, REDIRECT_URI } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    return NextResponse.json(
      { error: `Not configured. Set ${missing.join(', ')} — see README part 1.` },
      { status: 500 },
    );
  }

  // CSRF: a one-shot value echoed back by Microsoft and checked in the callback.
  const state = crypto.randomBytes(16).toString('base64url');
  (await cookies()).set('stemline_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600,
  });

  const url = await newClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    state,
    prompt: 'select_account',
  });

  return NextResponse.redirect(url);
}
