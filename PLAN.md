# Back-to-Back Bunker Trading Desk — Build Plan

**Target:** Working prototype / demo for Dan Bunkering
**Confirmed scope:** mailbox watcher with auto-parse · configurable fee engine · auto-send on trader approval

---

## 1. The core insight

The trader's real job in this workflow is **normalization under time pressure**. Five vendors quote the
same parcel five different ways — one all-in, one base + six line items, one in USD/m3 instead of USD/MT,
one with a quantity band, one with barge costs conditional on delivery mode. The trader's Excel exists
purely to make those five numbers comparable. Then a 10-minute clock runs out.

So the product is **not** "an email tool." It is one screen:

> **Every live vendor quote for this enquiry, normalized to total delivered USD/MT, ranked cheapest first,
> each with a countdown to expiry and the raw source text one click away.**

Everything else — intake, margin, outbound email — hangs off that screen. If the comparison grid is
right, the demo sells itself. If it's wrong, nothing else matters.

### What "cheapest" actually means

Ranking on unit price is the trap. The grid must rank on **total cost for this parcel**, because:

- Fee structures differ in *shape*, not just size. A lower base price with a fixed USD 3,500 barge fee
  loses to a higher base on a 200 MT stem and wins on a 2,000 MT stem.
- Lumpsum fees must be amortized across the actual stem quantity before anything is comparable.
- Multi-grade enquiries (e.g. 800 MT VLSFO + 120 MT MGO) need per-grade comparison **and** a combined
  basket view — the cheapest VLSFO vendor may not be the cheapest package once a single-supplier
  delivery saves a second barge call.

The engine therefore computes, per vendor per grade: `total_cost = Σ(all normalized components)` and
derives `USD/MT` from it — never the reverse.

---

## 2. Architecture

```
┌─────────────────┐
│  Mailbox        │  Simulated in demo: a scripted inbox that drips
│  watcher        │  vendor replies in on a timer with live expiry clocks.
└────────┬────────┘  Real mode: IMAP/Graph poller behind the same interface.
         │ raw message
         ▼
┌─────────────────┐
│  Classifier     │  Enquiry from client? Quote from purchasing centre?
└────────┬────────┘  Routes to the right parser. Cheap + fast.
         │
         ├──────────────► Enquiry parser ──► creates an Enquiry
         │
         ▼
┌─────────────────┐
│  Quote parser   │  LLM → strict JSON schema. Runs per vendor block,
│  (parallel)     │  in parallel, streaming into the grid as each lands.
└────────┬────────┘  Emits confidence + unmapped-text flags.
         │ ParsedQuote
         ▼
┌─────────────────┐
│  Pricing engine │  Deterministic. No LLM. Unit conversion, lumpsum
│  (pure TS)      │  amortization, fee resolution, total cost, ranking.
└────────┬────────┘  Fully unit-tested — this is the part that must never be wrong.
         │
         ▼
┌─────────────────┐
│ Comparison grid │  The screen. Ranked, live countdowns, raw text drawer.
└────────┬────────┘
         │ trader picks vendor + margin
         ▼
┌─────────────────┐
│ Quote composer  │  Renders client-facing quote. Trader reviews → Send.
└─────────────────┘
```

### Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router) + TypeScript | One process for UI + API routes; fast to demo |
| UI | Tailwind + shadcn/ui | Dense data grids without fighting CSS |
| Live updates | Server-Sent Events | Quotes stream in as parsed; simpler than WebSockets |
| Store | SQLite (better-sqlite3) | Zero-setup, real persistence, swappable for Postgres |
| LLM | Anthropic SDK — Claude Opus 5 (fast mode, low effort) | Structured outputs — see §11 |
| Email | Adapter interface: `MockMailbox` \| `GraphMailbox` | Demo runs on mock; production swaps the adapter only |

**Why the adapter matters:** the demo should never depend on a live mailbox — a network hiccup during a
client presentation kills it. The mock mailbox is also *better* for demoing, because you control the
timing: quotes arrive 20 seconds apart with a 10-minute expiry, and the pressure is visible on screen.

---

## 3. Data model

```
Enquiry            client, vessel, IMO, port (UN/LOCODE), agent,
                   delivery window (ETA/ETD), delivery mode, status,
                   source email ref
  └─ EnquiryLine   grade (VLSFO/HSFO/ULSFO/MGO/MDO/B24…), quantity,
                   unit (MT/m3), spec notes, quantity tolerance (±%)

Vendor             name, aliases (for matching messy email text),
                   default currency, default fee profile

VendorQuote        enquiry, vendor, received_at, valid_until,
                   raw_text, parse_confidence, unmapped_fragments[]
  └─ QuoteLine     enquiry_line, base_price, currency, unit,
                   component[] (see below), payment terms, quantity band

PriceComponent     label, raw_label (what the vendor called it),
                   basis: per_unit | lumpsum | percentage,
                   amount, currency, applies_to, is_estimate

FeeProfile         port + vendor + grade scoped defaults — the configurable
                   engine. Used to fill components the vendor omitted.

MarginRule         client-scoped: per_unit | percentage | lumpsum,
                   value, floor, target. Trader can override per quote.

ClientQuote        enquiry, chosen VendorQuote, margin applied,
                   rendered body, sent_at, expires_at
```

The `raw_label` + `unmapped_fragments` fields are the trust mechanism: the trader can always see what the
vendor literally wrote and what the parser could not account for. **Never silently drop text from a
supplier quote** — an unmapped fragment is surfaced as a warning badge on that vendor's row.

---

## 4. The pricing engine

Pure TypeScript, no LLM, exhaustively unit-tested. Pipeline per quote line:

1. **Currency normalize** — everything to enquiry currency at a configured rate.
2. **Unit normalize** — m3 → MT via grade density (configurable per grade, default table provided;
   density assumptions are shown in the UI, never hidden).
3. **Resolve missing components** — look up the `FeeProfile` for (port, vendor, grade). If the vendor
   quoted a bare base price, the profile supplies barge/wharfage/delivery/tax as *estimates*, visibly
   flagged in a different colour. An estimated total is never presented as a firm one.
4. **Amortize lumpsums** — `lumpsum / stem_quantity` → per-MT equivalent.
5. **Apply percentages** — in a defined order (tax on subtotal, not on tax), configurable per port.
6. **Total** → `total_cost`, `effective_usd_per_mt`, plus a full component audit trail.
7. **Rank** — cheapest total first; ties broken by expiry (longer validity wins).

### Configurable fee taxonomy (defaults, all overridable)

Base product · barge/delivery fee · wharfage/quay dues · pumping/hose connection · overtime/after-hours ·
sampling & testing · agency fee · port dues share · VAT/excise/environmental levy · cancellation/no-show ·
demurrage exposure · financing (per payment-term days).

Every one carries `basis` (per-unit / lumpsum / %) and `is_estimate`. That's the whole configurability
story — you don't need Dan Bunkering's real spreadsheet to build it, and when you *do* get their formulas,
you encode them as a shipped `FeeProfile` seed rather than a code change.

---

## 5. Parsing

- **Strict schema, tool-use output.** The model fills a typed structure; it does not write prose.
- **Per-vendor-block parallelism.** A purchasing-centre email with five vendors becomes five parallel
  parse calls — total latency is the slowest one, not the sum.
- **Confidence is a first-class output.** Anything below threshold renders as an editable amber row that
  the trader confirms before it can be selected. The trader's correction is the safety net.
- **Learned aliases.** When a trader corrects a parse, store the mapping (`"BAF"` → bunker adjustment
  factor for vendor X). Over time the parser needs fewer corrections — and this is a genuinely compelling
  thing to show in a demo.

**Latency target: under 4 seconds from email arrival to a ranked row on screen.** Rows stream in
individually; the grid does not wait for all vendors.

---

## 6. Demo mechanics

A scripted scenario that runs on a timer — this is what you actually present:

1. **0:00** Client email lands: *"MV Nordic Star, Rotterdam, 15–17 Oct, 850 MT VLSFO + 120 MT MGO, agent Inchcape."*
   App parses it and shows a clean enquiry card. Trader clicks **Request prices**.
2. **0:20 – 1:30** Four vendor quotes arrive, deliberately in four different formats:
   - Vendor A: clean all-in, USD/MT
   - Vendor B: base price + seven line items, one of them a lumpsum barge fee
   - Vendor C: quoted in USD/m3, requiring density conversion
   - Vendor D: base only, "usual fees apply" → engine fills from FeeProfile, flagged amber as estimated

   Each row lands with a countdown ticking down from 10:00.
3. Grid ranks them. **The headline moment:** the vendor with the lowest *unit* price is not the cheapest
   total — the lumpsum barge fee sinks them on this stem size. Toggle a "rank by unit price" switch to
   show the mistake the current process makes.
4. Trader sets margin (client default pre-filled), sees sell price and total margin USD update live.
5. **Send** → composed client quote goes out on the original thread. Elapsed time on screen: **under 90
   seconds**, against the 10–20 minutes this takes today.

That last number is the whole pitch. Build a visible session timer into the demo UI.

---

## 7. Build phases

| Phase | Deliverable | Notes |
|---|---|---|
| **1** | Domain model + pricing engine + test suite | Pure logic, no UI. Correctness locked in first. |
| **2** | Comparison grid against fixture quotes | The screen that matters, on static data. |
| **3** | LLM parsing + confidence/correction UX | Real messy inputs → the grid. |
| **4** | Mock mailbox, SSE streaming, expiry countdowns | The app comes alive. |
| **5** | Margin controls + quote composer + send flow | Close the loop. |
| **6** | Demo scenario script, timer, polish | The presentation itself. |

Phases 1–2 are the risk. Once the engine is right and the grid reads well, the rest is assembly.

---

## 8. Assumptions I've made — flag any that are wrong

1. **Purchasing centre stays in the loop.** The app does not contact vendors directly; it consumes what
   the purchasing centre forwards. Changing this is a much larger political change than a technical one.
2. **One currency per enquiry**, with configured FX. Multi-currency hedging is out of scope.
3. **No credit/exposure checks.** Real production would need a counterparty credit gate before quoting —
   worth *mentioning* in the demo as a known next step, since their risk team will ask.
4. **Margin is trader-set with a client default.** No automated pricing optimization.
5. **Quotes are text.** PDF/image attachments are a phase-7 extension, not in the demo.
6. Nothing in the demo touches a live Dan Bunkering mailbox or any real client address.

## 9. Open questions for them (not blockers for the demo)

- Which ports and grades dominate their volume? Seeds a realistic `FeeProfile` set.
- Do they price off a platform index (Platts) or purely vendor-quoted absolutes?
- Is there an ERP of record for the confirmed stem, and does it have an API?
- How are their vendor quotes actually delivered today — email body, Excel attachment, or a portal?

---

## 10. Outlook integration

### The constraint that shapes the design

Microsoft documents change-notification latency for Outlook `message` as **average under 1 minute,
maximum 3 minutes**. Against a 10-minute quote validity, a webhook can consume 30% of the window before
the quote is visible. **Webhooks are a nudge, never the transport.**

The watcher is a **delta poll** — `GET /users/{mailbox}/mailFolders('inbox')/messages/delta` every
10–15 seconds, holding the delta token between calls so each request returns only what is new. Latency
becomes the poll interval, which we control. A webhook subscription can sit alongside it to trigger an
immediate poll, but nothing depends on it arriving.

Subscription lifetimes, for reference: Outlook `message` subscriptions max at 10,080 minutes (under 7
days); subscriptions carrying resource data max at 1,440 minutes (under 1 day). Both need renewal.

### Auth: delegated first, application later

| | Delegated (auth-code) | Application (client credentials) |
|---|---|---|
| Who signs in | Each trader, via Microsoft | Nobody — the app has its own identity |
| Consent | Often user-consentable for own mailbox | Admin consent required |
| Scoping | Naturally limited to that user | **App RBAC** binds it to named mailboxes |
| Send identity | The trader | The shared desk address |
| Good for | Pilot, per-trader desks, own-mailbox testing | The shared purchasing-centre mailbox |

Build **delegated first**. It runs on a personal or work mailbox with no admin involvement, and it is
the correct send model anyway — the client sees their trader, not a shared alias. Application
permissions come later for the purchasing-centre mailbox, scoped with **RBAC for Applications in
Exchange Online**. Note that App RBAC has replaced the older `New-ApplicationAccessPolicy` mechanism;
Application Access Policies are documented as legacy.

Do not propose IMAP. Basic auth is gone and it reads as a red flag in a security review.

### Sending

Reply with Graph `createReply` on the original message rather than composing fresh — it preserves
`conversationId` and the `In-Reply-To` / `References` headers, so the quote threads under the client's
enquiry instead of starting an orphan.

---

## 11. Hosted architecture

### One always-on process, not serverless

The 10–15 second delta poll is the product. It needs a process that stays alive, which rules out plain
serverless functions — Vercel cron granularity bottoms out at a minute and functions are short-lived.

Run the Next.js server and the poll loop in **one long-lived container**:

```
┌──────────────────────── one container ────────────────────────┐
│  Next.js (App Router)          poll loop (setInterval 12s)     │
│   · UI, API routes              · Graph delta per mailbox      │
│   · OAuth redirect              · dedupe on internetMessageId  │
│   · SSE to the browser          · enqueue parse jobs           │
└───────────────────────────────┬───────────────────────────────┘
                                │
                   Postgres: tokens (encrypted), delta cursors,
                   enquiries, quotes, components, audit trail
```

Host it on Railway / Fly / Render for the pilot. The same container image runs on **Azure Container
Apps**, which is where Dan Bunkering's IT will want it — same tenant as the mailbox, managed identity
available, no data leaving their cloud. Choosing a portable container now avoids re-platforming later.

### Parsing

`@anthropic-ai/sdk`, model `claude-opus-5`:

- **Structured outputs** (`output_config: {format: ...}`) so extraction is schema-validated rather than
  JSON-repaired.
- **`speed: "fast"`** — Opus 5 supports fast mode (research preview, up to 2.5x output tokens/sec).
  Directly relevant when a quote expires in ten minutes. Premium pricing, negligible at this volume.
- **`effort: "low"`** — extraction is not hard reasoning. Cuts latency and spend without changing model.
- **Prompt caching** on the stable prefix (instructions, fee taxonomy, vendor alias table); only the
  quote text varies, so it goes last.
- **One call per vendor block, in parallel.** Total latency is the slowest, not the sum.
- **Server-side refusal fallbacks** on by default.

Cost is not a reason to downgrade here. At roughly 500 input / 400 output tokens per quote, Opus 5 runs
about **1.3 cents per quote** — a few dollars a day at realistic desk volume. Latency and extraction
accuracy are what matter; both argue for the better model, not the cheaper one.

### Non-negotiables

- Refresh tokens and the Graph client secret live server-side, encrypted at rest. Never in the browser.
- **Audit trail is not optional.** Every quote sent, with the full cost breakdown it was computed from
  and the raw supplier text behind it. Compliance will ask, and it is much cheaper to write now.
- Dedupe on `internetMessageId` — a delta poll will hand you the same message twice.
