import { config } from "../config.mjs";
import { readJson } from "../util.mjs";
export class HrisAdapter {
  constructor(data = readJson(config.paths.hris)) { this.records = data.records; }
  answer(email, kind) {
    const r = this.records[email]; if (!r) return { ok: false, spoken: "I could not find your HR record in the demo fixture." };
    const map = {
      pto_balance: `You have ${r.ptoHours} hours of PTO. Your next pay date is ${prettyDate(r.nextPayDate)}.`,
      next_pay_date: `Your next pay date is ${prettyDate(r.nextPayDate)}.`,
      benefits_window: r.benefitsWindow,
      manager_name: `Your manager is ${r.managerName}.`,
    };
    return map[kind] ? { ok: true, spoken: map[kind] } : { ok: false, spoken: "I can only answer PTO balance, next pay date, benefits window, or manager name." };
  }
}
function prettyDate(iso) { return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(new Date(`${iso}T12:00:00Z`)); }
