import assert from "node:assert/strict";
import { test } from "node:test";
import { orderHistory } from "../src/orders.js";

test("a customer's orders, newest first", () => {
  assert.deepEqual(orderHistory(2).map((order) => order.id), [101, 100]);
});
