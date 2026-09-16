'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  rankQuotes, rankByHeadline, applyMargin, fmtMoney, fmtQty,
  type PricedLine, type Basis,
} from '@/lib/engine';

/* ---- shapes the API returns -------------------------------------------- */

interface Message {
  id: string; subject: string | null; from_name: string | null;
  from_address: string | null; body: string; received_at: string;
}
interface PricedVendor {
  vendor: string; confidence: number; unmapped: string[];
  validUntil: number | null; lines: PricedLine[];
}
interface Enquiry {
  client: string | null; vessel: string | null; imo: string | null;
  port: string | null; portCode: string | null; agent: string | null;
  windowText: string | null;
  lines: { grade: string; quantity: number; unit: string; spec: string | null }[];
}

type Row = PricedLine & { vendor: string; validUntil: number | null; confidence: number; unmapped: string[] };

const POLL_MS = 12_000;

export default function Desk({ traderName, traderEmail }: { traderName: string; traderEmail: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [enquiry, setEnquiry] = useState<Enquiry | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [vendors, setVendors] = useState<PricedVendor[]>([]);
  const [grade, setGrade] = useState<string>('');
  const [rankBy, setRankBy] = useState<'true' | 'head'>('true');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pickedVendor, setPicked] = useState<string | null>(null);
  const [margin, setMargin] = useState<{ basis: Basis; value: number }>({ basis: 'per_unit', value: 12 });
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef(false);

  /* ---- the watcher: poll while this tab is open ------------------------ */

  const poll = useCallback(async () => {
    if (pollRef.current) return;             // never stack polls
    pollRef.current = true;
    try {
      const res = await fetch('/api/poll', { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/'; return; }
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setMessages(data.messages ?? []);
      if (data.newIds?.length) {
        setNewIds((prev) => new Set([...prev, ...data.newIds]));
      }
      setError(null);
    } catch {
      setError('Could not reach the mailbox. Retrying.');
    } finally {
      pollRef.current = false;
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---- parsing --------------------------------------------------------- */

  const stems = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of enquiry?.lines ?? []) out[l.grade] = l.quantity;
    return out;
  }, [enquiry]);

  async function parseMessage(id: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: id, stems, port: enquiry?.portCode ?? 'NLRTM' }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Parse failed.'); return; }

      if (data.kind === 'enquiry' && data.enquiry) {
        setEnquiry(data.enquiry);
        setReplyTo(id);
        setVendors([]); setPicked(null); setSentAt(null);
        setGrade(data.enquiry.lines?.[0]?.grade ?? '');
      } else if (data.kind === 'quote') {
        if (!enquiry) {
          setError('Read the client enquiry first — the engine needs the stem quantities before it can price anything.');
          return;
        }
        setVendors((prev) => {
          const byName = new Map(prev.map((v) => [v.vendor, v]));
          for (const v of data.vendors as PricedVendor[]) byName.set(v.vendor, v);
          return [...byName.values()];
        });
      } else {
        setError('That email is neither an enquiry nor a vendor quote.');
      }
    } catch {
      setError('Parse failed.');
    } finally {
      setBusy(null);
    }
  }

  /* ---- grid ------------------------------------------------------------ */

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const v of vendors) {
      for (const l of v.lines) {
        if (l.grade !== grade) continue;
        out.push({ ...l, vendor: v.vendor, validUntil: v.validUntil, confidence: v.confidence, unmapped: v.unmapped });
      }
    }
    return out;
  }, [vendors, grade]);

  const ranked = rankBy === 'head' ? rankByHeadline(rows) : rankQuotes(rows);
  const cheapest = rows.length ? rankQuotes(rows)[0] : null;
  const isDead = (r: Row) => r.validUntil !== null && now > r.validUntil;

  const grades = useMemo(
    () => Array.from(new Set(vendors.flatMap((v) => v.lines.map((l) => l.grade)))),
    [vendors],
  );

  /* ---- composer -------------------------------------------------------- */

  const picked = vendors.find((v) => v.vendor === pickedVendor) ?? null;

  const quote = useMemo(() => {
    if (!picked || !enquiry) return null;
    const lines = picked.lines.map((l) => {
      const m = applyMargin(l.totalPerMt, l.stemMt, margin);
      return { ...l, ...m };
    });
    return {
      lines,
      cost: lines.reduce((s, l) => s + l.totalCost, 0),
      sell: lines.reduce((s, l) => s + l.sellTotal, 0),
      marginTotal: lines.reduce((s, l) => s + l.marginTotal, 0),
      estimated: lines.some((l) => l.isEstimate),
    };
  }, [picked, enquiry, margin]);

  const quoteText = useMemo(() => {
    if (!quote || !enquiry) return '';
    const head = [enquiry.vessel, enquiry.imo ? `(IMO ${enquiry.imo})` : null]
      .filter(Boolean).join(' ');
    let t = `${head} — ${enquiry.port ?? ''}${enquiry.portCode ? ` (${enquiry.portCode})` : ''}\n`;
    if (enquiry.windowText) t += `Delivery window ${enquiry.windowText}`;
    if (enquiry.agent) t += ` · Agent: ${enquiry.agent}`;
    t += '\n\n';
    for (const l of quote.lines) {
      t += `${l.grade}\n  ${fmtQty(l.stemMt)} MT ±5% MOLOO   USD ${fmtMoney(l.sellPerMt)} / MT\n`;
    }
    t += `\nDelivered ex-barge. All port charges, wharfage, pumping and sampling\nincluded. Payment 30 days from date of delivery.\n\n`;
    t += `Total: USD ${fmtMoney(quote.sell)}\n\nThis offer is valid 10 minutes from the time of this mail.\n\nBest regards,\n${traderName}`;
    return t;
  }, [quote, enquiry, traderName]);

  const [editedQuote, setEditedQuote] = useState<string | null>(null);
  useEffect(() => { setEditedQuote(null); }, [quoteText]);
  const outgoing = editedQuote ?? quoteText;

  async function send() {
    if (!replyTo || !quote) return;
    setBusy('send'); setError(null);
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replyToMessageId: replyTo,
          body: outgoing,
          marginBasis: margin.basis,
          marginValue: margin.value,
          costBreakdown: { vendor: picked?.vendor, lines: picked?.lines },
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Send failed.'); return; }
      setSentAt(new Date().toLocaleTimeString());
    } catch {
      setError('Send failed.');
    } finally {
      setBusy(null);
    }
  }

  /* ---- render ---------------------------------------------------------- */

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand"><b>Stemline</b><span>Back-to-back bunker desk</span></div>
          <span className="who">{traderEmail}</span>
          <button className="tbtn" onClick={poll}>Refresh inbox</button>
        </div>
      </header>

      <div className="wrap">
        {/* ══ inbox ══ */}
        <div className="col">
          <section className="panel">
            <div className="panel-hd">
              <span className="lbl">Inbox — polling every {POLL_MS / 1000}s</span>
              <span className="lbl num">{messages.length}</span>
            </div>
            <div className="feed">
              {messages.length === 0 && (
                <div className="feed-empty">
                  Watching your inbox. Mail yourself a client enquiry to start, then forward a
                  vendor quote.
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id}>
                  <button
                    className="msg"
                    data-sel={selected === m.id}
                    data-new={newIds.has(m.id)}
                    onClick={() => setSelected(selected === m.id ? null : m.id)}
                  >
                    <div className="msg-top">
                      <span className="msg-from">{m.from_name ?? m.from_address ?? 'Unknown'}</span>
                      <span className="msg-time num">
                        {new Date(m.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="msg-sub">{m.subject}</div>
                  </button>
                  {selected === m.id && (
                    <>
                      <pre className="raw">{m.body.slice(0, 2500)}</pre>
                      <div className="trail-act" style={{ padding: '11px 13px' }}>
                        <button
                          className="btn primary"
                          disabled={busy === m.id}
                          onClick={() => parseMessage(m.id)}
                        >
                          {busy === m.id ? 'Reading…' : 'Parse & price'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ══ main ══ */}
        <div className="col">
          {error && <div className="notice err"><span>{error}</span></div>}

          {enquiry && (
            <section className="panel">
              <div className="panel-hd">
                <span className="lbl">Enquiry</span>
                <span className="badge b-firm">Working</span>
              </div>
              <div className="pad">
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
                  {([
                    ['Vessel', enquiry.vessel], ['IMO', enquiry.imo],
                    ['Port', enquiry.portCode ?? enquiry.port], ['Window', enquiry.windowText],
                    ['Agent', enquiry.agent], ['Client', enquiry.client],
                  ] as const).filter(([, v]) => v).map(([k, v]) => (
                    <div key={k}>
                      <div className="lbl">{k}</div>
                      <div className="num" style={{ fontSize: 13.5 }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {enquiry.lines.map((l) => (
                    <div key={l.grade} className="badge b-conv" style={{ padding: '5px 10px', fontSize: 12 }}>
                      {fmtQty(l.quantity)} {l.unit.toUpperCase()} {l.grade}
                      {l.spec ? ` · ${l.spec}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {vendors.length > 0 && (
            <section className="panel">
              <div className="panel-hd"><span className="lbl">Vendor comparison</span></div>
              <div className="bar">
                <div className="seg" role="group" aria-label="Grade">
                  {grades.map((g) => (
                    <button key={g} aria-pressed={grade === g} onClick={() => { setGrade(g); setOpenRow(null); }}>
                      {g} · {fmtQty(stems[g] ?? 0)} MT
                    </button>
                  ))}
                </div>
                <div className="seg warnmode" role="group" aria-label="Ranking basis" style={{ marginLeft: 'auto' }}>
                  <button aria-pressed={rankBy === 'true'} onClick={() => setRankBy('true')}>True delivered total</button>
                  <button aria-pressed={rankBy === 'head'} onClick={() => setRankBy('head')}>Headline price as quoted</button>
                </div>
              </div>

              {rankBy === 'head' && (
                <div className="notice">
                  <span>
                    <b>Headline order is the mistake the manual process makes.</b> These are the numbers
                    as they appear in the emails — before unit conversion, before lumpsums are amortised
                    over the stem, before assumed fees.
                  </span>
                </div>
              )}

              <div className="gridhd">
                <span className="lbl">#</span>
                <span className="lbl">Vendor</span>
                <span className="lbl ar">As quoted</span>
                <span className="lbl ar">Total USD/MT</span>
                <span className="lbl ar">Total {fmtQty(stems[grade] ?? 0)} MT</span>
                <span className="lbl ar">Expires</span>
                <span />
              </div>

              {ranked.map((r, i) => {
                const dead = isDead(r);
                const best = rankBy === 'true' && i === 0 && !dead;
                const diff = cheapest ? r.totalPerMt - cheapest.totalPerMt : 0;
                const key = `${r.vendor}-${r.grade}`;
                const left = r.validUntil === null ? null : r.validUntil - now;
                return (
                  <div key={key} className={`qrow${best ? ' best' : ''}${dead ? ' dead' : ''}`}>
                    <button className="qrow-main" onClick={() => setOpenRow(openRow === key ? null : key)}>
                      <span className="rank">{i + 1}</span>
                      <span>
                        <span className="vname">{r.vendor}</span>
                        <span className="vmeta">parse confidence {Math.round(r.confidence * 100)}%</span>
                        <span className="badges">
                          {r.isEstimate && <span className="badge b-est">Fees estimated</span>}
                          {r.headlineUnit.endsWith('m3') && <span className="badge b-conv">m³ → MT converted</span>}
                          {!r.isEstimate && !dead && <span className="badge b-firm">Firm</span>}
                          {dead && <span className="badge b-dead">Expired</span>}
                        </span>
                      </span>
                      <span className="ar headline">
                        <span className="mlbl">As quoted</span>
                        {fmtMoney(r.headlinePrice)}
                        <br /><span className="delta">{r.headlineUnit.endsWith('m3') ? '/m³' : '/MT'}</span>
                      </span>
                      <span className="ar">
                        <span className="mlbl">Total USD/MT</span>
                        <span className="permt">{fmtMoney(r.totalPerMt)}</span>
                        <br /><span className="delta">{Math.abs(diff) < 0.005 ? 'cheapest' : `+${fmtMoney(diff)}`}</span>
                      </span>
                      <span className="ar total">
                        <span className="mlbl">Total</span>{fmtMoney(r.totalCost)}
                      </span>
                      <span className="ar">
                        <span className="mlbl">Expires</span>
                        <span className={`cd${left === null ? '' : left <= 0 ? ' crit' : left < 180_000 ? ' warn' : ''}`}>
                          {left === null ? '—'
                            : left <= 0 ? 'EXPIRED'
                            : `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`}
                        </span>
                      </span>
                      <span className="caret">{openRow === key ? '▾' : '▸'}</span>
                    </button>

                    {openRow === key && (
                      <div className="trail">
                        <table>
                          <thead>
                            <tr>
                              <th>Component</th><th>Basis</th><th className="ar">As quoted</th>
                              <th className="ar">USD/MT</th><th className="ar">USD total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.trail.map((t, ti) => (
                              <tr key={ti}>
                                <td>
                                  {t.label}
                                  {t.rawLabel && <span className="rawlbl">“{t.rawLabel}”</span>}
                                  {t.isEstimate && <span className="badge b-est"> Est</span>}
                                </td>
                                <td>
                                  {t.basis === 'per_unit' ? 'Per unit' : t.basis === 'lumpsum' ? 'Lumpsum' : 'Percentage'}
                                  {t.note && <span className="note">{t.note}</span>}
                                </td>
                                <td className="ar q">
                                  {t.basis === 'percentage'
                                    ? `${t.rawAmount}%`
                                    : `${t.rawCurrency} ${fmtMoney(t.rawAmount)}${t.basis === 'lumpsum' ? ' LS' : `/${t.rawUnit === 'm3' ? 'm³' : 'MT'}`}`}
                                </td>
                                <td className="ar q">{fmtMoney(t.usdPerMt)}</td>
                                <td className="ar q">{fmtMoney(t.usdTotal)}</td>
                              </tr>
                            ))}
                            <tr className="sum">
                              <td colSpan={3}>Total delivered — {fmtQty(r.stemMt)} MT {r.grade}</td>
                              <td className="ar q">{fmtMoney(r.totalPerMt)}</td>
                              <td className="ar q">{fmtMoney(r.totalCost)}</td>
                            </tr>
                          </tbody>
                        </table>

                        {r.unmapped.length > 0 && (
                          <div className="unmapped">
                            <b>Not accounted for in this total:</b>{' '}
                            {r.unmapped.map((u, ui) => <code key={ui}>“{u}” </code>)}
                            — read the source before you commit.
                          </div>
                        )}
                        {r.isEstimate && (
                          <div className="unmapped">
                            <b>This vendor quoted a base price only.</b> The fees above come from the port
                            fee profile, not the supplier. Confirm them before quoting this as firm.
                          </div>
                        )}

                        <div className="trail-act">
                          <button
                            className="btn primary"
                            disabled={dead}
                            onClick={() => { setPicked(r.vendor); setSentAt(null); }}
                          >
                            {dead ? 'Expired — cannot quote' : 'Quote this vendor'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {picked && quote && (
            <section className="panel">
              <div className="panel-hd">
                <span className="lbl">Client quote</span>
                <span className="badge b-conv">Back-to-back · {picked.vendor}</span>
              </div>

              {sentAt ? (
                <div className="sent">
                  <span>✓</span>
                  <span>
                    Quote sent at <b className="num">{sentAt}</b> — USD {fmtMoney(quote.sell)},
                    margin USD {fmtMoney(quote.marginTotal)}. It threads under the client&rsquo;s enquiry.
                  </span>
                </div>
              ) : (
                <div className="comp-grid">
                  <div className="comp-side">
                    {quote.estimated && (
                      <div className="unmapped" style={{ margin: '0 0 13px' }}>
                        <b>This vendor&rsquo;s fees are estimated.</b> Sending commits the desk to a cost the
                        supplier has not confirmed. Confirm the fee schedule, or quote a firm vendor.
                      </div>
                    )}
                    <div className="field">
                      <label className="lbl" htmlFor="marginBasis">Margin basis</label>
                      <select
                        id="marginBasis" value={margin.basis}
                        onChange={(e) => {
                          const basis = e.target.value as Basis;
                          setMargin({ basis, value: basis === 'percentage' ? 2.5 : basis === 'lumpsum' ? 10000 : 12 });
                        }}
                      >
                        <option value="per_unit">USD per MT</option>
                        <option value="percentage">Percentage of cost</option>
                        <option value="lumpsum">Lumpsum on the stem</option>
                      </select>
                    </div>
                    <div className="field">
                      <label className="lbl" htmlFor="marginValue">Margin value</label>
                      <input
                        id="marginValue" type="number" step="0.5" value={margin.value}
                        onChange={(e) => setMargin({ ...margin, value: Number(e.target.value) || 0 })}
                      />
                    </div>
                    {quote.lines.map((l) => (
                      <div key={l.grade}>
                        <div className="figline">
                          <span className="k">{l.grade} cost</span>
                          <span className="v">{fmtMoney(l.totalPerMt)}/MT</span>
                        </div>
                        <div className="figline">
                          <span className="k">{l.grade} sell</span>
                          <span className="v">{fmtMoney(l.sellPerMt)}/MT</span>
                        </div>
                      </div>
                    ))}
                    <div className="figline">
                      <span className="k">Cost of goods</span>
                      <span className="v">{fmtMoney(quote.cost)}</span>
                    </div>
                    <div className="figline big">
                      <span className="k">Margin</span>
                      <span className="v">{fmtMoney(quote.marginTotal)}</span>
                    </div>
                  </div>

                  <div className="comp-main">
                    <div className="lbl" style={{ marginBottom: 7 }}>
                      Replies on the client&rsquo;s original thread
                    </div>
                    <textarea
                      className="quotebox" rows={14} value={outgoing}
                      onChange={(e) => setEditedQuote(e.target.value)}
                    />
                    <div className="trail-act">
                      <button className="btn send" disabled={busy === 'send' || !replyTo} onClick={send}>
                        {busy === 'send' ? 'Sending…' : `Send quote — USD ${fmtMoney(quote.sell)}`}
                      </button>
                      <button className="btn" onClick={() => setPicked(null)}>Pick another vendor</button>
                    </div>
                    {!replyTo && (
                      <p className="hint" style={{ marginTop: 9 }}>
                        No client enquiry selected to reply to — parse the enquiry email first.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {!enquiry && !error && (
            <section className="panel">
              <div className="placeholder">
                Pick the client&rsquo;s enquiry from the inbox and press <b>Parse &amp; price</b>.
                Then do the same for each vendor quote as it arrives.
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
