/* Microsoft Graph — the mailbox watcher and the send path.
 *
 * Why delta polling and not webhooks: Microsoft documents change-notification latency
 * for Outlook messages as average under 1 minute, MAXIMUM 3 MINUTES. Against a 10-minute
 * quote validity that is unusable. A delta query returns only what is new and its latency
 * is our poll interval, which we control. */

const GRAPH = 'https://graph.microsoft.com/v1.0';

const SELECT = [
  'id', 'internetMessageId', 'conversationId', 'subject',
  'from', 'body', 'bodyPreview', 'receivedDateTime',
].join(',');

const INITIAL_DELTA =
  `${GRAPH}/me/mailFolders('inbox')/messages/delta?$select=${SELECT}&$top=25`;

async function graphFetch(url: string, token: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Ask for plain text bodies: quote emails are text, and HTML would need stripping.
      Prefer: 'outlook.body-content-type="text"',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GraphError(res.status, detail.slice(0, 600));
  }
  return res;
}

export class GraphError extends Error {
  constructor(public status: number, public detail: string) {
    super(`Graph ${status}: ${detail}`);
  }
}

export interface RawMessage {
  id: string;
  internetMessageId: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
  receivedDateTime: string;
  '@removed'?: unknown;
}

export interface PollResult { messages: RawMessage[]; deltaLink: string }

/**
 * One delta pass over the inbox. Pass the stored deltaLink to get only what is new;
 * pass null on the first run. Returns the next cursor — persist it.
 */
export async function pollInbox(token: string, deltaLink: string | null): Promise<PollResult> {
  let url = deltaLink ?? INITIAL_DELTA;
  const messages: RawMessage[] = [];
  let nextDelta = deltaLink ?? '';

  // Walk @odata.nextLink pages until Graph hands back the @odata.deltaLink cursor.
  for (let page = 0; page < 20; page++) {
    const res = await graphFetch(url, token);
    const json = (await res.json()) as {
      value?: RawMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    for (const m of json.value ?? []) {
      if (m['@removed']) continue;      // deletions are not our concern
      messages.push(m);
    }
    if (json['@odata.deltaLink']) { nextDelta = json['@odata.deltaLink']; break; }
    if (!json['@odata.nextLink']) break;
    url = json['@odata.nextLink'];
  }

  return { messages, deltaLink: nextDelta };
}

export async function getMessageBody(token: string, id: string): Promise<RawMessage> {
  const res = await graphFetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${SELECT}`, token);
  return (await res.json()) as RawMessage;
}

export interface Me { id: string; displayName: string; mail: string | null; userPrincipalName: string }

export async function getMe(token: string): Promise<Me> {
  const res = await graphFetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, token);
  return (await res.json()) as Me;
}

/**
 * Reply on the client's original thread and send it.
 *
 * `createReply` rather than a fresh message on purpose: it preserves conversationId and
 * the In-Reply-To / References headers, so the quote threads under the enquiry instead
 * of arriving as an orphan. Returns the sent draft's id for the audit trail.
 */
export async function replyAndSend(
  token: string, messageId: string, bodyText: string,
): Promise<string> {
  const draftRes = await graphFetch(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/createReply`,
    token, { method: 'POST', body: JSON.stringify({}) },
  );
  const draft = (await draftRes.json()) as { id: string };

  await graphFetch(`${GRAPH}/me/messages/${encodeURIComponent(draft.id)}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body: { contentType: 'text', content: bodyText } }),
  });

  await graphFetch(`${GRAPH}/me/messages/${encodeURIComponent(draft.id)}/send`, token, {
    method: 'POST',
  });

  return draft.id;
}

/** Strip an HTML body if Graph ignored the plain-text Prefer header. */
export function plainBody(m: RawMessage): string {
  const content = m.body?.content ?? m.bodyPreview ?? '';
  if (m.body?.contentType !== 'html') return content.trim();
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
