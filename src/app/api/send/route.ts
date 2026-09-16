import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth';
import { replyAndSend, GraphError } from '@/lib/graph';
import { getMessage, recordClientQuote } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Body {
  /** The client's original enquiry message — we reply on ITS thread, not the vendor's. */
  replyToMessageId: string;
  body: string;
  marginBasis: string;
  marginValue: number;
  /** Full component trail the price was built from. Goes into the audit record. */
  costBreakdown: unknown;
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ signedIn: false }, { status: 401 });

  const payload = (await req.json()) as Body;
  if (!payload.replyToMessageId || !payload.body?.trim()) {
    return NextResponse.json({ error: 'Nothing to send.' }, { status: 400 });
  }

  const original = await getMessage(session.traderId, payload.replyToMessageId);
  if (!original) {
    return NextResponse.json({ error: 'Original enquiry not found.' }, { status: 404 });
  }

  try {
    const sentId = await replyAndSend(
      session.accessToken, payload.replyToMessageId, payload.body,
    );

    // Audit first-class: what went out, and the cost basis it was computed from.
    await recordClientQuote({
      enquiryId: null,
      vendorQuoteId: null,
      marginBasis: payload.marginBasis,
      marginValue: payload.marginValue,
      costBreakdown: payload.costBreakdown,
      body: payload.body,
      graphMessageId: sentId,
    });

    return NextResponse.json({ sent: true, messageId: sentId, to: original.from_address });
  } catch (err) {
    if (err instanceof GraphError) {
      return NextResponse.json(
        {
          error: err.status === 403
            ? 'Send was refused. The Mail.Send permission may not be granted — see README part 1, step 7.'
            : `Send failed (${err.status}).`,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: 'Send failed.' }, { status: 500 });
  }
}
