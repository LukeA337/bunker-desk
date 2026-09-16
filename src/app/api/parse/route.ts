import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth';
import { getMessage } from '@/lib/db';
import { parseEmail, ParseError, type ParsedVendorQuote } from '@/lib/parse';
import { computeLine, type PricedLine, type Component } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Body {
  messageId: string;
  /** Stem quantities in MT, keyed by grade — from the enquiry the desk is working. */
  stems?: Record<string, number>;
  port?: string;
}

export interface PricedVendor {
  vendor: string;
  confidence: number;
  unmapped: string[];
  validUntil: number | null;
  lines: (PricedLine & { grade: string })[];
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ signedIn: false }, { status: 401 });

  const { messageId, stems = {}, port = 'NLRTM' } = (await req.json()) as Body;
  const message = await getMessage(session.traderId, messageId);
  if (!message) return NextResponse.json({ error: 'Message not found.' }, { status: 404 });

  try {
    const parsed = await parseEmail(message.subject ?? '', message.body);

    if (parsed.kind === 'enquiry') {
      return NextResponse.json({ kind: 'enquiry', enquiry: parsed.enquiry, raw: message.body });
    }
    if (parsed.kind !== 'quote' || parsed.quotes.length === 0) {
      return NextResponse.json({ kind: 'other', raw: message.body });
    }

    const received = new Date(message.received_at).getTime();
    const vendors: PricedVendor[] = parsed.quotes.map((q: ParsedVendorQuote) => ({
      vendor: q.vendor,
      confidence: q.confidence,
      unmapped: q.unmapped ?? [],
      validUntil: q.validMinutes ? received + q.validMinutes * 60_000 : null,
      lines: q.lines
        .map((l) => {
          // Only price grades the desk actually asked for; ignore the rest.
          const quantity = stems[l.grade];
          if (!quantity) return null;
          const components: Component[] = (l.components ?? []).map((c) => ({
            label: c.label,
            rawLabel: c.rawLabel,
            basis: c.basis,
            amount: c.amount,
            currency: c.currency || 'USD',
            unit: c.unit ?? undefined,
            appliesTo: c.appliesTo ?? undefined,
          }));
          return computeLine({
            grade: l.grade,
            quantity,
            port,
            basePrice: l.basePrice,
            currency: l.currency || 'USD',
            priceUnit: l.priceUnit,
            baseRawLabel: l.baseRawLabel,
            components,
            // A bare base price with no components means the supplier left fees
            // implicit — fill from the port profile and flag the total as estimated.
            assumeFees: components.length === 0,
            assumeFeesRawLabel: 'from port fee profile — not quoted by supplier',
          });
        })
        .filter((l): l is PricedLine => l !== null),
    }));

    return NextResponse.json({ kind: 'quote', vendors, raw: message.body });
  } catch (err) {
    if (err instanceof ParseError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return NextResponse.json({ error: 'Parse failed.' }, { status: 500 });
  }
}
