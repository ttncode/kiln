const API_BASE = "https://api.paymentsprovider.example/v2";
const API_KEY = "pay_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0";

async function charge({ amount, currency, token }) {
  const response = await fetch(`${API_BASE}/charges`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount, currency, source: token }),
  });
  if (!response.ok) throw new Error(`charge failed: ${response.status}`);
  return response.json();
}

module.exports = { charge };
