import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEPHONY_MODES,
  callerArguments,
  normalizeTelephonyMode,
  telephonyMissing,
} from "../src/telephony.mjs";

test("direct ACS mode uses only the ACS caller number", () => {
  assert.deepEqual(
    callerArguments({
      mode: TELEPHONY_MODES.ACS_DIRECT,
      callerId: "+14255550100",
      teamsResourceAccountId: "ignored",
    }),
    {
      invite: { sourceCallIdNumber: { phoneNumber: "+14255550100" } },
      options: {},
    },
  );
});

test("Teams Phone mode uses only the resource account object ID", () => {
  assert.deepEqual(
    callerArguments({
      mode: TELEPHONY_MODES.TEAMS_PHONE,
      callerId: "+14255550100",
      teamsResourceAccountId: "11111111-2222-3333-4444-555555555555",
    }),
    {
      invite: {},
      options: {
        teamsAppSource: {
          teamsAppId: "11111111-2222-3333-4444-555555555555",
        },
      },
    },
  );
});

test("each mode reports only its own missing caller identity", () => {
  assert.deepEqual(
    telephonyMissing({
      mode: TELEPHONY_MODES.ACS_DIRECT,
      callerId: "",
      teamsResourceAccountId: "resource-account",
    }),
    ["ACS_CALLER_ID"],
  );
  assert.deepEqual(
    telephonyMissing({
      mode: TELEPHONY_MODES.TEAMS_PHONE,
      callerId: "+14255550100",
      teamsResourceAccountId: "",
    }),
    ["TPE_RESOURCE_ACCOUNT_ID"],
  );
});

test("telephony mode is normalized and invalid values fail loudly", () => {
  assert.equal(normalizeTelephonyMode(" TEAMS-PHONE "), TELEPHONY_MODES.TEAMS_PHONE);
  assert.throws(
    () => normalizeTelephonyMode("automatic"),
    /TELEPHONY_MODE must be one of: acs-direct, teams-phone/,
  );
});
