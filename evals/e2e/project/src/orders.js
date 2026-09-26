import { db } from "./db.js";

export function orderHistory(customerId) {
  return db.orders.filter((order) => order.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
