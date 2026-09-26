import { createServer } from "node:http";
import { login } from "./auth.js";
import { renderDashboard } from "./dashboard.js";
import { orderHistory } from "./orders.js";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handle(req, res, session) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/dashboard") return res.end(renderDashboard());
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = JSON.parse(await new Promise((done) => { let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => done(data)); }));
    const user = login(body.email, body.password);
    return user ? json(res, 200, user) : json(res, 401, { error: "invalid credentials" });
  }
  if (url.pathname === "/api/me/orders") {
    if (!session) return json(res, 401, { error: "sign in" });
    return json(res, 200, { orders: orderHistory(session.id) });
  }
  return json(res, 404, { error: "not found" });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer((req, res) => handle(req, res, null)).listen(3000);
}
