import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { pollInbox, plainBody, GraphError } from '@/lib/graph';
import { insertMessages, recentMessages, saveDeltaLink } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * One delta pass over the inbox. The browser calls this every 12 seconds while the
 * desk is open — see README, "How the watcher works". Returns the recent message list
 * plus which ones are new since the last call, so the UI can flag arrivals.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ signedIn: false }, { status: 401 });

  try {
    const { messages, deltaLink } = await pollInbox(session.accessToken, session.deltaLink);

    const fresh = await insertMessages(
      session.traderId,
      messages.map((m) => ({
        id: m.id,
        internet_message_id: m.internetMessageId ?? m.id,
        conversation_id: m.conversationId ?? null,
        subject: m.subject ?? '(no subject)',
        from_name: m.from?.emailAddress?.name ?? null,
        from_address: m.from?.emailAddress?.address ?? null,
        body: plainBody(m),
        received_at: m.receivedDateTime,
        kind: 'unknown',
      })),
    );

    if (deltaLink && deltaLink !== session.deltaLink) {
      await saveDeltaLink(session.traderId, deltaLink);
    }

    return NextResponse.json({
      signedIn: true,
      newIds: fresh.map((m) => m.id),
      messages: await recentMessages(session.traderId),
    });
  } catch (err) {
    if (err instanceof GraphError) {
      // 401 here means the access token was refused despite a silent refresh —
      // usually a revoked grant. Send the trader back to sign-in rather than looping.
      const status = err.status === 401 ? 401 : 502;
      return NextResponse.json(
        { signedIn: err.status !== 401, error: `Mailbox read failed (${err.status}).` },
        { status },
      );
    }
    return NextResponse.json({ signedIn: true, error: 'Poll failed.' }, { status: 500 });
  }
}
