import assert from "node:assert/strict";
import { test } from "node:test";
import {
  crashSummary,
  dominantLocale,
  heardDigits,
  languageOf,
  listArg,
  nationalNumber,
  offLanguageUtterances,
  parseArgs,
  pickReply,
  redactDeep,
  redactPhones,
  speakDigits,
  templateReadiness,
  withTimeout,
} from "../src/util.mjs";

test("heardDigits reads a code however speech-to-text wrote it", () => {
  const cases = [
    ["four eight two nine one seven", "482917"],
    ["Your code is 4, 8, 2, 9, 1, 7. Please type it in.", "482917"],
    ["4 8 2 9 1 7", "482917"],
    ["48 29 17", "482917"],
    ["four, eight, 2 9 17", "482917"],
    ["I'll read you a six-digit code: 4. 8. 2. 9. 1. 7.", "482917"],
    ["double four, eight, two, nine, one", "448291"],
    ["triple seven one two three", "777123"],
    ["four oh two nine one seven", "402917"],
    ["Oh, sure. Here it is: 4 8 2 9 1 7", "482917"],
    ["482917. Again, that's 482917.", "482917"],
    ["4 8 2 9 1 7 4 8 2 9 1 7", "482917"],
  ];
  for (const [text, want] of cases) assert.equal(heardDigits(text), want, text);
});

test("heardDigits does not invent a code from other numbers", () => {
  assert.equal(heardDigits("the last four digits of your employee ID, 4217"), null);
  assert.equal(heardDigits("at least twelve characters with one number"), null);
  assert.equal(heardDigits("4 8 2"), null);
  assert.equal(heardDigits(""), null);
  assert.equal(heardDigits(undefined), null);
  assert.equal(heardDigits("four two one seven", 4), "4217");
});

test("speakDigits and nationalNumber", () => {
  assert.equal(speakDigits("+14255550123"), "one four two five five five five zero one two three");
  assert.equal(nationalNumber("+14255550123"), "4255550123");
  assert.equal(nationalNumber("+442079460123"), "442079460123");
  assert.equal(nationalNumber(undefined), "");
});

test("redactPhones keeps only the last four digits of phone numbers", () => {
  const out = redactPhones("call +14255550123, (425) 555-0199 or 425.555.0100; code 482917");
  assert.ok(!out.includes("4255550123"));
  assert.match(out, /•••-•••-0123/);
  assert.match(out, /•••-•••-0199/);
  assert.match(out, /•••-•••-0100/);
  assert.match(out, /code 482917/, "six-digit codes are not phone numbers");
  assert.equal(redactPhones("ACS id 4:+18665550142"), "ACS id 4:•••-•••-0142");
  assert.equal(redactPhones("14255550123"), "•••-•••-0123");
  assert.equal(redactPhones("code twice 482917482917"), "code twice 482917482917");
  assert.equal(redactPhones("at 1760000000000 ms"), "at 1760000000000 ms");
  assert.equal(redactPhones("E-104217, INC8728579"), "E-104217, INC8728579");
  assert.equal(redactPhones(undefined), "");
});

test("redactDeep redacts every string in nested data and leaves other values alone", () => {
  const out = redactDeep({ a: "+14255550123", b: [{ c: "425-555-0199" }], n: 42, ok: true, none: null });
  assert.deepEqual(out, { a: "•••-•••-0123", b: [{ c: "•••-•••-0199" }], n: 42, ok: true, none: null });
});

test("pickReply answers the first matching pattern, at most maxUses times per entry", () => {
  const name = [/name/i, "Dana"];
  const number = [/number/i, "This one", { maxUses: 1 }];
  const replies = [name, number];
  const used = new Map();
  assert.equal(pickReply(replies, "What's your name and number?", used), "Dana");
  assert.equal(pickReply(replies, "Your name again?", used), "Dana");
  assert.equal(pickReply(replies, "Your name, one more time?", used), null, "used up after two");
  assert.equal(pickReply(replies, "And your number?", used), "This one");
  assert.equal(pickReply(replies, "Your number again?", used), null);
  assert.equal(pickReply(replies, "Anything else?", new Map()), null);
});

test("parseArgs and listArg", () => {
  assert.deepEqual(parseArgs(["run", "--template", "x", "--attach", "--only=a,b"]), {
    _: ["run"],
    template: "x",
    attach: true,
    only: "a,b",
  });
  assert.equal(listArg(undefined), null);
  assert.equal(listArg(true), null);
  assert.deepEqual([...listArg("a, b,,c")], ["a", "b", "c"]);
});

test("templateReadiness understands each template's /health shape", () => {
  assert.deepEqual(templateReadiness(null), ["no /health response"]);
  assert.deepEqual(templateReadiness({ ok: true, callReady: true }), []);
  assert.deepEqual(templateReadiness({ ok: true }), []);
  assert.deepEqual(templateReadiness({ callReady: false, missingCallConfig: ["ACS_ENDPOINT", "DEMO_PHONE_NUMBER"] }), [
    "not ready for real calls (missing ACS_ENDPOINT, DEMO_PHONE_NUMBER)",
  ]);
  assert.deepEqual(templateReadiness({ mode: "simulation", missingConfig: ["ACS_ENDPOINT"] }), [
    "not ready for real calls (missing ACS_ENDPOINT)",
  ]);
  assert.deepEqual(templateReadiness({ telephony: { ready: false, missing: ["ACS_CALLER_ID"] } }), [
    "not ready for real calls (missing ACS_CALLER_ID)",
  ]);
  assert.deepEqual(templateReadiness({ acs: { ready: false } }), ["not ready for real calls"]);
});

test("withTimeout rejects with the given message when the promise is too slow", async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 1000), 1);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "too slow"), /too slow/);
});

test("languageOf ignores the region: en-US and en-GB are both English", () => {
  assert.equal(languageOf("en-US"), "en");
  assert.equal(languageOf("fr-CA"), "fr");
  assert.equal(languageOf("ES-us"), "es");
  assert.equal(languageOf(null), "");
});

test("dominantLocale picks the locale covering the most speech", () => {
  const phrase = (locale, durationMilliseconds, text = "words") => ({ locale, durationMilliseconds, text });
  assert.equal(dominantLocale([phrase("fr-CA", 2400), phrase("en-US", 900), phrase("fr-CA", 600)]), "fr-CA");
  assert.equal(dominantLocale([phrase("en-US", 900), phrase("es-ES", 2000), phrase("en-US", 1200)]), "en-US");
  assert.equal(dominantLocale([phrase("pt-BR", 500), phrase("es-ES", 500)]), "pt-BR", "ties go to the first heard");
  assert.equal(dominantLocale([phrase("de-DE", 9000, "  "), phrase("en-US", 100)]), "en-US", "empty phrases do not count");
  assert.equal(dominantLocale([{ locale: "it-IT", text: "ciao a tutti" }]), "it-IT", "phrases without durations still count");
  assert.equal(dominantLocale([{ text: "no locale" }]), null);
  assert.equal(dominantLocale(undefined), null);
});

test("offLanguageUtterances flags whole sentences in a language the scenario does not allow", () => {
  const said = [
    { locale: "en-US", text: "Could you confirm the last four digits of your employee ID?" },
    { locale: "en-GB", text: "Right, let us carry on then." },
    { locale: "fr-CA", text: "Bonjour Alex, c'est l'assistant informatique de Contoso." },
    { locale: "es-ES", text: "Sí." },
    { locale: null, text: "unidentified words in here" },
    { locale: "es-US", text: "Le llamo por su solicitud de servicio." },
  ];
  assert.deepEqual(
    offLanguageUtterances(said).map((u) => u.locale),
    ["fr-CA", "es-US"],
    "English in any accent is fine; one-word replies are too short to judge",
  );
  assert.deepEqual(offLanguageUtterances(said, ["en-US", "es-US"]).map((u) => u.locale), ["fr-CA"]);
  assert.deepEqual(offLanguageUtterances(said, ["en-US"], { minWords: 1 }).map((u) => u.locale), ["fr-CA", "es-ES", "es-US"]);
  assert.deepEqual(offLanguageUtterances(null), []);
});

test("crashSummary names the fatal error and the template line that threw it", () => {
  const code = "file:///home/dev/gallery/docs/templates/help-desk/code";
  const uncaught = [
    "2026-05-19T17:04:40.293Z [voice-live] tool propose_ticket {}",
    "2026-05-19T17:05:09.943Z [bridge] media socket closed for call 4fb1e84e",
    `${code}/src/voice/call-bridge.mjs:167`,
    "      flow.unregisterAgent(callId);",
    "           ^",
    "",
    "TypeError: flow.unregisterAgent is not a function",
    `    at WebSocket.<anonymous> (${code}/src/voice/call-bridge.mjs:167:12)`,
    "    at WebSocket.emit (node:events:526:24)",
    "",
    "Node.js v24.21.0",
  ].join("\n");
  assert.equal(crashSummary(uncaught), "TypeError: flow.unregisterAgent is not a function (src/voice/call-bridge.mjs:167)");

  const rejected = [
    "2026-05-19T17:06:00.000Z [acs] transfer failed: RestError: Invalid request",
    "RestError: Invalid request",
    `    at handleErrorResponse (${code}/node_modules/@azure/core-client/dist/esm/deserializationPolicy.js:239:19)`,
    `    at async CallConnection.transferCallToParticipant (${code}/node_modules/@azure/communication-call-automation/dist/esm/callConnection.js:230:22)`,
    `    at async FlowEngine.transfer (${code}/src/flow.mjs:131:5) {`,
    "  code: 'BadRequest',",
    "  statusCode: 400",
    "}",
  ].join("\r\n");
  assert.equal(crashSummary(rejected), "RestError: Invalid request (src/flow.mjs:131)", "skips frames inside node_modules");

  assert.equal(crashSummary("Error [ERR_SOCKET_CLOSED]: Socket is closed\n    at node:net:1:1"), "Error [ERR_SOCKET_CLOSED]: Socket is closed");
  assert.equal(
    crashSummary("2026-05-19T17:06:00.000Z [acs] transfer failed: Error: Invalid request\nIT/HR demo on http://127.0.0.1:8091"),
    null,
    "an error the template logged and survived is not what ended it",
  );
  assert.equal(crashSummary(""), null);
  assert.equal(crashSummary(undefined), null);
});
