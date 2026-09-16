import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  ParsedEmailSchema, SYSTEM, ParseError, boundedBody,
  type ParsedEmail,
} from './schema';

let client: OpenAI | null = null;
const getClient = () => (client ??= new OpenAI());

/** Override with OPENAI_MODEL. gpt-6-astra is the flagship, worth it if extraction
 *  accuracy on messy formats matters more than the price difference. */
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-terra';

export async function parseEmail(subject: string, body: string): Promise<ParsedEmail> {
  try {
    const response = await getClient().responses.parse({
      model: MODEL,
      // The instructions never vary, so they stay out of the input, which keeps
      // the one thing that does vary — the email — isolated at the end.
      instructions: SYSTEM,
      input: `Subject: ${subject}\n\n${boundedBody(body)}`,
      text: { format: zodTextFormat(ParsedEmailSchema, 'parsed_email') },
    });

    if (response.status === 'incomplete') {
      throw new ParseError('The model stopped before finishing. Try one vendor at a time.', 'incomplete');
    }
    if (!response.output_parsed) {
      throw new ParseError('No structured output came back.', 'invalid_json');
    }
    return response.output_parsed;
  } catch (err) {
    if (err instanceof ParseError) throw err;
    if (err instanceof OpenAI.AuthenticationError) {
      throw new ParseError('OPENAI_API_KEY is missing or invalid.', 'auth');
    }
    if (err instanceof OpenAI.RateLimitError) {
      throw new ParseError('Rate limited — wait a moment and retry.', 'rate_limited');
    }
    if (err instanceof OpenAI.BadRequestError) {
      throw new ParseError(`Request rejected: ${err.message.slice(0, 160)}`, 'bad_request');
    }
    if (err instanceof OpenAI.APIError) {
      throw new ParseError(`OpenAI API error ${err.status}.`, 'api_error');
    }
    throw new ParseError('Could not parse this email.', 'unknown');
  }
}
