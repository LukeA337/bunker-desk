import {
  perUnitToUsdPerMt, computeLine, rankQuotes, rankByHeadline, applyMargin,
} from './engine';

let fails = 0;
function near(label: string, got: number, want: number, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got ${got.toFixed(4)}  want ${want.toFixed(4)}`);
}

// --- unit conversion: USD/m3 -> USD/MT divides by density
near('m3->MT VLSFO 508.00', perUnitToUsdPerMt(508, 'USD', 'm3', 'VLSFO'), 508 / 0.945);
near('m3->MT MGO 601.50', perUnitToUsdPerMt(601.5, 'USD', 'm3', 'MGO'), 601.5 / 0.86);
near('MT stays MT', perUnitToUsdPerMt(534.5, 'USD', 'mt', 'VLSFO'), 534.5);
near('EUR->USD per MT', perUnitToUsdPerMt(100, 'EUR', 'mt', 'MGO'), 108);

// --- Vendor A: clean all-in, 850 MT VLSFO
const a = computeLine({ grade: 'VLSFO', quantity: 850, basePrice: 534.5, port: 'NLRTM' });
near('A total/MT', a.totalPerMt, 534.5);
near('A total cost', a.totalCost, 534.5 * 850);

// --- Vendor B: base + lumpsums + per-unit + percentage
const b = computeLine({
  grade: 'VLSFO', quantity: 850, basePrice: 521.0, port: 'NLRTM',
  components: [
    { label: 'Barge delivery', basis: 'lumpsum', amount: 3850 },
    { label: 'Wharfage', basis: 'per_unit', amount: 1.2 },
    { label: 'Pumping / hose', basis: 'lumpsum', amount: 950 },
    { label: 'Sampling & testing', basis: 'lumpsum', amount: 420 },
    { label: 'Overtime (weekend)', basis: 'lumpsum', amount: 1100 },
    { label: 'Agency fee', basis: 'per_unit', amount: 0.85 },
    { label: 'Environmental levy', basis: 'percentage', amount: 0.9, appliesTo: 'subtotal' },
  ],
});
const bSub = 521 + (3850 + 950 + 420 + 1100) / 850 + 1.2 + 0.85;
near('B subtotal before levy', bSub, 530.4853);
near('B total/MT (levy on subtotal, not on levy)', b.totalPerMt, bSub * 1.009);

// --- Vendor C: quoted per m3 — looks cheapest, is not
const c = computeLine({ grade: 'VLSFO', quantity: 850, basePrice: 508.0, priceUnit: 'm3', port: 'NLRTM' });
near('C total/MT', c.totalPerMt, 508 / 0.945);
console.log(`      C headline 508.00/m3 reads cheaper than B 521.00/MT but lands at ${c.totalPerMt.toFixed(2)}/MT`);

// --- Vendor D: base only -> fee profile fills in, flagged estimate
const d = computeLine({ grade: 'VLSFO', quantity: 850, basePrice: 519.0, port: 'NLRTM', assumeFees: true });
const dSub = 519 + (4200 + 900 + 400) / 850 + 1.15;
near('D total/MT from profile', d.totalPerMt, dSub * 1.009);
if (!d.isEstimate) { fails++; console.log('FAIL  D must be flagged isEstimate'); }
else console.log('PASS  D flagged isEstimate');

// --- the shape-of-fees point: same profile, small stem, very different per-MT
const dMgo = computeLine({ grade: 'MGO', quantity: 120, basePrice: 685, port: 'NLRTM', assumeFees: true });
const dMgoSub = 685 + (1800 + 400) / 120 + 1.15;
near('D MGO on a 120 MT stem', dMgo.totalPerMt, dMgoSub * 1.009);
console.log(`      barge+sampling = ${((1800 + 400) / 120).toFixed(2)}/MT on 120 MT vs ${((4200 + 900 + 400) / 850).toFixed(2)}/MT on 850 MT`);

// --- ranking is on total cost, and the headline order differs
const lines = [
  { v: 'A', ...a }, { v: 'B', ...b }, { v: 'C', ...c }, { v: 'D', ...d },
];
console.log('      by total cost :', rankQuotes(lines).map((l) => `${l.v} ${l.totalPerMt.toFixed(2)}`).join('  '));
console.log('      by headline   :', rankByHeadline(lines).map((l) => `${l.v} ${l.headlinePrice.toFixed(2)}`).join('  '));

// --- margin
near('margin $/MT sell', applyMargin(534.5, 850, { basis: 'per_unit', value: 12 }).sellPerMt, 546.5);
near('margin $/MT total', applyMargin(534.5, 850, { basis: 'per_unit', value: 12 }).marginTotal, 10200);
near('margin % sell', applyMargin(534.5, 850, { basis: 'percentage', value: 2.5 }).sellPerMt, 534.5 * 1.025);
near('margin lumpsum /MT', applyMargin(534.5, 850, { basis: 'lumpsum', value: 8500 }).marginPerMt, 10);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
