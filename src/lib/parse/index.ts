/* Provider selection.
 *
 * The LLM only ever does extraction here — it hands structured data to a
 * deterministic pricing engine that has no model in its path. That is what makes
 * the provider swappable: changing models cannot change a price, only how well
 * the text was read. Both implementations share one schema and one prompt. */

import type { EmailParser, ParsedEmail } from './schema';

export { ParseError } from './schema';
export type { ParsedEmail, ParsedVendorQuote } from './schema';

export type Provider = 'anthropic' | 'openai';

/** Explicit LLM_PROVIDER wins; otherwise whichever key is present. Setting both
 *  keys without LLM_PROVIDER is ambiguous, so Anthropic wins and we say so. */
export function activeProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (hasAnthropic && hasOpenAI) {
    console.warn(
      'Both ANTHROPIC_API_KEY and OPENAI_API_KEY are set. Using Anthropic. ' +
      'Set LLM_PROVIDER to choose explicitly.',
    );
    return 'anthropic';
  }
  if (hasOpenAI) return 'openai';
  return 'anthropic';
}

export async function parseEmail(subject: string, body: string): Promise<ParsedEmail> {
  // Dynamic import so the unused provider's SDK never loads, and a missing
  // optional dependency can never break the other path.
  const provider = activeProvider();
  const mod: { parseEmail: EmailParser } = provider === 'openai'
    ? await import('./openai')
    : await import('./anthropic');
  return mod.parseEmail(subject, body);
}
