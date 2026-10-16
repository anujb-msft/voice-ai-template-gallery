import { DefaultAzureCredential } from "@azure/identity";

let credential;

/** Keyless everywhere: `az login` locally, managed identity when hosted. */
export function getCredential() {
  credential ??= new DefaultAzureCredential();
  return credential;
}

const tokens = new Map();

export async function getToken(scope) {
  const cached = tokens.get(scope);
  if (cached && cached.expiresOnTimestamp - Date.now() > 120_000) return cached.token;
  const token = await getCredential().getToken(scope);
  if (!token) throw new Error(`no token for ${scope}`);
  tokens.set(scope, token);
  return token.token;
}
