import { getDb, nowIso } from "../db.mjs";
import { MemoryTicketing } from "../store.mjs";

/**
 * Ticketing provider contract.
 *
 * Implement the same shape against ServiceNow, Jira Service Management, Zendesk,
 * Freshservice, etc. and register it in `createTicketingProvider`.
 *
 * @typedef {object} TicketingProvider
 * @property {(input: {userId: string, sessionId: string, category: string, summary: string}) => Promise<{id: string}>} openTicket
 * @property {(id: string, resolution: {deflected: boolean, summary: string}) => Promise<void>} closeTicket
 * @property {() => Promise<{total: number, deflected: number}>} deflectionStats
 */

/** Reference implementation backed by the local SQLite table. */
export class SqliteTicketingProvider {
  name = "sqlite";

  async openTicket({ userId, sessionId, category, summary }) {
    const id = `INC${String(Date.now()).slice(-7)}`;
    getDb()
      .prepare(
        `INSERT INTO tickets (id, session_id, user_id, category, status, deflected, summary, created_at)
         VALUES (?, ?, ?, ?, 'open', 0, ?, ?)`,
      )
      .run(id, sessionId, userId, category, summary, nowIso());
    return { id };
  }

  /** A ticket the agent closes with no human involved is a *deflected* ticket. */
  async closeTicket(id, { deflected, summary }) {
    getDb()
      .prepare(`UPDATE tickets SET status = ?, deflected = ?, summary = ? WHERE id = ?`)
      .run(deflected ? "closed_deflected" : "closed_escalated", deflected ? 1 : 0, summary, id);
  }

  async deflectionStats() {
    const row = getDb().prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(deflected), 0) AS deflected FROM tickets`).get();
    return { total: row.total ?? 0, deflected: row.deflected ?? 0 };
  }
}

export function createTicketingProvider(kind = process.env.TICKETING_PROVIDER || "sqlite") {
  switch (kind) {
    case "sqlite":
      return new SqliteTicketingProvider();

    case "memory":
      return new MemoryTicketing();

    // case "servicenow":
    //   return new ServiceNowTicketingProvider({ instance, user, password });
    //   //  POST /api/now/table/incident  { caller_id, short_description, category }
    //   //  PATCH /api/now/table/incident/{sys_id} { state: 6, close_code: 'Solved (Permanently)' }

    default:
      throw new Error(`Unknown TICKETING_PROVIDER "${kind}"`);
  }
}
