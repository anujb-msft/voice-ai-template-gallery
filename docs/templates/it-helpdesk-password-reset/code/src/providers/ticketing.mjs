import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.mjs";
import { config } from "../config.mjs";

/**
 * Ticketing provider contract.
 *
 * Implement the same shape against ServiceNow, Jira Service Management, Zendesk,
 * Freshservice, etc. and register it in `createTicketingProvider`.
 *
 * @typedef {object} TicketingProvider
 * @property {(input: {userId: string, sessionId: string, category: string, summary: string}) => Promise<{id: string}>} openTicket
 * @property {(id: string, resolution: {deflected: boolean, summary: string}) => Promise<void>} closeTicket
 * @property {() => Promise<object>} deflectionStats
 */

/** Reference implementation backed by the local SQLite table. */
export class SqliteTicketingProvider {
  name = "sqlite";

  async openTicket({ userId, sessionId, category, summary }) {
    const id = `INC${String(Date.now()).slice(-7)}`;
    db.prepare(
      `INSERT INTO tickets (id, session_id, user_id, category, status, deflected, cost_usd, minutes_saved, summary, created_at)
       VALUES (?, ?, ?, ?, 'open', 0, 0, 0, ?, ?)`,
    ).run(id, sessionId, userId, category, summary, nowIso());
    return { id };
  }

  /**
   * A ticket closed by the agent without human touch is a *deflected* ticket:
   * that is the number the business case is built on.
   */
  async closeTicket(id, { deflected, summary }) {
    db.prepare(
      `UPDATE tickets
          SET status = ?, deflected = ?, cost_usd = ?, minutes_saved = ?, summary = ?
        WHERE id = ?`,
    ).run(
      deflected ? "closed_deflected" : "closed_escalated",
      deflected ? 1 : 0,
      deflected ? config.demo.ticketCostUsd : 0,
      deflected ? config.demo.ticketMinutes : 0,
      summary,
      id,
    );
  }

  async deflectionStats() {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(deflected) AS deflected,
                COALESCE(SUM(cost_usd), 0) AS saved_usd,
                COALESCE(SUM(minutes_saved), 0) AS saved_minutes
           FROM tickets`,
      )
      .get();
    return {
      total: row.total ?? 0,
      deflected: row.deflected ?? 0,
      savedUsd: row.saved_usd ?? 0,
      savedMinutes: row.saved_minutes ?? 0,
      costPerTicketUsd: config.demo.ticketCostUsd,
      minutesPerTicket: config.demo.ticketMinutes,
    };
  }
}

export function createTicketingProvider(kind = process.env.TICKETING_PROVIDER ?? "sqlite") {
  switch (kind) {
    case "sqlite":
      return new SqliteTicketingProvider();

    // case "servicenow":
    //   return new ServiceNowTicketingProvider({ instance, user, password });
    //   //  POST /api/now/table/incident  { caller_id, short_description, category }
    //   //  PATCH /api/now/table/incident/{sys_id} { state: 6, close_code: 'Solved (Permanently)' }

    default:
      throw new Error(`Unknown TICKETING_PROVIDER "${kind}"`);
  }
}

export { randomUUID };
