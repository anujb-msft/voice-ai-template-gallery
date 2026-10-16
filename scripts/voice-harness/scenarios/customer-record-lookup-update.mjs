// Customer record lookup & update: the harness is Alex Morgan, a Contoso sales
// rep, calling the CRM assistant hands-free from a registered mobile, following
// DEMO-SCRIPT.md beats 1-10 over a real phone call.
//
// Identity. A registered mobile has to pass a PIN (flow.mjs:96-101, SPEC.md:19).
// The suite writes its own reps.json: rep-alex's registeredMobile is the harness
// number and its pinHash is "sha256:" + sha256(PIN) for a PIN chosen here, computed
// exactly as providers/crm.mjs:58-60 does (the shipped hash is the test PIN 246810,
// test/flow.test.mjs:45, whose 0 would be a keypad transfer). A live caller has no
// way to enter it: keypad digits other than 0 and * are "unmapped_digit"
// (flow.mjs:296-300), the model has no PIN tool and is told never to ask for one
// (agent.mjs:1-17, :39), and submitPin is only reached from the presenter console's
// handler (offline.mjs:15). So scenarios type the PIN the way the console does,
// POST /api/simulate/:id/say on the live call's id (server.mjs:99-103); the hash is
// still checked. "pin-keypad" records that the phone path does not work.
//
// Each suite gets a fresh SQLite CRM seeded from the shipped crm-seed.json, and
// beforeEach resets it (POST /api/crm/reset, server.mjs:110) so scenarios stay
// independent. DEMO_NOW pins "today" to Wednesday 10 June 2026 (README.md:43) and TZ
// pins the weekday maths (flow.mjs parseRelativeDate), so "Friday" is 12 June.
//
// Server-owned wording is checked on the hub's agent transcripts: flow.#remember and
// #speak publish the exact line before the model voices it (flow.mjs:405-406); what
// the caller hears is the model's rendering, checked softly.
//
// Transfers: the Sales Operations queue is a placeholder (config/routing.json), so
// ACS refuses it. A transfer the model asks for is caught (voice-live.mjs #dispatchTool),
// but keypad 0 is not awaited (server.mjs:73-74) and flow.transfer has no catch
// (flow.mjs:336), so a refusal there is an unhandled rejection that can end the
// process: that beat runs in its own suite.

const PIN = "135724"; // no 0 (keypad transfer) and no * (repeat), so it could also be keyed
const WRONG_PIN = "975312";
const DEMO_NOW = "2026-06-10T12:00:00-07:00"; // the shipped default, pinned: a developer's .env cannot move "today"
const DICTATION =
  "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.";
const SEED_BRIEFING_RENEWAL = /enterprise renewal at about 250 thousand, in Negotiation, closing June 30/;

const digitsOf = (phone) => String(phone ?? "").replace(/\D/g, "");

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prepare({ registered = true } = {}) {
  return async (runtime) => {
    const shipped = (rel) => `${runtime.templateDir}/${rel}`;
    const doc = await runtime.readTemplateJson("config/reps.json");
    const harness = digitsOf(runtime.harnessNumber);
    const pinHash = `sha256:${await sha256Hex(PIN)}`;
    const reps = (doc.reps ?? [])
      .map((rep) => {
        if (registered && rep.id === "rep-alex") return { ...rep, registeredMobile: runtime.harnessNumber, pinHash };
        // Unregistered: nobody may own the harness number (crm.mjs:37 matches on normalised digits).
        if (digitsOf(rep.registeredMobile) === harness) return null;
        return rep;
      })
      .filter(Boolean);
    return {
      REPS_PATH: await runtime.writeJson("reps.json", { ...doc, reps }),
      CRM_ADAPTER: "sqlite",
      CRM_DB_PATH: `${runtime.dir}/crm.db`, // fresh per run; db.mjs reseeds an empty store from CRM_SEED_PATH
      CRM_SEED_PATH: shipped("config/crm-seed.json"),
      WRITABLE_FIELDS_PATH: shipped("config/writable-fields.json"),
      PICKLISTS_PATH: shipped("config/picklists.json"),
      BRIEFING_PATH: shipped("config/briefing.json"),
      ROUTING_PATH: shipped("config/routing.json"),
      DEMO_NOW,
      TZ: "America/Los_Angeles",
      LOCALE: "en-US",
      PIN_REQUIRED_FOR_PSTN: "true",
      TRANSCRIPT_RETENTION: "false",
      AFTER_CALL_MINUTES_BASELINE: "6",
      CALL_TIME_BUDGET_MS: "480000",
      WRAP_UP_MS: "420000",
    };
  };
}

const probe = { idKey: "callId" };

async function resetCrm(t) {
  const reset = await t.api.post("/api/crm/reset");
  t.check("the CRM was reset to the shipped seed", reset.ok, JSON.stringify(reset.body?.counts ?? reset.body));
}

const matches = (want, value) =>
  want == null || (want instanceof RegExp ? want.test(String(value ?? "")) : String(value ?? "") === String(want));

/** Polls this call's hub messages of one target (from index `after`) until one passes `test`, then records a check. */
async function onHub(t, target, label, test, { timeoutMs = 20000, soft = false, fatal, after = 0, show = (p) => JSON.stringify(p) } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const payloads = t.hubMessages(target).slice(after).map((m) => m.payload);
    const hit = payloads.find(test);
    if (hit || Date.now() >= until) {
      t.check(label, Boolean(hit), hit ? show(hit) : `${payloads.length} "${target}" message(s), none matched`, { soft, fatal });
      return hit ?? null;
    }
    await t.pause(400);
  }
}

/** An audit event read from the hub, which still shows it if the template process has died since. */
const hubEvent = (t, kind, { detail, ...opts } = {}) =>
  onHub(t, "event", `event "${kind}"${detail ? ` with ${detail}` : ""} (hub)`, (e) => e.kind === kind && matches(detail, e.detail), {
    show: (e) => e.detail,
    ...opts,
  });

const agentLines = (t) => t.hubMessages("transcript").filter((m) => m.payload.role === "agent").map((m) => m.payload.text ?? "");
const saidOnHub = (t, pattern) => agentLines(t).some((line) => pattern.test(line));

/** A line the server composed (published as an "agent" transcript; the hub also carries the model's own words). */
const serverSaid = (t, pattern, opts = {}) =>
  onHub(t, "transcript", `server line ${pattern}`, (p) => p.role === "agent" && pattern.test(p.text ?? ""), {
    show: (p) => p.text,
    ...opts,
  });

async function alive(t) {
  return (await t.probe.health()) !== null;
}

/** Lets the agent finish talking (e.g. a long read-back), so the next line is not a barge-in. */
async function letFinish(t, maxMs = 25000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) if (!(await t.hear({ timeoutMs: 1500, gapMs: 1500 }))) return;
}

const stats = async (t) => (await t.api.get("/api/stats")).body ?? {};
const counts = async (t) => (await t.api.get("/api/crm/accounts")).body?.counts ?? {};

/** Fabrikam's briefing phrase now, read through the console simulator as Alex (a separate, Teams-identified call). */
async function fabrikamBriefing(t) {
  const sim = await t.api.post("/api/simulate", { repId: "rep-alex" });
  const simId = sim.body?.callId;
  if (!simId) return null;
  const said = await t.api.post(`/api/simulate/${encodeURIComponent(simId)}/say`, { text: "Brief me on Fabrikam" });
  await t.api.post(`/api/simulate/${encodeURIComponent(simId)}/hangup`);
  return said.body?.snapshot?.briefing?.phrase ?? null;
}

/** Rings in, hears the PIN prompt, types the PIN for this call (see header) and checks the greeting. */
async function identify(t, { draft = false } = {}) {
  await t.dial();
  await t.hear(/pin|sales|contoso|automated|agent|assistant|operations/i, { timeoutMs: 25000 });
  const id = await t.callId();
  await serverSaid(t, /^Please enter your Contoso sales PIN\. Press 0 for sales operations\.$/);
  const typed = await t.api.post(`/api/simulate/${encodeURIComponent(id)}/say`, { text: PIN });
  const result = typed.body?.result;
  t.check(
    "the PIN verified Alex (typed for the live call through the console route)",
    typed.ok && result?.ok === true && result?.rep?.verifiedBy === "pstn-pin",
    JSON.stringify(result ?? typed.body),
  );
  await t.waitForState("listening", { timeoutMs: 10000 });
  const draftLine = draft ? " You have an unsaved update for Fabrikam\\. Say 'resume my draft' to pick it up\\." : "";
  await serverSaid(t, new RegExp(`^Hi Alex, I'm the Contoso sales assistant, an automated agent\\. Which account\\?${draftLine}$`));
  await t.hear(/alex|which account|automated|account/i, { timeoutMs: 20000, soft: true });
  return id;
}

/** Names Fabrikam and confirms "Fabrikam in Seattle?" (or lets a briefing run). */
async function openFabrikam(t, opener, { briefing = false } = {}) {
  let confirmed = false;
  await t.say(opener);
  await t.converse({
    until: async () => {
      const snap = await t.snapshot().catch(() => null);
      if (snap?.account?.id !== "acct-fabrikam") return false;
      if (await t.hasEvent("briefing", { detail: "Fabrikam" })) return true;
      return !briefing && confirmed;
    },
    replies: [
      [
        /seattle|fabrikam|is that|right|correct|confirm|\?/i,
        () => {
          confirmed = true;
          return briefing ? "Yes, Fabrikam in Seattle. Brief me." : "Yes, Fabrikam in Seattle.";
        },
      ],
    ],
    maxTurns: 6,
    timeoutMs: 75000,
  });
  await t.waitForEvent("find_account", { timeoutMs: 5000 });
  await t.waitForState("acct-fabrikam", { field: (s) => s?.account?.id, timeoutMs: 5000 });
}

function checkHandoff(t, handoff, callId, { fatal } = {}) {
  t.check(
    "the handoff targets Contoso Sales Operations",
    handoff?.routeId === "sales-operations" && handoff?.target === "Contoso Sales Operations",
    JSON.stringify(handoff),
    { fatal },
  );
  const topic = handoff?.callTopic ?? "";
  t.check("CallTopic is at most 48 characters and names the account", topic.length <= 48 && /^Sales rep – Fabrikam$/.test(topic), topic, { fatal });
  let context = null;
  try {
    context = JSON.parse(handoff?.callContext ?? "null");
  } catch {
    /* checked below */
  }
  t.check("CallContext names the rep and the account", context?.rep === "Alex Morgan" && context?.account === "Fabrikam", handoff?.callContext, { fatal });
  // SPEC.md:190-201 and DEMO-SCRIPT.md:25: no PIN or contact details travel with the call.
  const raw = String(handoff?.callContext ?? "");
  t.check("CallContext carries no PIN or contact details", !raw.includes(PIN) && !/2065550120|@fabrikam\.example/.test(raw), raw, { fatal });
  t.check("SessionId is the ACS call's id, not the template's", Boolean(handoff?.sessionId) && handoff.sessionId !== callId, handoff?.sessionId, {
    soft: true,
  });
}

const allDiffs = (proposal) => (proposal?.opportunityUpdates ?? []).flatMap((u) => u.diffs ?? []);

const template = "customer-record-lookup-update";

export default [
  {
    id: "customer-record-lookup-update",
    template,
    title: "Customer record lookup & update (registered rep, PIN typed via console)",
    direction: "inbound",
    order: 30,
    probe,
    prepare: prepare(),
    beforeEach: resetCrm,
    scenarios: [
      {
        name: "briefing-contact-gating",
        title: "Briefs Fabrikam from server data without contact details, gives Dana's number only when asked, * repeats, pause and continue (beats 1-3)",
        timeoutMs: 210000,
        async run(t) {
          await identify(t);
          await openFabrikam(t, "Brief me on Fabrikam.", { briefing: true });
          await t.waitForEvent("briefing", { detail: "Fabrikam", timeoutMs: 20000 });
          const snap = await t.snapshot();
          const phrase = snap?.briefing?.phrase ?? "";
          t.check("the server briefing opens with tier and ownership", /^Fabrikam, Strategic tier, your account\./.test(phrase), phrase);
          t.check("the briefing names the key contact without phone or email", /Dana Ruiz/.test(phrase) && !/\d{7}|@/.test(phrase), phrase);
          await t.replied(/strategic|renewal|negotiation|dana|250|task|deal/i, { timeoutMs: 30000, soft: true });
          await letFinish(t);
          // README.md:72: phone/email only when the rep asks for that detail.
          t.check("no contact number or email was spoken before the rep asked", !saidOnHub(t, /0120|206\D{0,3}555|dana\.ruiz@/i), null, { fatal: false });
          await t.expectNoEvent("tool", { detail: /^get_contact_info/, fatal: false });

          await t.say("What's Dana's number?");
          await t.waitForEvent("tool", { detail: /^get_contact_info/, timeoutMs: 25000, fatal: false });
          await serverSaid(t, /^Dana Ruiz's phone is \+12065550120\.$/, { timeoutMs: 5000, fatal: false });
          await t.hear(/0120|zero one two zero|one two zero|5550120|555/i, { timeoutMs: 25000, soft: true });
          await letFinish(t);

          // SPEC.md:54: * repeats the last server phrase (flow.mjs:294-298).
          const last = (await t.snapshot())?.lastPhrase ?? "";
          const before = agentLines(t).filter((line) => line === last).length;
          await t.dtmf("*");
          let repeated = false;
          for (let i = 0; i < 20 && !repeated; i++) {
            repeated = Boolean(last) && agentLines(t).filter((line) => line === last).length > before;
            if (!repeated) await t.pause(500);
          }
          t.check("keypad * re-spoke the last server phrase", repeated, last || "(no last phrase)", { fatal: false });
          await letFinish(t);

          await t.say("Pause.");
          const paused = await t.waitForState("paused", { timeoutMs: 15000, soft: true });
          if (paused?.state === "paused") {
            await letFinish(t, 6000);
            const spoke = await t.hear({ timeoutMs: 6000 });
            t.check("the agent stayed silent while paused", !spoke, spoke, { soft: true });
            await t.say("Continue.");
            // The state machine has PAUSED -> LISTENING on "continue" (flow.mjs:293), but agent.mjs has no continue tool.
            await t.waitForState("listening", { timeoutMs: 15000, fatal: false });
          }
          t.check("the call is still up", await alive(t));
        },
      },
      {
        name: "dictate-amend-commit-undo",
        title: "Dictation becomes a server read-back, a barge-in amendment drops the stage write, 'yes, save it' commits with audit rows, 'undo that' restores the seed (beats 4, 5, 7, 8)",
        timeoutMs: 240000,
        async run(t) {
          await identify(t);
          const seed = await counts(t);
          await openFabrikam(t, "Fabrikam, please.");
          await letFinish(t);

          const markPropose = await t.eventMark();
          await t.say(DICTATION);
          if (!(await t.waitForEvent("proposal", { since: markPropose, timeoutMs: 30000, soft: true }))) {
            await t.converse({
              until: () => t.hasEvent("proposal", { since: markPropose }),
              replies: [[/\?|update|log|dictat|go ahead|ready|what/i, DICTATION]],
              maxTurns: 3,
              timeoutMs: 60000,
            });
            await t.waitForEvent("proposal", { since: markPropose, timeoutMs: 10000 });
          }
          await serverSaid(t, /^Here's what I have: /);
          await t.expectNoEvent("commit");
          t.check("nothing is written before confirmation", Object.keys((await stats(t)).fieldsWrittenByEntity ?? {}).length === 0, JSON.stringify((await stats(t)).fieldsWrittenByEntity));
          const proposed = (await t.snapshot())?.proposal;
          const diffs = allDiffs(proposed);
          // The model passes its own rendering of the dictation, so field extraction is soft.
          t.check("the renewal moves to Closed Won", diffs.some((d) => d.field === "stage" && d.after === "Closed Won"), JSON.stringify(diffs), { soft: true });
          t.check("the amount becomes 240 thousand", diffs.some((d) => d.field === "amount" && Number(d.after) === 240000), JSON.stringify(diffs), { soft: true });
          t.check("a contract task is due Friday 12 June", proposed?.task?.dueDate === "2026-06-12", JSON.stringify(proposed?.task), { soft: true });

          await t.pause(1500);
          const markAmend = await t.eventMark();
          await t.interrupt("Actually, keep it in Negotiation.", { afterMs: 2000 });
          await t.converse({
            until: async () => (await t.hasEvent("proposal_amended", { since: markAmend })) || t.hasEvent("proposal", { since: markAmend }),
            replies: [[/\?|negotiation|stage|change|correct/i, "Keep the stage in Negotiation, please."]],
            maxTurns: 3,
            timeoutMs: 45000,
          });
          const amended = await t.hasEvent("proposal_amended", { since: markAmend });
          const current = (await t.snapshot())?.proposal;
          const stageDiff = allDiffs(current).find((d) => d.field === "stage");
          // DEMO-SCRIPT.md:20: the server rebuilds the proposal and removes the stage write (flow.mjs amendProposal).
          t.check("the amended proposal no longer moves the stage", Boolean(current) && !stageDiff, JSON.stringify(stageDiff ?? current?.readBack), amended ? { fatal: false } : { soft: true });
          if (amended) await serverSaid(t, /^Updated: /, { fatal: false });
          await letFinish(t);

          const markCommit = await t.eventMark();
          await t.say("Yes, save it.");
          let commit = await t.waitForEvent("commit", { since: markCommit, timeoutMs: 25000, soft: true });
          if (!commit) {
            await letFinish(t);
            await t.say("Yes, save it.");
            commit = await t.waitForEvent("commit", { since: markCommit, timeoutMs: 20000 });
          }
          await serverSaid(t, /^Saved\.$/);
          await t.hear(/saved|done|commit/i, { timeoutMs: 15000, soft: true });
          const written = (await stats(t)).fieldsWrittenByEntity ?? {};
          const committed = current ?? proposed;
          // db.mjs applyChangeSet: one audit row per opportunity diff, five per activity, three per task.
          const expected = { opportunity: allDiffs(committed).length, activity: committed?.activity ? 5 : 0, task: committed?.task ? 3 : 0 };
          t.check(
            "the commit wrote exactly the proposal's audit rows",
            Object.entries(expected).every(([entity, n]) => (written[entity] ?? 0) === n),
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(written)}`,
            { fatal: false },
          );
          const afterCommit = await counts(t);
          t.check(
            "the activity and task were created",
            afterCommit.activities === seed.activities + (committed?.activity ? 1 : 0) && afterCommit.tasks === seed.tasks + (committed?.task ? 1 : 0),
            JSON.stringify(afterCommit),
          );
          await letFinish(t);

          const markUndo = await t.eventMark();
          await t.say("Undo that.");
          await t.waitForEvent("undo", { detail: commit?.detail, since: markUndo, timeoutMs: 25000 });
          await serverSaid(t, /^Undone\.$/);
          const afterUndo = await counts(t);
          t.check("undo removed the created activity and task", afterUndo.activities === seed.activities && afterUndo.tasks === seed.tasks, JSON.stringify(afterUndo));
          const restored = await fabrikamBriefing(t);
          t.check("the renewal is back to Negotiation at 250 thousand, closing June 30", SEED_BRIEFING_RENEWAL.test(restored ?? ""), restored);
          await t.hear(/undone|undo|revert|back/i, { timeoutMs: 15000, soft: true });
        },
      },
      {
        name: "refused-discount",
        title: "A discount request is refused and left out by the server, with no write and no transfer (beat 6)",
        timeoutMs: 180000,
        async run(t) {
          await identify(t);
          const refusedBefore = (await stats(t)).refusedWritesByField?.["opportunity.discount"] ?? 0;
          await openFabrikam(t, "Fabrikam, please.");
          await letFinish(t);
          await t.say("Give them a 10 percent discount.");
          // The model may refuse on its own (agent.mjs:42) instead of asking the server.
          const refused = await t.waitForEvent("refused_write", { detail: "opportunity.discount", timeoutMs: 25000, soft: true });
          if (refused) {
            await serverSaid(t, /I can't change that by phone\. I've left it out\.$/);
            const proposal = (await t.snapshot())?.proposal;
            t.check("the proposal carries no opportunity change", (proposal?.opportunityUpdates ?? []).length === 0, JSON.stringify(proposal?.opportunityUpdates));
            const refusedAfter = (await stats(t)).refusedWritesByField?.["opportunity.discount"] ?? 0;
            t.check("/api/stats counts the refused write", refusedAfter > refusedBefore, `${refusedBefore} -> ${refusedAfter}`, { fatal: false });
          }
          await t.hear(/can't|cannot|left it out|not able|unable|discount/i, { timeoutMs: 25000, soft: true });
          await letFinish(t);
          await t.expectNoEvent("commit");
          // DEMO-SCRIPT.md:21: a refusal does not trigger a transfer.
          await t.expectNoEvent("transfer", { fatal: false });
          t.check("no opportunity field was written", !(await stats(t)).fieldsWrittenByEntity?.opportunity, JSON.stringify((await stats(t)).fieldsWrittenByEntity));
        },
      },
      {
        name: "draft-resume",
        title: "'Call me back later' saves the proposal as a draft; the next call offers it, 'resume my draft' re-reads it and 'yes, save it' commits it (beat 9)",
        timeoutMs: 330000,
        async run(t) {
          await identify(t);
          await openFabrikam(t, "Fabrikam, please.");
          await letFinish(t);
          const markPropose = await t.eventMark();
          await t.say("Log the Fabrikam meeting with Dana. Remind me to send the contract Friday.");
          await t.waitForEvent("proposal", { since: markPropose, timeoutMs: 30000 });
          await letFinish(t);
          await t.say("Call me back later.");
          await t.waitForEvent("draft_saved", { timeoutMs: 20000, soft: true });
          const firstId = t.id;
          await t.nextCall();
          // Hanging up with a pending proposal saves it too (flow.mjs endCall), so a draft must exist either way.
          let saved = false;
          for (let i = 0; i < 20 && !saved; i++) {
            saved = (await t.probe.events(firstId).catch(() => [])).some((e) => e.kind === "draft_saved");
            if (!saved) await t.pause(500);
          }
          t.check("the first call left a draft", saved, firstId);

          await identify(t, { draft: true });
          const markResume = await t.eventMark();
          await t.say("Resume my draft.");
          await t.waitForEvent("draft_resumed", { since: markResume, timeoutMs: 25000 });
          const readBack = await serverSaid(t, /^Here's what I have: /);
          // Expected to fail sometimes: propose_update parses the model's paraphrase of the dictation, and only a
          // literal "remind me to ..." becomes a task (flow.mjs:441), so "Reminder to send ..." loses it silently.
          t.check("the resumed read-back still carries the contract task", /task for you, send the contract, due June 12/.test(readBack?.text ?? ""), readBack?.text ?? "(no read-back)", { fatal: false });
          await t.hear(/contract|task|meeting|save/i, { timeoutMs: 30000, soft: true });
          await letFinish(t);
          const markCommit = await t.eventMark();
          await t.say("Yes, save it.");
          // Expected to fail today: the resumed proposal keeps the first call's callId (flow.mjs:282, db.mjs:214),
          // so #proposalFor throws "proposal belongs to another call" (flow.mjs:397).
          await t.waitForEvent("commit", { since: markCommit, timeoutMs: 25000, fatal: false });
          await letFinish(t, 10000);
          const secondId = t.id;
          await t.nextCall();
          // The same throw in endCall's saveDraft (flow.mjs:353) leaves the call un-ended after hangup.
          let ended = false;
          for (let i = 0; i < 30 && !ended; i++) {
            ended = (await t.probe.record(secondId).catch(() => null))?.state === "ended";
            if (!ended) await t.pause(500);
          }
          t.check("the resumed call is recorded as ended after hangup", ended, secondId, { fatal: false });
        },
      },
      {
        name: "ask-for-person",
        title: "'I need a person' starts a blind transfer to Sales Operations whose context carries no PIN or contact details (beat 10; the queue is fictional)",
        timeoutMs: 180000,
        async run(t) {
          const id = await identify(t);
          await openFabrikam(t, "Fabrikam, please.");
          await letFinish(t);
          await t.say("I need a person.");
          await t.waitForEvent("transfer", { timeoutMs: 25000 });
          const snap = await t.waitForState(/^transferr(ing|ed)$/, { timeoutMs: 10000 });
          checkHandoff(t, snap?.handoff, id);
          // No Teams tenant: ACS refuses the placeholder queue; the model-path rejection is caught by voice-live.mjs.
          await t.pause(8000);
          t.check("the template is still up after the transfer attempt", await alive(t));
          await t.hear({ timeoutMs: 8000 });
        },
      },
      {
        name: "scoped-account-two-failures",
        title: "Tailspin (another rep's account) is never found or described, and a second miss transfers for two failures",
        timeoutMs: 180000,
        async run(t) {
          await identify(t);
          await t.say("Tailspin Toys.");
          await t.waitForEvent("find_account", { timeoutMs: 25000, soft: true });
          await t.waitForEvent("find_account", { detail: "no_match", timeoutMs: 5000, fatal: false });
          await letFinish(t);
          const markRetry = await t.eventMark();
          await t.say("Tailspin, spelled T A I L S P I N.");
          const second = await t.waitForEvent("find_account", { detail: "no_match", since: markRetry, timeoutMs: 25000, soft: true });
          const snap = await t.snapshot();
          // db.mjs canSee: Tailspin belongs to Jordan's team only.
          t.check(
            "Tailspin was never offered",
            snap?.account?.id !== "acct-tailspin" && !(snap?.accountCandidates ?? []).some((c) => c.id === "acct-tailspin"),
            JSON.stringify({ account: snap?.account, candidates: snap?.accountCandidates }),
          );
          await t.expectNoEvent("briefing", { detail: "Tailspin Toys" });
          t.check("nothing about Tailspin's records was said", !saidOnHub(t, /chicago|lena|ortiz|crm migration/i), null);
          if (second) {
            const failures = (await t.events()).filter((e) => e.kind === "failure" && e.detail === "account_no_match");
            t.check("two account failures were recorded", failures.length >= 2, failures.length);
            await t.waitForEvent("transfer", { detail: "two_failures", timeoutMs: 10000 });
            await t.waitForState(/^transferr(ing|ed)$/, { timeoutMs: 10000 });
            await t.pause(6000);
            t.check("the template is still up after the transfer attempt", await alive(t));
          }
        },
      },
      {
        name: "pin-keypad",
        title: "Keying or saying the PIN on the phone verifies the rep (SPEC.md:19, :54) — expected to fail: no live code path reaches submitPin",
        timeoutMs: 120000,
        async run(t) {
          await t.dial();
          await t.hear(/pin|sales|contoso|automated|agent|assistant|operations/i, { timeoutMs: 25000 });
          await t.callId();
          await serverSaid(t, /^Please enter your Contoso sales PIN\./);
          await letFinish(t, 8000);
          await t.dtmf(PIN);
          await t.waitForState("listening", { timeoutMs: 12000, fatal: false });
          await t.say("My PIN is one three five seven two four.");
          await t.waitForState("listening", { timeoutMs: 15000, fatal: false });
          await t.expectNoEvent("find_account");
          t.check("the template is still up", await alive(t));
        },
      },
      {
        name: "wrong-pin-refused",
        title: "A wrong PIN is refused with the staff-only line and unlocks no CRM data",
        timeoutMs: 120000,
        async run(t) {
          await t.dial();
          await t.hear(/pin|sales|contoso|automated|agent|assistant|operations/i, { timeoutMs: 25000 });
          const id = await t.callId();
          await serverSaid(t, /^Please enter your Contoso sales PIN\./);
          await t.api.post(`/api/simulate/${encodeURIComponent(id)}/say`, { text: WRONG_PIN });
          await t.waitForEvent("pin_failed", { detail: "wrong_pin", timeoutMs: 10000 });
          await t.waitForState("refused", { timeoutMs: 10000 });
          await serverSaid(t, /^This line is for Contoso sales staff\.$/);
          await t.hear(/sales staff|staff|contoso/i, { timeoutMs: 20000, soft: true });
          await t.say("Brief me on Fabrikam.");
          await t.pause(8000);
          // flow.mjs requireIdentified throws before find_account/briefing record anything.
          await t.expectNoEvent("find_account");
          await t.expectNoEvent("briefing");
          t.check("no Fabrikam data was spoken", !saidOnHub(t, /strategic tier|enterprise renewal|dana ruiz|250 thousand/i), null);
          // SPEC.md:101-102 says the call ends; refuse() never hangs up (flow.mjs:125-130), only a model end_call would.
          await t.waitForHangup({ timeoutMs: 20000, fatal: false });
        },
      },
    ],
  },
  {
    id: "customer-record-lookup-update-unregistered",
    template,
    title: "Customer record lookup & update (caller is not a registered rep)",
    direction: "inbound",
    order: 31,
    probe,
    prepare: prepare({ registered: false }),
    beforeEach: resetCrm,
    scenarios: [
      {
        name: "unknown-caller-refused",
        title: "An unregistered number hears 'This line is for Contoso sales staff' and gets no CRM data",
        timeoutMs: 120000,
        async run(t) {
          await t.dial();
          await t.hear(/sales staff|staff|contoso|automated|agent|assistant/i, { timeoutMs: 25000 });
          await t.callId();
          await t.waitForState("refused", { timeoutMs: 10000 });
          await serverSaid(t, /^This line is for Contoso sales staff\.$/);
          await t.expectNoEvent("pin_failed");
          await t.say("Brief me on Fabrikam.");
          await t.pause(8000);
          await t.expectNoEvent("find_account");
          await t.expectNoEvent("briefing");
          t.check("no Fabrikam data was spoken", !saidOnHub(t, /strategic tier|enterprise renewal|dana ruiz|250 thousand/i), null);
          await t.waitForHangup({ timeoutMs: 20000, fatal: false });
        },
      },
    ],
  },
  {
    id: "customer-record-lookup-update-keypad-transfer",
    template,
    title: "Customer record lookup & update (keypad 0 transfer; own process, may crash it)",
    direction: "inbound",
    order: 32,
    probe,
    prepare: prepare(),
    beforeEach: resetCrm,
    scenarios: [
      {
        name: "keypad-zero-transfer",
        title: "Keypad 0 starts a transfer to Sales Operations with a clean handoff and the template survives ACS refusing the fictional queue",
        timeoutMs: 180000,
        async run(t) {
          const id = await identify(t);
          await openFabrikam(t, "Fabrikam, please.");
          await letFinish(t);
          await t.dtmf("0");
          // Read from the hub: an unhandled transfer rejection (server.mjs:73-74, flow.mjs:336) can kill the process.
          await hubEvent(t, "transfer", { detail: "dtmf_zero", timeoutMs: 15000 });
          const state = await onHub(t, "state", "state is transferring (hub)", (s) => /^transferr(ing|ed)$/.test(s.state ?? ""), {
            timeoutMs: 10000,
            show: (s) => s.state,
          });
          checkHandoff(t, state?.handoff, id);
          await t.pause(8000);
          t.check("the template is still up after the keypad transfer attempt", await alive(t), "an unhandled rejection ends the process", { fatal: false });
        },
      },
    ],
  },
];
