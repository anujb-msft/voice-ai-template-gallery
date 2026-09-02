/**
 * Directory provider contract.
 *
 * The demo ships a SQLite implementation so the template runs with zero external
 * dependencies. To integrate a real identity system, implement this same shape
 * against Microsoft Entra ID, Okta, Active Directory, Ping, etc. and register it
 * in `createDirectoryProvider` below. Nothing outside this folder needs to change.
 *
 * @typedef {object} DirectoryUser
 * @property {string} id
 * @property {string} username
 * @property {string} displayName
 * @property {string} email
 * @property {string} phone         E.164, used as the outbound callback target
 * @property {string} [department]
 * @property {string} [employeeId]
 * @property {boolean} locked
 *
 * @typedef {object} DirectoryProvider
 * @property {(username: string) => Promise<DirectoryUser|null>} findByUsername
 * @property {(id: string) => Promise<DirectoryUser|null>} findById
 * @property {(id: string, password: string) => Promise<{ok: boolean, reason?: string}>} setPassword
 * @property {(id: string) => Promise<void>} unlockAccount
 * @property {(password: string, user: DirectoryUser) => {ok: boolean, failures: string[]}} validatePasswordPolicy
 */

import { SqliteDirectoryProvider } from "./sqlite-directory.mjs";

export function createDirectoryProvider(kind = process.env.DIRECTORY_PROVIDER ?? "sqlite") {
  switch (kind) {
    case "sqlite":
      return new SqliteDirectoryProvider();

    // case "entra":
    //   return new EntraDirectoryProvider({ tenantId, clientId, clientSecret });
    //   // Graph: GET /users?$filter=userPrincipalName eq '...'
    //   //        PATCH /users/{id} { passwordProfile: { forceChangePasswordNextSignIn: false, password } }
    //   //        Requires User-PasswordProfile.ReadWrite.All (app) and a privileged role.

    // case "okta":
    //   return new OktaDirectoryProvider({ orgUrl, apiToken });
    //   //  GET /api/v1/users/{login}
    //   //  POST /api/v1/users/{id}/lifecycle/reset_password?sendEmail=false

    default:
      throw new Error(`Unknown DIRECTORY_PROVIDER "${kind}"`);
  }
}
