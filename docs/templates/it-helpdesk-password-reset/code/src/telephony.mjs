export const TELEPHONY_MODES = Object.freeze({
  ACS_DIRECT: "acs-direct",
  TEAMS_PHONE: "teams-phone",
});

export function normalizeTelephonyMode(value = TELEPHONY_MODES.ACS_DIRECT) {
  const mode = String(value).trim().toLowerCase();
  if (!Object.values(TELEPHONY_MODES).includes(mode)) {
    throw new Error(
      `TELEPHONY_MODE must be one of: ${Object.values(TELEPHONY_MODES).join(", ")}`,
    );
  }
  return mode;
}

export function telephonyMissing({ mode, callerId, teamsResourceAccountId }) {
  if (mode === TELEPHONY_MODES.TEAMS_PHONE) {
    return teamsResourceAccountId ? [] : ["TPE_RESOURCE_ACCOUNT_ID"];
  }
  return callerId ? [] : ["ACS_CALLER_ID"];
}

export function callerArguments({ mode, callerId, teamsResourceAccountId }) {
  const missing = telephonyMissing({ mode, callerId, teamsResourceAccountId });
  if (missing.length) throw new Error(`Missing required environment variable: ${missing[0]}`);

  if (mode === TELEPHONY_MODES.TEAMS_PHONE) {
    return {
      invite: {},
      options: {
        teamsAppSource: {
          // For TPE this is the Teams resource account object ID, despite the
          // communication-common SDK property retaining the teamsAppId name.
          teamsAppId: teamsResourceAccountId,
        },
      },
    };
  }

  return {
    invite: {
      sourceCallIdNumber: { phoneNumber: callerId },
    },
    options: {},
  };
}
