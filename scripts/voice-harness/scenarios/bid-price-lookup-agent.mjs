// Bid price lookup: the harness is a grower calling the Contoso Grain Co-op bid line, following DEMO-SCRIPT.md
// (corn at Riverside, "and beans?", all locations, an advice question, * to repeat, a sell request, a feed
// outage, goodbye) and the SPEC.md freshness and after-hours rules.
//
// The server clock is DEMO_NOW and stays frozen for the whole run (server.mjs:31). Tuesday 2026-09-08 at
// 15:42Z is 10:42 in Chicago: the futures session is open, the shipped fixtures make Riverside corn a live
// $4.12, and the merchandisers are in (08:00-17:00 Chicago, Monday-Friday). At 23:30Z (18:30 in Chicago) the
// market is closed, so quotes are "as of the last close", and the merchandisers are out, so a transfer
// request closes the call instead. Price files point at the shipped fixtures.
//
// The merchandisers are placeholder Teams users, so an in-hours transfer can never reach a person. The flow
// starts the ACS transfer without awaiting or catching it (flow.mjs:131), so a rejected request ends the
// server process. Each in-hours transfer therefore runs on its own server (its own suite) and is checked
// from what the server published on the hub before the dispatch failed. The demo feed switches get their
// own suites too: make-stale cannot be undone.

const MARKET_OPEN = "2026-09-08T15:42:00Z";
const AFTER_HOURS = "2026-09-08T23:30:00Z";

function prepare(demoNow) {
  return (runtime) => ({
    // Pinned so a developer's environment cannot change the prices, freshness or hours under test.
    LOCATIONS_PATH: `${runtime.templateDir}/config/locations.json`,
    BIDS_PATH: `${runtime.templateDir}/config/bids.json`,
    FUTURES_PATH: `${runtime.templateDir}/config/futures.json`,
    MARKET_PATH: `${runtime.templateDir}/config/market.json`,
    PRICE_FEED: "fixture",
    FUTURES_STALE_MINUTES: "20",
    FUTURES_HARD_LIMIT_MINUTES: "240",
    CALL_TIME_BUDGET_MS: "180000",
    MINUTES_PER_AUTOMATED_CALL: "3",
    DEMO_NOW: demoNow,
    PERSIST_TRANSCRIPTS: "false",
    LOCALE: "en-US",
    TEAMS_CLOUD: "public",
  });
}

const probe = { idKey: "callId" };

const OPENING = /automated assistant|grain|bid line|commodity/i;
const GOODBYE = "Thanks for calling Contoso Grain Co-op. Goodbye.";
const CALL_BACK = /Please call back during those hours\. Goodbye\.$/;
/** Any money amount, for moments when no price may be spoken. */
const PRICE = /\$\s?\d|\b\d+\.\d{2}\b|\bdollars?\b/i;
/** Selling advice or a market prediction, which the agent must never give. */
const ADVICE =
  /\byou should (sell|hold|wait|store)\b|\bi('d| would) (sell|hold|wait)\b|\b(prices?|corn|the market) (will|is going to|should) (rise|fall|go up|go down|drop|climb|improve)\b|\bgood time to sell\b/i;

/** The server's quote event detail, JSON {commodity, locationId, freshness} (db.mjs:30). */
function quoteDetail(commodity, locationId = null, freshness = null) {
  const field = (k, v) => (v ? `(?=.*"${k}":"${v}")` : "");
  return new RegExp(`^${field("commodity", commodity)}${field("locationId", locationId)}${field("freshness", freshness)}`);
}

/** Rings the bid line and waits for the greeting with its AI disclosure. */
async function answered(t) {
  await t.dial();
  const heard = await t.hear(OPENING, { timeoutMs: 30000 });
  await t.callId();
  return heard;
}

/** Everything the agent has been heard saying on this scenario's calls. */
function heardSoFar(t) {
  return t.legs.map((l) => l.transcript()).join(" \n");
}

/** Soft check that the agent said `pattern` since `mark` (a heardSoFar length), listening on if not heard yet. */
async function heardSince(t, mark, pattern, { timeoutMs = 20000 } = {}) {
  if (pattern.test(heardSoFar(t).slice(mark))) {
    t.check(`agent said ${pattern}`, true, null, { soft: true });
    return;
  }
  if (!t.leg || t.leg.ended) {
    t.check(`agent said ${pattern}`, false, "the call had ended", { soft: true });
    return;
  }
  await t.hear(pattern, { timeoutMs, soft: true });
}

/** Waits for a hub message of one kind ("event", "state", "transcript") that satisfies `pred`. */
async function waitForHub(t, label, target, pred, { timeoutMs = 20000, soft = false, fatal } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = t.hubMessages(target).find((m) => {
      try {
        return pred(m.payload);
      } catch {
        return false;
      }
    });
    if (hit) {
      t.check(label, true);
      return hit.payload;
    }
    if (Date.now() >= until) break;
    await t.pause(500);
  }
  t.check(label, false, `${t.hubMessages(target).length} "${target}" hub message(s)`, { soft, fatal });
  return null;
}

/** How many times the server has given the agent exactly this line (hub "transcript" messages). */
function agentLines(t, text) {
  return t.hubMessages("transcript").filter((m) => m.payload?.role === "agent" && m.payload?.text === text).length;
}

async function getJson(t, path) {
  try {
    const r = await t.api.get(path);
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

async function serverAlive(t) {
  return Boolean(await getJson(t, "/health"));
}

/** Quote events recorded on this call for one commodity, parsed. */
async function quotesFor(t, commodity) {
  const events = await t.events().catch(() => []);
  return events
    .filter((e) => e.kind === "quote" && quoteDetail(commodity).test(e.detail))
    .map((e) => {
      try {
        return JSON.parse(e.detail);
      } catch {
        return {};
      }
    });
}

/** Asks for one quote and waits until the server has recorded it and the agent has read it out. */
async function askQuote(t, line, commodity, locationId, freshness, { fatal } = {}) {
  const mark = await t.eventMark();
  await t.say(line);
  const hit = await t.waitForEvent("quote", { detail: quoteDetail(commodity, locationId, freshness), since: mark, timeoutMs: 25000, fatal });
  await t.hear(/anything else|\?/i, { timeoutMs: 20000, soft: true });
  return hit;
}

/** The caller says goodbye; the agent should close with the scripted line and hang up, else the caller does. */
async function goodbye(t) {
  if (t.leg && !t.leg.ended) {
    const mark = heardSoFar(t).length;
    await t.say("That's all I needed. Thanks, goodbye.");
    const closed = await t.waitForState("ended", { timeoutMs: 20000, soft: true });
    if (closed?.state === "ended") {
      await waitForHub(t, "the closing line is the scripted goodbye", "transcript", (p) => p.role === "agent" && p.text === GOODBYE, {
        timeoutMs: 3000,
        soft: true,
      });
      await heardSince(t, mark, /goodbye|thanks for calling/i, { timeoutMs: 8000 });
      // end_call schedules the hang-up four seconds later (call-bridge.mjs:42).
      await t.waitForHangup({ timeoutMs: 10000, soft: true });
    }
  }
  if (t.leg && !t.leg.ended) await t.hangup();
  await t.waitForState("ended", { timeoutMs: 15000 });
}

const marketOpenScenarios = [
  {
    name: "corn-then-beans-same-location",
    title: "Corn at Riverside gets the live $4.12 bid with the disclaimer up front, and \"and beans?\" quotes soybeans at the same location",
    timeoutMs: 150000,
    async run(t) {
      const greeting = await answered(t);
      t.check("the greeting gives the bid disclaimer", /subject to change|confirm with the merchandiser/i.test(greeting), greeting, { soft: true });
      await askQuote(t, "What's corn at Riverside?", "corn", "riverside", "live");
      const snap = await t.snapshot().catch(() => null);
      const phrase = snap?.lastPhrase ?? "";
      t.check("the Riverside corn cash bid is $4.12", snap?.lastQuote?.cashBid === 4.12, String(snap?.lastQuote?.cashBid));
      t.check(
        "the server phrase is a live quote, not a close or delayed one",
        phrase.startsWith("Corn at Riverside") && phrase.includes("$4.12") && !/may be delayed|last close/.test(phrase),
        phrase,
      );
      t.check("the agent read the $4.12 bid", /4[.\s,]*12|four (dollars? )?(and )?twelve/i.test(heardSoFar(t)), null, { soft: true });
      // No location this time: the server reuses the caller's last location (pricing.mjs quote lastLocationId).
      await askQuote(t, "And beans?", "soybeans", "riverside", null, { fatal: false });
      const beans = await t.snapshot().catch(() => null);
      t.check("the follow-up quote is soybeans at Riverside", beans?.lastQuote?.commodity === "soybeans" && beans?.lastLocationId === "riverside", `${beans?.lastQuote?.commodity} at ${beans?.lastLocationId}`, {
        fatal: false,
      });
      await goodbye(t);
    },
  },
  {
    name: "all-locations-for-corn",
    title: "Asking for corn at all locations reads the server's list of up to five location bids",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      const mark = await t.eventMark();
      await t.say("Can you give me corn at all your locations?");
      await t.waitForEvent("tool", { detail: "list_bids", since: mark, timeoutMs: 25000, soft: true });
      // list_bids records one quote per location it reads (flow.mjs:102); the shipped sheet has five corn locations.
      const until = Date.now() + 25000;
      let quotes = await quotesFor(t, "corn");
      while (new Set(quotes.map((q) => q.locationId)).size < 5 && Date.now() < until) {
        await t.pause(1000);
        quotes = await quotesFor(t, "corn");
      }
      const places = [...new Set(quotes.map((q) => q.locationId))];
      t.check("corn was quoted at five locations", places.length === 5, places.join(", "), { fatal: false });
      t.check("every quote is live", quotes.length > 0 && quotes.every((q) => q.freshness === "live"), quotes.map((q) => q.freshness).join(", "), { fatal: false });
      await t.hear(/prairie|lake mills|fairview|riverbend/i, { timeoutMs: 30000, soft: true });
      await goodbye(t);
    },
  },
  {
    name: "keypad-star-repeats-last-quote",
    title: "Pressing * makes the server repeat its last bid phrase verbatim, and asking to repeat does the same",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      await askQuote(t, "What's wheat at Riverside?", "wheat", "riverside", null);
      const phrase = (await t.snapshot().catch(() => null))?.lastPhrase ?? null;
      t.check("the server holds a last phrase to repeat", Boolean(phrase), phrase);
      const beforeStar = agentLines(t, phrase);
      const starMark = await t.eventMark();
      await t.dtmf("*");
      await t.pause(6000);
      // server.mjs:84 maps only the tones zero-nine, so ACS's "asterisk" reaches flow.dtmf as an unmapped digit.
      // A repeat_last tool call means the model repeated it, not the keypad mapping.
      const byModel = await t.hasEvent("tool", { detail: "repeat_last", since: starMark });
      const starRepeats = agentLines(t, phrase) - beforeStar;
      t.check("* makes the server repeat the last phrase", starRepeats > 0 && !byModel, `${starRepeats} repeat(s)${byModel ? " via repeat_last" : ""}`, {
        fatal: false,
      });
      const askMark = await t.eventMark();
      const beforeAsk = agentLines(t, phrase);
      await t.say("Sorry, could you repeat that?");
      await t.waitForEvent("tool", { detail: "repeat_last", since: askMark, timeoutMs: 20000, soft: true });
      t.check("asking to repeat replays the same server phrase", agentLines(t, phrase) > beforeAsk, null, { soft: true });
      await t.hear(/wheat/i, { timeoutMs: 20000, soft: true });
      await goodbye(t);
    },
  },
  {
    // Last in its suite: a transfer here would be in hours, and a failed dispatch ends the server.
    name: "advice-refusal",
    title: "Asked whether to sell, the agent refuses to advise or predict, points to the merchandiser, and starts no transfer",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      await askQuote(t, "What's corn at Fairview?", "corn", "fairview", "live", { fatal: false });
      const mark = heardSoFar(t).length;
      await t.say("Prices look low to me. Do you think I should sell now, or wait for the market to go up?");
      await heardSince(t, mark, /can.?t advise|cannot advise|not able to advise|merchandiser can talk/i, { timeoutMs: 20000 });
      const reply = heardSoFar(t).slice(mark);
      t.check("no selling advice or market prediction was given", !ADVICE.test(reply), reply.match(ADVICE)?.[0], { soft: true });
      // The prompt lets the agent offer a transfer after refusing, but not start one the caller did not ask for.
      t.check("no transfer was started", !(await t.hasEvent("transfer_started")), null, { soft: true });
      await goodbye(t);
    },
  },
];

/** Waits for the after-hours close: merchandiser hours and a call-back line instead of a transfer (flow.mjs:121-125). */
async function expectAfterHoursClose(t, outcome) {
  await t.waitForState(outcome, { field: "outcome", timeoutMs: 15000 });
  await t.waitForState("ended", { timeoutMs: 3000 });
  await waitForHub(t, "the agent was given the merchandiser hours and a call-back line", "transcript", (p) => p.role === "agent" && CALL_BACK.test(p.text), {
    timeoutMs: 3000,
  });
  await t.expectNoEvent("transfer_started");
}

const afterHoursScenarios = [
  {
    name: "close-price-then-keypad-zero",
    title: "After the market closes the bid is quoted as of the last close; pressing 0 outside merchandiser hours gives the hours and closes without a transfer",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      await askQuote(t, "What's corn at Riverside?", "corn", "riverside", "close");
      const snap = await t.snapshot().catch(() => null);
      t.check("the phrase is the last close", (snap?.lastPhrase ?? "").startsWith("As of the last close, corn at Riverside"), snap?.lastPhrase);
      t.check("the agent said it was the last close", /last close|closing|was \$?\d/i.test(heardSoFar(t)), null, { soft: true });
      const mark = heardSoFar(t).length;
      await t.dtmf("0");
      await expectAfterHoursClose(t, "closed_after_hours:dtmf_0");
      await heardSince(t, mark, /call back|business hours|monday|goodbye/i, { timeoutMs: 15000 });
      // Nothing hangs up after the after-hours close unless the model calls end_call.
      await t.waitForHangup({ timeoutMs: 8000, soft: true });
      if (t.leg && !t.leg.ended) await t.hangup();
    },
  },
  {
    name: "sell-request-after-hours",
    title: "A request to sell outside merchandiser hours gets the hours and a call-back line instead of a transfer",
    timeoutMs: 120000,
    async run(t) {
      await answered(t);
      const mark = heardSoFar(t).length;
      await t.say("I want to sell five thousand bushels of corn at Riverside.");
      // Choosing to transfer is the model's job (the prompt says to, for selling); the after-hours close is the server's.
      await t.converse({
        until: async (_heard, tt) => Boolean(tt.leg?.ended) || (await tt.hasEvent("tool", { detail: /^transfer_to_merchandiser/ })),
        replies: [
          [/connect|transfer|merchandiser/i, "Yes, please connect me with the merchandiser."],
          [/location|which/i, "Riverside."],
        ],
        maxTurns: 3,
        timeoutMs: 45000,
      });
      await expectAfterHoursClose(t, /^closed_after_hours:/);
      await heardSince(t, mark, /call back|business hours|monday|goodbye/i, { timeoutMs: 15000 });
      if (t.leg && !t.leg.ended) await t.hangup();
    },
  },
  {
    name: "silent-caller-reprompted",
    title: "A caller who goes quiet after a quote is reprompted by the server's no-input policy",
    timeoutMs: 120000,
    async run(t) {
      await answered(t);
      await askQuote(t, "What's corn at Lake Mills?", "corn", null, null, { fatal: false });
      await t.pause(25000);
      // flow.mjs:161 noInput() reprompts, then ends the call, but only /api/simulate/:id/silence calls it;
      // the live bridge has no silence timer.
      await t.waitForEvent("no_input", { timeoutMs: 5000, fatal: false });
      await waitForHub(t, "the server reprompted the caller", "transcript", (p) => p.role === "agent" && /didn't catch that/.test(p.text), {
        timeoutMs: 1000,
        soft: true,
      });
      if (t.leg && !t.leg.ended) await t.hangup();
      await t.waitForState("caller_hung_up", { field: "outcome", timeoutMs: 15000 });
    },
  },
  {
    name: "call-budget-expires",
    title: "When the 3-minute call budget runs out the server logs budget_expired and closes the call",
    skip: "cannot elapse live: DEMO_NOW freezes the server clock (server.mjs:31), so flow.mjs #budgetExpired never trips",
    async run() {},
  },
  {
    // Last in its suite: it switches the shared price feed off (and back on in finally).
    name: "feed-outage-after-hours",
    title: "With the price feed down no price is read: the outage is logged and, outside merchandiser hours, the caller gets the hours instead of a transfer",
    timeoutMs: 120000,
    async run(t) {
      const down = await t.api.post("/api/demo/feed-down", { down: true });
      t.check("the demo feed switch is accepted", down.ok, String(down.status));
      t.check("the server reports the feed down", down.body?.health?.ok === false, JSON.stringify(down.body?.health ?? null), { soft: true });
      try {
        await answered(t);
        const mark = heardSoFar(t).length;
        await t.say("What's soybeans at Lake Mills?");
        await t.waitForEvent("feed_outage", { timeoutMs: 25000 });
        await expectAfterHoursClose(t, "closed_after_hours:feed_outage");
        await t.expectNoEvent("quote");
        await heardSince(t, mark, /unavailable|call back|merchandiser|goodbye/i, { timeoutMs: 15000 });
        const heard = heardSoFar(t).slice(mark);
        t.check("no price was spoken during the outage", !PRICE.test(heard), heard.match(PRICE)?.[0], { soft: true });
        if (t.leg && !t.leg.ended) await t.hangup();
      } finally {
        await t.api.post("/api/demo/feed-down", { down: false }).catch(() => null);
      }
    },
  },
];

/**
 * In merchandiser hours a transfer is started for real: the state moves to transferring, the transfer is
 * audited with its reason, and the agent gets the location's connecting line. Read from the hub, which the
 * probe has already captured, so a server that dies on the failed dispatch still shows what it decided.
 */
async function expectTransferStarted(t, locationName, reason) {
  const started = await waitForHub(t, "a transfer to the merchandiser was started", "event", (p) => p.kind === "transfer_started", { timeoutMs: 25000 });
  if (reason instanceof RegExp) t.check(`the transfer reason matches ${reason}`, reason.test(started?.detail ?? ""), started?.detail, { soft: true });
  else t.check(`the transfer reason is ${reason}`, started?.detail === reason, started?.detail);
  await waitForHub(t, "the call is transferring", "event", (p) => p.kind === "state" && /→\s*transferring/.test(p.detail), { timeoutMs: 3000 });
  await waitForHub(
    t,
    `the agent was given the ${locationName} connecting line`,
    "transcript",
    (p) => p.role === "agent" && p.text === `Connecting you with the ${locationName} merchandiser now`,
    { timeoutMs: 3000 },
  );
  return started;
}

/** The placeholder merchandiser cannot take the call; the failed dispatch must not take the server down. */
async function expectServerSurvives(t) {
  await t.pause(5000);
  const alive = await serverAlive(t);
  t.check("the server survives the failed transfer dispatch", alive, null, { fatal: false });
  if (alive) {
    // dispatchTransfer audits transfer_succeeded as soon as ACS accepts the request; CallTransferFailed is not handled.
    t.check("no success is audited for the placeholder merchandiser", !(await t.hasEvent("transfer_succeeded")), null, { soft: true });
  }
  if (t.leg && !t.leg.ended) await t.hangup();
}

const suite = (id, title, order, demoNow, scenarios) => ({
  id,
  template: "bid-price-lookup-agent",
  title,
  direction: "inbound",
  order,
  probe,
  prepare: prepare(demoNow),
  scenarios,
});

export default [
  suite("bid-price-lookup-agent", "Bid price lookup (market open)", 40, MARKET_OPEN, marketOpenScenarios),
  suite("bid-price-lookup-agent-after-hours", "Bid price lookup (after the close)", 41, AFTER_HOURS, afterHoursScenarios),
  suite("bid-price-lookup-agent-stale-futures", "Bid price lookup (futures an hour stale)", 42, MARKET_OPEN, [
    {
      name: "stale-futures-caveat",
      title: "With futures more than 20 minutes old the bid is still quoted, flagged as possibly delayed",
      timeoutMs: 120000,
      async run(t) {
        // make-stale cannot be undone, which is why this scenario has a server to itself.
        const stale = await t.api.post("/api/demo/make-stale", { minutes: 60 });
        t.check("the demo stale switch is accepted", stale.ok, String(stale.status));
        t.check("the server reports futures over 20 minutes old", Number(stale.body?.health?.futuresAgeMinutes) > 20, String(stale.body?.health?.futuresAgeMinutes), {
          soft: true,
        });
        await answered(t);
        const mark = heardSoFar(t).length;
        await askQuote(t, "What's corn at Riverside?", "corn", "riverside", "delayed");
        const snap = await t.snapshot().catch(() => null);
        t.check("the phrase carries the delay caveat", /These prices may be delayed\. Anything else\?$/.test(snap?.lastPhrase ?? ""), snap?.lastPhrase);
        await heardSince(t, mark, /delayed/i, { timeoutMs: 15000 });
        await goodbye(t);
      },
    },
  ]),
  // One in-hours transfer per server: the unawaited dispatch (flow.mjs:131) can end the process.
  suite("bid-price-lookup-agent-sell", "Bid price lookup (sell request in merchandiser hours)", 43, MARKET_OPEN, [
    {
      name: "sell-request-transfers",
      title: "In merchandiser hours a sell request starts a blind transfer to the location's merchandiser with the last quote as context",
      timeoutMs: 120000,
      async run(t) {
        await answered(t);
        await askQuote(t, "What's corn at Riverside?", "corn", "riverside", "live", { fatal: false });
        await t.say("Okay. I want to sell ten thousand bushels.");
        await t.converse({
          until: (_heard, tt) => Boolean(tt.leg?.ended) || tt.hubMessages("event").some((m) => m.payload?.kind === "transfer_started"),
          replies: [
            [/connect|transfer|merchandiser/i, "Yes, please connect me with the merchandiser."],
            [/location|which/i, "Riverside."],
          ],
          maxTurns: 3,
          timeoutMs: 40000,
        });
        // The reason string is the model's tool argument; the documented one is a sell request.
        await expectTransferStarted(t, "Riverside", /sell/i);
        const snap = await t.snapshot().catch(() => null);
        if (snap) {
          // handoffContext (flow.mjs:196-206): CallTopic "Sell <commodity> – <location>", CallContext opens with the last quote.
          const handoff = snap.handoff ?? {};
          t.check("the handoff topic names the sale and location", String(handoff.callTopic).startsWith("Sell corn") && String(handoff.callTopic).endsWith("Riverside"), handoff.callTopic, {
            fatal: false,
          });
          t.check("the handoff carries the last quote", String(handoff.callContext).startsWith("Last quote: Corn at Riverside"), null, { fatal: false });
          t.check("the handoff targets the Riverside merchandiser", handoff.locationId === "riverside", handoff.locationId, { fatal: false });
        } else {
          t.check("the handoff was readable before the server stopped", false, "no snapshot", { soft: true });
        }
        await expectServerSurvives(t);
      },
    },
  ]),
  suite("bid-price-lookup-agent-feed-down", "Bid price lookup (feed down in merchandiser hours)", 44, MARKET_OPEN, [
    {
      name: "feed-down-transfers-in-hours",
      title: "With the price feed down in merchandiser hours no price is read and the call is transferred to the location's merchandiser",
      timeoutMs: 120000,
      async run(t) {
        const down = await t.api.post("/api/demo/feed-down", { down: true });
        t.check("the demo feed switch is accepted", down.ok, String(down.status));
        try {
          await answered(t);
          const mark = heardSoFar(t).length;
          await t.say("What's corn at Prairie Center?");
          await waitForHub(t, "the feed outage is logged", "event", (p) => p.kind === "feed_outage", { timeoutMs: 25000 });
          await expectTransferStarted(t, "Prairie Center", "feed_outage");
          await heardSince(t, mark, /unavailable|connect|merchandiser/i, { timeoutMs: 15000 });
          const heard = heardSoFar(t).slice(mark);
          t.check("no price was spoken during the outage", !PRICE.test(heard), heard.match(PRICE)?.[0], { soft: true });
          await expectServerSurvives(t);
        } finally {
          await t.api.post("/api/demo/feed-down", { down: false }).catch(() => null);
        }
      },
    },
  ]),
];
