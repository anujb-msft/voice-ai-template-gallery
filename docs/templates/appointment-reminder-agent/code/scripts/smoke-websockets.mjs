import WebSocket from "ws";
const url = process.argv[2] ?? "ws://127.0.0.1:8099/ws/hub?user=*";
const ws = new WebSocket(url);
const done = (code) => { try { ws.close(); } catch {} process.exit(code); };
const timer = setTimeout(() => { console.error("timeout"); done(1); }, 5000);
ws.on("open", () => { clearTimeout(timer); console.log("websocket ok"); done(0); });
ws.on("error", (e) => { clearTimeout(timer); console.error(e.message); done(1); });
