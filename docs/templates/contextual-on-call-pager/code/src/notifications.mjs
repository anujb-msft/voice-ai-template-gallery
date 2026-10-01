export class TeamsNotifier {
  constructor({ workflowUrl = "", opsWorkflowUrl = "", fetchImpl = globalThis.fetch } = {}) {
    this.workflowUrl = workflowUrl;
    this.opsWorkflowUrl = opsWorkflowUrl;
    this.fetch = fetchImpl;
    this.sent = [];
  }

  async sendTechnicianCard(payload) {
    return this.#post(this.workflowUrl, payload, "technicianCard");
  }

  async sendOpsAlert(payload) {
    return this.#post(this.opsWorkflowUrl, payload, "opsAlert");
  }

  async #post(url, payload, kind) {
    this.sent.push({ kind, payload });
    if (!url) return { ok: true, simulated: true };
    const res = await this.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { ok: res.ok, status: res.status };
  }
}
