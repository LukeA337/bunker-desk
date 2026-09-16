import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ParsedEmailSchema, SYSTEM, ParseError, boundedBody,
  type ParsedEmail,
} from './schema';

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

/** Override with ANTHROPIC_MODEL. */
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

export async function parseEmail(subject: string, body: string): Promise<ParsedEmail> {
  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // The instructions never vary, so they cache; the email goes last.
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Subject: ${subject}\n\n${boundedBody(body)}` }],
      output_config: {
        format: zodOutputFormat(ParsedEmailSchema),
        // Extraction is not hard reasoning; low effort keeps latency down, which
        // is what matters against a 10-minute quote expiry.
        effort: 'low',
      },
    });

    if (response.stop_reason === 'refusal') {
      throw new ParseError('The model declined to parse this email.', 'refused');
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
    if (err instanceof Anthropic.BadRequestError) {
      throw new ParseError(`Request rejected: ${err.message.slice(0, 160)}`, 'bad_request');
    }
    if (err instanceof Anthropic.APIError) {
      throw new ParseError(`Anthropic API error ${err.status}.`, 'api_error');
    }
    throw new ParseError('Could not parse this email.', 'unknown');
  }
}
