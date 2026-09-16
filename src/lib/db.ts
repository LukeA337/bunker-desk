import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  // Fail loudly at import rather than with a confusing null later.
  console.warn('DATABASE_URL is not set — see README part 2.');
}

export const sql = neon(process.env.DATABASE_URL ?? '');

export interface Trader {
  id: string;
  display_name: string;
  email: string;
  home_account_id: string;
  token_cache: string;
  delta_link: string | null;
}

export async function getTrader(id: string): Promise<Trader | null> {
  const rows = (await sql`select * from trader where id = ${id}`) as Trader[];
  return rows[0] ?? null;
}

export async function upsertTrader(t: Omit<Trader, 'delta_link'>): Promise<void> {
  await sql`
    insert into trader (id, display_name, email, home_account_id, token_cache)
    values (${t.id}, ${t.display_name}, ${t.email}, ${t.home_account_id}, ${t.token_cache})
    on conflict (id) do update set
      display_name = excluded.display_name,
      email        = excluded.email,
      home_account_id = excluded.home_account_id,
      token_cache  = excluded.token_cache,
      updated_at   = now()
  `;
}

export async function saveTokenCache(traderId: string, cache: string): Promise<void> {
  await sql`update trader set token_cache = ${cache}, updated_at = now() where id = ${traderId}`;
}

export async function saveDeltaLink(traderId: string, deltaLink: string): Promise<void> {
  await sql`update trader set delta_link = ${deltaLink}, updated_at = now() where id = ${traderId}`;
}

export interface StoredMessage {
  id: string;
  internet_message_id: string;
  conversation_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  body: string;
  received_at: string;
  kind: string;
}

/** Dedupes on internetMessageId — a delta query WILL hand you the same message twice. */
export async function insertMessages(
  traderId: string, msgs: StoredMessage[],
): Promise<StoredMessage[]> {
  const fresh: StoredMessage[] = [];
  for (const m of msgs) {
    const rows = (await sql`
      insert into message (id, trader_id, internet_message_id, conversation_id, subject,
                           from_name, from_address, body, received_at, kind)
      values (${m.id}, ${traderId}, ${m.internet_message_id}, ${m.conversation_id},
              ${m.subject}, ${m.from_name}, ${m.from_address}, ${m.body},
              ${m.received_at}, ${m.kind})
      on conflict (trader_id, internet_message_id) do nothing
      returning *
    `) as StoredMessage[];
    if (rows[0]) fresh.push(rows[0]);
  }
  return fresh;
}

export async function recentMessages(traderId: string, limit = 40) {
  return (await sql`
    select * from message where trader_id = ${traderId}
    order by received_at desc limit ${limit}
  `) as StoredMessage[];
}

export async function getMessage(traderId: string, id: string) {
  const rows = (await sql`
    select * from message where trader_id = ${traderId} and id = ${id}
  `) as StoredMessage[];
  return rows[0] ?? null;
}

/** The audit trail. Every quote sent, with the cost basis behind it. */
export async function recordClientQuote(q: {
  enquiryId: number | null;
  vendorQuoteId: number | null;
  marginBasis: string;
  marginValue: number;
  costBreakdown: unknown;
  body: string;
  graphMessageId: string | null;
}): Promise<void> {
  await sql`
    insert into client_quote (enquiry_id, vendor_quote_id, margin_basis, margin_value,
                              cost_breakdown, body, graph_message_id)
    values (${q.enquiryId}, ${q.vendorQuoteId}, ${q.marginBasis}, ${q.marginValue},
            ${JSON.stringify(q.costBreakdown)}, ${q.body}, ${q.graphMessageId})
  `;
}
