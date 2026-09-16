import { requireSession, getSessionTraderId } from '@/lib/auth';
import { getTrader } from '@/lib/db';
import Desk from './Desk';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();

  if (!session) {
    return (
      <div className="signin">
        <h1>Stemline Bunker Desk</h1>
        <p>
          Watches your Outlook inbox for vendor quotes, normalizes every format to true delivered
          cost, and sends the client quote as a threaded reply.
        </p>
        {error && (
          <div className="notice err" style={{ marginBottom: 20 }}>
            <span>{error}</span>
          </div>
        )}
        <a className="btn primary" href="/api/auth/signin">
          Connect Outlook
        </a>
        <p className="hint" style={{ marginTop: 20 }}>
          Read and send access to your own mailbox only. Nothing is sent without you clicking Send.
        </p>
      </div>
    );
  }

  const traderId = await getSessionTraderId();
  const trader = traderId ? await getTrader(traderId) : null;

  return <Desk traderName={trader?.display_name ?? 'Trader'} traderEmail={trader?.email ?? ''} />;
}
