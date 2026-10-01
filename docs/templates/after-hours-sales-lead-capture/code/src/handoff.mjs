import { config } from "./config.mjs";
const VOIP_VALUE_LIMIT = 1024;
export function teamsIdentifier(target) { if (!target?.objectId) throw new Error("sales queue target has no objectId"); return target.type === "user" ? { microsoftTeamsUserId: target.objectId } : { teamsAppId: target.objectId, cloud: config.acs.teamsCloud }; }
export function resourceAccountFrom(to) { const match=/^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? ""); return match ? match[1] : null; }
export function buildCustomCallingContext(context) { return [["CallDetails.SessionId", context.sessionId], ["CallDetails.CallTopic", context.callTopic], ["CallDetails.CallContext", context.callContext], ["CallDetails.RouteId", context.routeId], ["CallDetails.AfterHours", context.afterHours ? "true" : null]].filter(([,v])=>v!=null&&v!=="").map(([key,value])=>({ kind:"voip", key, value:String(value).slice(0, key === "CallDetails.CallTopic" ? 48 : VOIP_VALUE_LIMIT) })); }
