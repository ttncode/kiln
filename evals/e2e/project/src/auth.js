import { createHash } from "node:crypto";
import { db } from "./db.js";

export function hashPassword(password) {
  return createHash("sha1").update(password).digest("hex");
}

export function login(email, password) {
  const user = db.users.find((each) => each.email === email);
  if (!user || user.passwordHash !== hashPassword(password)) return null;
  return { id: user.id, role: user.role };
}
