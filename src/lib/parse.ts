import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

const client = new Anthropic();

/* ---- what we ask Claude for -------------------------------------------- */

const ComponentSchema = z.object({
  label: z.string().describe('Normalized fee name, e.g. "Barge delivery"'),
  rawLabel: z.string().nullable().describe("The supplier's own wording, verbatim"),
  basis: z.enum(['per_unit', 'lumpsum', 'percentage']),
  amount: z.number(),
  currency: z.string().describe('ISO code; USD if unstated'),
  unit: z.enum(['mt', 'm3']).nullable().describe('For per_unit fees only'),
  appliesTo: z.enum(['base', 'subtotal']).nullable().describe('For percentage fees only'),
});

const QuoteLineSchema = z.object({
  grade: z.string().describe('VLSFO, HSFO, ULSFO, MGO, MDO or B24'),
  basePrice: z.number().describe('Product price only — never a fee'),
  currency: z.string(),
  priceUnit: z.enum(['mt', 'm3']),
  baseRawLabel: z.string().nullable(),
  components: z.array(ComponentSchema),
});

const VendorQuoteSchema = z.object({
  vendor: z.string(),
  lines: z.array(QuoteLineSchema),
  validMinutes: z.number().nullable().describe('Stated validity in minutes, null if unstated'),
  confidence: z.number().describe('0 to 1 — how sure you are of this extraction'),
  unmapped: z.array(z.string()).describe('Phrases carrying commercial meaning you could not turn into a number'),
});

const EnquiryLineSchema = z.object({
  grade: z.string(),
  quantity: z.number(),
  unit: z.enum(['mt', 'm3']),
  spec: z.string().nullable(),
});

const EnquirySchema = z.object({
  client: z.string().nullable(),
  vessel: z.string().nullable(),
  imo: z.string().nullable(),
  port: z.string().nullable(),
  portCode: z.string().nullable().describe('UN/LOCODE such as NLRTM, if derivable'),
  agent: z.string().nullable(),
  windowText: z.string().nullable().describe('Delivery window as written'),
  lines: z.array(EnquiryLineSchema),
});

const ParsedEmailSchema = z.object({
  kind: z.enum(['enquiry', 'quote', 'other']),
  enquiry: EnquirySchema.nullable(),
  quotes: z.array(VendorQuoteSchema),
});

export type ParsedEmail = z.infer<typeof ParsedEmailSchema>;
export type ParsedVendorQuote = z.infer<typeof VendorQuoteSchema>;

/* ---- the stable prefix (cached) ----------------------------------------
   Everything here is byte-identical across calls, so it caches. Only the email
   text varies, and it goes last, in the user turn.                         */

const SYSTEM = `You read email from a marine bunker (ship fuel) trading desk and turn it into structured data.

Classify the email as one of:
- "enquiry" — a client asking the desk to quote a stem (vessel, port, quantities).
- "quote"   — a supplier price, usually forwarded by a purchasing centre. One email may carry SEVERAL vendors.
- "other"   — anything else. Return empty enquiry and quotes.

EXTRACTING A QUOTE

basePrice is the PRODUCT price only. Never fold a fee into it.

Every other charge is a component with one of three bases:
- "lumpsum"    — a flat sum for the whole delivery ("barge hire USD 3,850", "USD 950 for pumping").
- "per_unit"   — stated per tonne or per cubic metre ("wharfage USD 1.20/mt").
- "percentage" — stated as a percentage. amount is the NUMBER OF PERCENT (0.9, not 0.009).
  Set appliesTo to "subtotal" unless the email says it applies to the base price alone.

priceUnit matters enormously. A price "per m3" is NOT the same as a price per tonne, and
quoting one as the other is the single most expensive mistake in this workflow. Read carefully.

rawLabel is the supplier's own wording, copied verbatim. Never normalize it away — the trader
needs to see what was actually written.

unmapped is for phrases that carry commercial meaning but are not a number you could place:
"subject board approval", "usual fees apply", "price subject to confirmation", "ex-wharf basis".
Anything you drop silently could cost the desk real money, so put it here instead.

Do NOT invent fees. If a supplier quotes a bare base price and says "usual fees apply", return
the base price, no components, and put that phrase in unmapped. The pricing engine fills the
gap from a configured fee profile and flags the result as an estimate — that is not your job.

confidence should be low when the format is ambiguous, quantities are missing, or you had to guess.

Several vendors in one email means several entries in quotes, each with its own vendor name.`;

/* ---- the call ----------------------------------------------------------- */

export class ParseError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

export async function parseEmail(subject: string, body: string): Promise<ParsedEmail> {
  // Keep the prompt bounded — quote emails are short, forwarded chains are not.
  const text = body.length > 12000 ? `${body.slice(0, 12000)}\n\n[truncated]` : body;

  try {
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Subject: ${subject}\n\n${text}` }],
      output_config: {
        format: zodOutputFormat(ParsedEmailSchema),
        // Extraction is not hard reasoning; low effort keeps latency down, which
        // is what matters against a 10-minute quote expiry.
        effort: 'low',
      },
    });

    if (response.stop_reason === 'refusal') {
      throw new ParseError('Claude declined to parse this email.', 'refused');
    }
    if (!response.parsed_output) {
      throw new ParseError('No structured output came back.', 'invalid_json');
    }
    return response.parsed_output;
  } catch (err) {
    if (err instanceof ParseError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ParseError('ANTHROPIC_API_KEY is missing or invalid.', 'auth');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ParseError('Rate limited — wait a moment and retry.', 'rate_limited');
    }
    if (err instanceof Anthropic.APIError) {
      throw new ParseError(`Claude API error ${err.status}.`, 'api_error');
    }
    throw new ParseError('Could not parse this email.', 'unknown');
  }
}
