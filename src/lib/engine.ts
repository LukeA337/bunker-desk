/* Bunker pricing engine — deterministic, no LLM anywhere near it.
   Normalizes heterogeneous vendor quotes to a comparable total delivered cost.
   This is the part that must never be wrong: it is pure, and tested in engine.test.ts. */

export type Basis = 'per_unit' | 'lumpsum' | 'percentage';
export type Unit = 'mt' | 'm3';

export interface Component {
  label: string;
  rawLabel?: string | null;   // the supplier's own wording — never discarded
  basis: Basis;
  amount: number;
  currency?: string;
  unit?: Unit;
  appliesTo?: 'base' | 'subtotal';
  isEstimate?: boolean;
}

export interface LineInput {
  grade: string;
  quantity: number;
  quantityUnit?: Unit;
  basePrice: number;
  currency?: string;
  priceUnit?: Unit;
  baseRawLabel?: string | null;
  components?: Component[];
  port?: string;
  assumeFees?: boolean;
  assumeFeesRawLabel?: string | null;
}

export interface TrailRow {
  label: string;
  rawLabel: string | null;
  basis: Basis;
  rawAmount: number;
  rawCurrency: string;
  rawUnit: Unit | null;
  usdPerMt: number;
  usdTotal: number;
  isEstimate: boolean;
  converted: boolean;
  note: string | null;
}

export interface PricedLine {
  grade: string;
  stemMt: number;
  headlinePrice: number;      // the number the eye lands on in the email
  headlineUnit: string;
  basePerMt: number;
  feesPerMt: number;
  totalPerMt: number;
  totalCost: number;
  isEstimate: boolean;
  trail: TrailRow[];
}

/* ---- Configurable reference data -------------------------------------- */

/** Density in MT per m3 at 15C. Surfaced in the UI wherever a conversion applies —
 *  an assumption the trader can see is an assumption the trader can correct. */
export const DENSITY: Record<string, number> = {
  VLSFO: 0.945, HSFO: 0.991, ULSFO: 0.930,
  MGO: 0.860, LSMGO: 0.860, MDO: 0.890, B24: 0.940,
};

/** Quoted currency -> USD. Configured per enquiry, not fetched live. */
export const FX: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27, SGD: 0.74, AED: 0.272,
};

/** Fee profiles fill in what a vendor omitted ("usual fees apply").
 *  Everything resolved from here is flagged isEstimate and rendered as an estimate. */
export const FEE_PROFILES: Record<string, Component[]> = {
  'NLRTM|VLSFO': [
    { label: 'Barge delivery',     basis: 'lumpsum',    amount: 4200, currency: 'USD' },
    { label: 'Wharfage',           basis: 'per_unit',   amount: 1.15, currency: 'USD' },
    { label: 'Pumping / hose',     basis: 'lumpsum',    amount: 900,  currency: 'USD' },
    { label: 'Sampling & testing', basis: 'lumpsum',    amount: 400,  currency: 'USD' },
    { label: 'Environmental levy', basis: 'percentage', amount: 0.9, appliesTo: 'subtotal' },
  ],
  'NLRTM|MGO': [
    { label: 'Barge delivery',     basis: 'lumpsum',    amount: 1800, currency: 'USD' },
    { label: 'Wharfage',           basis: 'per_unit',   amount: 1.15, currency: 'USD' },
    { label: 'Sampling & testing', basis: 'lumpsum',    amount: 400,  currency: 'USD' },
    { label: 'Environmental levy', basis: 'percentage', amount: 0.9, appliesTo: 'subtotal' },
  ],
};

export const density = (grade: string): number => DENSITY[grade] ?? 0.95;
export const fx = (currency: string): number => FX[currency] ?? 1;
export const toUsd = (amount: number, currency = 'USD'): number => amount * fx(currency);

/** Stem quantity normalized to MT before anything is amortized over it. */
export const stemToMt = (quantity: number, unit: Unit = 'mt', grade: string): number =>
  unit === 'm3' ? quantity * density(grade) : quantity;

/** A per-unit figure quoted in USD/m3 becomes USD/MT by DIVIDING by density:
 *  one tonne occupies more than one cubic metre for every marine grade. */
export function perUnitToUsdPerMt(
  amount: number, currency: string, unit: Unit, grade: string,
): number {
  const usd = toUsd(amount, currency);
  return unit === 'm3' ? usd / density(grade) : usd;
}

export const lookupProfile = (port: string | undefined, grade: string): Component[] | null =>
  (port ? FEE_PROFILES[`${port}|${grade}`] : null) ?? null;

/* ---- The pipeline ------------------------------------------------------
   1 currency normalize -> 2 unit normalize -> 3 resolve omitted fees from profile
   -> 4 amortize lumpsums over the stem -> 5 apply percentages to the subtotal
   -> 6 total -> (ranking happens in rankQuotes)                            */

export function computeLine(input: LineInput): PricedLine {
  const { grade } = input;
  const stemMt = stemToMt(input.quantity, input.quantityUnit ?? 'mt', grade);
  const currency = input.currency ?? 'USD';
  const priceUnit: Unit = input.priceUnit ?? 'mt';
  const trail: TrailRow[] = [];

  /* 1+2 — base product */
  const basePerMt = perUnitToUsdPerMt(input.basePrice, currency, priceUnit, grade);
  trail.push({
    label: 'Base product', rawLabel: input.baseRawLabel ?? null, basis: 'per_unit',
    rawAmount: input.basePrice, rawCurrency: currency, rawUnit: priceUnit,
    usdPerMt: basePerMt, usdTotal: basePerMt * stemMt,
    isEstimate: false, converted: priceUnit === 'm3' || currency !== 'USD',
    note: priceUnit === 'm3' ? `Converted at ${density(grade).toFixed(3)} MT/m3` : null,
  });

  /* 3 — anything the vendor didn't quote comes from the fee profile, as an estimate */
  let components = input.components ? [...input.components] : [];
  let estimated = false;
  if (input.assumeFees && components.length === 0) {
    const profile = lookupProfile(input.port, grade);
    if (profile) {
      estimated = true;
      components = profile.map((c) => ({
        ...c, isEstimate: true, rawLabel: input.assumeFeesRawLabel ?? null,
      }));
    }
  }

  /* 4 — absolutes first: per-unit as quoted, lumpsums amortized over the stem */
  let absolutesPerMt = 0;
  for (const c of components) {
    if (c.basis === 'percentage') continue;
    const perMt = c.basis === 'lumpsum'
      ? toUsd(c.amount, c.currency) / stemMt
      : perUnitToUsdPerMt(c.amount, c.currency ?? 'USD', c.unit ?? 'mt', grade);
    absolutesPerMt += perMt;
    trail.push({
      label: c.label, rawLabel: c.rawLabel ?? null, basis: c.basis,
      rawAmount: c.amount, rawCurrency: c.currency ?? 'USD', rawUnit: c.unit ?? 'mt',
      usdPerMt: perMt, usdTotal: perMt * stemMt,
      isEstimate: !!c.isEstimate, converted: c.unit === 'm3',
      note: c.basis === 'lumpsum' ? `Lumpsum over ${fmtQty(stemMt)} MT` : null,
    });
    if (c.isEstimate) estimated = true;
  }

  /* 5 — percentages apply to the subtotal, never compounding on each other */
  const subtotalPerMt = basePerMt + absolutesPerMt;
  let percentPerMt = 0;
  for (const c of components) {
    if (c.basis !== 'percentage') continue;
    const applyTo = c.appliesTo === 'base' ? basePerMt : subtotalPerMt;
    const perMt = applyTo * (c.amount / 100);
    percentPerMt += perMt;
    trail.push({
      label: c.label, rawLabel: c.rawLabel ?? null, basis: 'percentage',
      rawAmount: c.amount, rawCurrency: '%', rawUnit: null,
      usdPerMt: perMt, usdTotal: perMt * stemMt,
      isEstimate: !!c.isEstimate, converted: false,
      note: `${c.amount}% of ${c.appliesTo === 'base' ? 'base price' : 'subtotal'}`,
    });
    if (c.isEstimate) estimated = true;
  }

  /* 6 — total cost for THIS parcel; the unit rate is derived from it, never the reverse */
  const totalPerMt = subtotalPerMt + percentPerMt;

  return {
    grade, stemMt,
    headlinePrice: input.basePrice,
    headlineUnit: `${currency}/${priceUnit}`,
    basePerMt,
    feesPerMt: absolutesPerMt + percentPerMt,
    totalPerMt,
    totalCost: totalPerMt * stemMt,
    isEstimate: estimated,
    trail,
  };
}

type Rankable = PricedLine & { validUntil?: number | null };

/** Cheapest TOTAL first. Ties broken by the quote that stays alive longest. */
export function rankQuotes<T extends Rankable>(lines: T[]): T[] {
  return [...lines].sort((a, b) => {
    const d = a.totalCost - b.totalCost;
    if (Math.abs(d) > 0.005) return d;
    return (b.validUntil ?? 0) - (a.validUntil ?? 0);
  });
}

/** What a trader eyeballing the email would have ranked on — powers the
 *  "rank by headline price" toggle that shows the manual process's mistake. */
export function rankByHeadline<T extends Rankable>(lines: T[]): T[] {
  return [...lines].sort((a, b) => a.headlinePrice - b.headlinePrice);
}

export interface MarginRule { basis: Basis; value: number }

export function applyMargin(costPerMt: number, stemMt: number, rule?: MarginRule) {
  let marginPerMt: number;
  if (!rule) marginPerMt = 0;
  else if (rule.basis === 'percentage') marginPerMt = costPerMt * (rule.value / 100);
  else if (rule.basis === 'lumpsum') marginPerMt = rule.value / stemMt;
  else marginPerMt = rule.value;
  return {
    marginPerMt,
    marginTotal: marginPerMt * stemMt,
    sellPerMt: costPerMt + marginPerMt,
    sellTotal: (costPerMt + marginPerMt) * stemMt,
  };
}

export const fmtMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtQty = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 1 : 0 });
