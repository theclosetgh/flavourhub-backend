import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: allow your GitHub Pages origin (and local dev)
const ALLOWED_ORIGINS = [
  "https://theclosetgh.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // block other origins
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // sk_test... / sk_live...
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY; // pk_test... / pk_live...
const PAYSTACK_BASE = "https://api.paystack.co";

app.get("/", (req, res) => {
  res.json({ ok: true, service: "flavourhub-paystack-backend" });
});

app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, amount, currency, customer, order } = req.body || {};

    if (!PAYSTACK_SECRET_KEY || !PAYSTACK_PUBLIC_KEY) {
      return res.status(500).json({ error: "Missing Paystack keys on server (Render env vars)." });
    }
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!amount || amount < 100) return res.status(400).json({ error: "Amount is invalid (in pesewas)." });

    const reference = `FH_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    const payload = {
      email,
      amount,
      currency: currency || "GHS",
      reference,
      metadata: { customer, order }
    };

    const psRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const psData = await psRes.json();

    if (!psRes.ok || !psData.status) {
      return res.status(400).json({ error: psData?.message || "Paystack initialize failed.", raw: psData });
    }

    res.json({
      public_key: PAYSTACK_PUBLIC_KEY,
      reference,
      authorization_url: psData.data.authorization_url,
      access_code: psData.data.access_code
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error initializing payment." });
  }
});

app.get("/api/paystack/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Missing Paystack secret key on server." });
    }
    if (!reference) return res.status(400).json({ error: "Reference is required." });

    const psRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const psData = await psRes.json();

    if (!psRes.ok || !psData.status) {
      return res.status(400).json({ error: psData?.message || "Verification failed.", raw: psData });
    }

    const status = psData.data.status; // success / failed / abandoned
    res.json({
      paid: status === "success",
      status,
      reference: psData.data.reference,
      amount: psData.data.amount,
      currency: psData.data.currency,
      paid_at: psData.data.paid_at
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error verifying payment." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
