// An in-memory store standing in for the real database in this repository's tests.
export const db = {
  users: [
    { id: 1, email: "ana@agency.test", name: "Ana", role: "staff", passwordHash: "" },
    { id: 2, email: "bo@client.test", name: "Bo", role: "customer", passwordHash: "" },
  ],
  projects: [
    { id: 10, name: "Website refresh", status: "RED" },
    { id: 11, name: "Mobile app", status: "YELLOW" },
    { id: 12, name: "Newsletter", status: "GREEN" },
  ],
  orders: [
    { id: 100, customerId: 2, total: 1200, createdAt: "2026-01-04" },
    { id: 101, customerId: 2, total: 300, createdAt: "2026-05-19" },
  ],
};
