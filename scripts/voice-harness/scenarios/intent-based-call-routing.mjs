// Intent-based call routing: the harness is the caller, following DEMO-SCRIPT.md beats 2-6.
//
// Routes are generated from the shipped config/routes.json with the hours
// forced open or closed, so a run means the same thing at 3 a.m. as at noon.
// Targets stay the shipped fictional Teams queues: a real transfer can never
// ring a person, and every dispatch exercises the documented failure ladder.

/** Wide enough to say "no wait" over the phone; the demo widens it the same way. */
const TRANSFER_DELAY_MS = 12000;

const CLOSED = { timeZone: "America/Los_Angeles", days: [], open: "00:00", close: "00:00" };

function routesFixture(runtime, closed = []) {
  const routes = runtime.readTemplateJson("config/routes.json");
  for (const route of routes.routes) route.hours = closed.includes(route.id) ? CLOSED : { alwaysOpen: true };
  return routes;
}

/** The shipped directory plus the harness number as Dana Whitfield, so the greeting is personalised. */
function callersFixture(runtime) {
  const callers = runtime.readTemplateJson("config/callers.json");
  const dana = callers.callers.find((c) => c.displayName === "Dana Whitfield");
  callers.callers.unshift({ ...dana, phone: runtime.harnessNumber });
  return callers;
}

function prepare({ closed = [], transferDelayMs }) {
  return (runtime) => ({
    ROUTES_PATH: runtime.writeJson("routes.json", routesFixture(runtime, closed)),
    CALLERS_PATH: runtime.writeJson("callers.json", callersFixture(runtime)),
    // Pinned to the shipped policy so a developer's .env cannot change what passes.
    CONFIDENCE_THRESHOLD: "0.75",
    MAX_CLARIFICATIONS: "2",
    TRANSFER_DELAY_MS: String(transferDelayMs),
    LOCALE: "en-US",
  });
}

const probe = { idKey: "callId" };

/** Rings the template and waits for the AI disclosure in the greeting. */
async function answered(t) {
  await t.dial();
  await t.hear(/automated assistant/i, { timeoutMs: 25000 });
  await t.callId();
}

/** Says why they are calling and accepts the route the agent offers. */
async function routeTo(t, line, routeId, label) {
  await t.say(line);
  await t.waitForEvent("route_proposed", { detail: new RegExp(`^${routeId} @`), timeoutMs: 25000 });
  await t.hear(new RegExp(label, "i"), { timeoutMs: 15000, soft: true });
  await t.say("Yes please.");
  return t.waitForEvent("route_confirmed", { detail: new RegExp(`^${routeId} \\(confirmed\\)`), timeoutMs: 25000 });
}

export default [
  {
    id: "intent-based-call-routing",
    template: "intent-based-call-routing",
    title: "Intent-based call routing (all routes open)",
    direction: "inbound",
    order: 10,
    probe,
    prepare: prepare({ transferDelayMs: TRANSFER_DELAY_MS }),
    scenarios: [
      {
        name: "confident-billing",
        title: "Billing is proposed, confirmed and dispatched; with no Teams queue, the call falls back with an apology",
        timeoutMs: 180000,
        async run(t) {
          await answered(t);
          await t.waitForState("Dana Whitfield", { field: (s) => s?.caller?.name });
          t.expectHeard(/\bDana\b/i, { soft: true });
          await routeTo(t, "I was charged twice on my invoice.", "billing", "billing");
          await t.waitForState("transferring");
          await t.waitForEvent("transfer_started", { detail: "billing", timeoutMs: TRANSFER_DELAY_MS + 15000 });
          // The fictional queue cannot answer, so the documented ladder must run:
          // one retry, one diversion to Reception, then an honest apology.
          await t.waitForEvent("transfer_failed", { timeoutMs: 45000 });
          await t.waitForEvent("transfer_retry", { detail: "billing", timeoutMs: 45000 });
          await t.waitForEvent("transfer_diverted", { detail: "reception", timeoutMs: 45000 });
          await t.waitForState("fallback", { timeoutMs: 60000 });
          await t.hear(/can't connect|cannot connect|unable to connect|try (us )?again|call back/i, {
            timeoutMs: 25000,
            soft: true,
          });
          await t.waitForHangup({ timeoutMs: 30000, soft: true });
        },
      },
      {
        name: "unsure-clarifies",
        title: "An ambiguous reason gets a clarifying question, then clears the gate",
        async run(t) {
          await answered(t);
          await t.say("I was charged for a renewal I did not order.");
          // The model decides whether it is unsure; the policy decides what happens if it is.
          await t.waitForEvent("clarification", { detail: /^low_confidence/, timeoutMs: 25000, soft: true });
          await t.expectNoEvent("route_confirmed");
          await t.hear({ timeoutMs: 15000 });
          await t.say("The charge on my card is wrong.");
          await t.waitForEvent("route_proposed", { detail: /^billing @/, timeoutMs: 25000 });
          await t.expectNoEvent("route_confirmed");
        },
      },
      {
        name: "ask-for-person",
        title: "Asking for a person goes straight to Reception with no confirmation",
        async run(t) {
          await answered(t);
          await t.say("Can I just talk to a person?");
          await t.waitForEvent("human_requested", { timeoutMs: 25000 });
          await t.waitForEvent("route_confirmed", { detail: /^reception \(human_requested\)/ });
          await t.expectNoEvent("route_proposed", { soft: true });
          await t.waitForState("transferring");
          await t.hear(/connect|reception/i, { timeoutMs: 15000, soft: true });
        },
      },
      {
        name: "mind-change",
        title: "Changing your mind inside the transfer window cancels the transfer",
        async run(t) {
          await answered(t);
          await routeTo(t, "I was charged twice on my invoice.", "billing", "billing");
          const confirmedAt = Date.now();
          // Straight over "connecting you now", like a caller who remembers what they really called about.
          await t.say("No wait, sorry, the portal is down.", { waitQuietMs: 0 });
          await t.waitForEvent("route_changed", { detail: /^billing → support/, timeoutMs: TRANSFER_DELAY_MS });
          await t.waitForEvent("route_proposed", { detail: /^support @/, timeoutMs: 20000, soft: true });
          // Wait out the original window: the cancelled transfer must never fire.
          await t.pause(Math.max(0, confirmedAt + TRANSFER_DELAY_MS + 3000 - Date.now()));
          await t.expectNoEvent("transfer_started", { detail: "billing" });
        },
      },
      {
        name: "keypad-support",
        title: "Pressing 2 commits to Support without a spoken confirmation",
        async run(t) {
          await answered(t);
          await t.dtmf("2");
          await t.waitForEvent("dtmf", { detail: /^2 → support/ });
          await t.waitForEvent("route_confirmed", { detail: /^support \(dtmf\)/ });
          await t.waitForState("transferring");
        },
      },
      {
        name: "out-of-scope",
        title: "One unrelated question gets a polite deflection; a second goes to Reception",
        async run(t) {
          await answered(t);
          await t.say("What's the weather going to be like in Seattle tomorrow?");
          await t.waitForEvent("out_of_scope", { timeoutMs: 25000 });
          await t.hear(/right team|right place|can't answer|not able|only/i, { timeoutMs: 15000, soft: true });
          await t.expectNoEvent("route_confirmed");
          // maxDeflections is 1: the second unrelated question is a fallback, not another apology.
          await t.say("OK, then what time do your stores open on Saturday?");
          await t.waitForEvent("fallback", { detail: "repeated_out_of_scope", timeoutMs: 25000 });
          await t.waitForEvent("route_confirmed", { detail: /^reception \(fallback:repeated_out_of_scope\)/ });
        },
      },
    ],
  },
  {
    id: "intent-based-call-routing-after-hours",
    template: "intent-based-call-routing",
    title: "Intent-based call routing (Billing and Sales closed)",
    direction: "inbound",
    order: 11,
    probe,
    prepare: prepare({ closed: ["billing", "sales"], transferDelayMs: 3000 }),
    scenarios: [
      {
        name: "billing-closed-takes-message",
        title: "Billing after hours takes a message instead of transferring",
        timeoutMs: 180000,
        async run(t) {
          await answered(t);
          await routeTo(t, "I was charged twice on my invoice.", "billing", "billing");
          await t.waitForState("messaging");
          await t.hear(/message|closed/i, { timeoutMs: 20000, soft: true });
          await t.say("Please ask someone to call me back about the duplicate charge on my March invoice.");
          await t.converse({
            until: () => t.hasEvent("message_taken"),
            replies: [
              [/name/i, "It's Dana Whitfield."],
              [/number|reach you/i, "The number I'm calling from is fine."],
            ],
            fallback: "That's everything, thank you.",
            maxTurns: 4,
            timeoutMs: 90000,
          });
          await t.waitForEvent("message_taken");
          await t.waitForState("ended");
          await t.expectNoEvent("transfer_started");
          // The agent usually asks "anything else?"; a caller with nothing else should be let go.
          await t.hear({ timeoutMs: 10000 });
          await t.say("No, that's everything. Thanks, bye.");
          await t.waitForHangup({ timeoutMs: 30000, soft: true });
        },
      },
      {
        name: "sales-closed-diverts",
        title: "Sales after hours is diverted to Reception and says so",
        async run(t) {
          await answered(t);
          await routeTo(t, "I'd like a quote for fifty more licenses.", "sales", "sales");
          const snap = await t.waitForState("reception", { field: (s) => s?.destination?.routeId });
          t.check("the transfer is marked after hours", snap?.destination?.afterHours === true);
          await t.hear(/closed|reception/i, { timeoutMs: 15000, soft: true });
        },
      },
    ],
  },
];
