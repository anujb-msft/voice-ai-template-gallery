/**
 * Documentation stub for a Dataverse-backed CRM adapter.
 *
 * A production implementation would exchange the caller's delegated Entra token
 * through the OAuth 2.0 on-behalf-of flow, then call the Dataverse Web API as
 * that user. Every method below must preserve the same contract as the SQLite
 * demo adapter so CRM role and field-level security apply to reads and writes:
 *
 * - findAccounts(rep, utterance): GET accounts visible to the delegated user.
 * - getBriefing(rep, accountId): read account, contact, opportunity, activity,
 *   and task rows through Dataverse navigation properties.
 * - applyChangeSet(rep, callId, proposal): execute one transaction with
 *   Create/Update requests and a field-level audit record.
 * - revertCommit(rep, commitId): compare current values to audit `after` values
 *   before issuing compensating updates.
 */
export class DataverseCrmAdapter {
  name = "dataverse-stub";

  constructor({ url, tenantId, clientId } = {}) {
    this.url = url;
    this.tenantId = tenantId;
    this.clientId = clientId;
  }

  #notBuilt() {
    throw new Error(
      "The Dataverse CRM adapter is documented but not implemented in this demo. Set CRM_ADAPTER=sqlite for a runnable sample.",
    );
  }

  async findAccounts() { this.#notBuilt(); }
  async getBriefing() { this.#notBuilt(); }
  async getOpportunity() { this.#notBuilt(); }
  async applyChangeSet() { this.#notBuilt(); }
  async revertCommit() { this.#notBuilt(); }
  async saveDraft() { this.#notBuilt(); }
}
