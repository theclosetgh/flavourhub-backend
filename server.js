import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

/**
 * ENV VARS REQUIRED ON RENDER
 * PAYSTACK_SECRET_KEY = sk_test_... or sk_live_...
 * PAYSTACK_PUBLIC_KEY = pk_test_... or pk_live_...
 *
 * OPTIONAL:
 * ALLOWED_ORIGINS = https://yourdomain.com,https://www.yourdomain.com,https://theclosetgh.github.io
 */

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// CORS: allow listed origins; if none provided, allow all (useful for first test).
app.use(cors({
  origin: function(origin, cb){
    if (!origin) return cb(null, true); // tools/curl
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

// Simple health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasPaystackKeys: Boolean(PAYSTACK_SECRET_KEY && PAYSTACK_PUBLIC_KEY),
    allowedOrigins
  });
});

// In-memory store (optional). For production, use a DB.
const orderStore = new Map();

function makeReference(){
  // Example: FH_20260115_ABC123XYZ
  const rand = crypto.randomBytes(6).toString("hex").toUpperCase();
  const date = new Date().toISOString().slice(0,10).replaceAll("-","");
  return `FH_${date}_${rand}`;
}

/**
 * POST /api/paystack/initialize
 * The frontend calls this first.
 * We return a reference + public key.
 */
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY || !PAYSTACK_PUBLIC_KEY) {
      return res.status(500).json({ error: "Missing Paystack keys on server (Render env vars)." });
    }

    const body = req.body || {};
    const email = String(body.email || "").trim();
    const amount = Number(body.amount || 0); // pesewas
    const currency = String(body.currency || "GHS").toUpperCase();

    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!Number.isFinite(amount) || amount < 100) return res.status(400).json({ error: "Amount must be >= 100 pesewas." });

    const reference = makeReference();

    // Optionally store the order so you can fetch it later
    orderStore.set(reference, {
      reference,
      email,
      amount,
      currency,
      order: body.order || {},
      customer: body.customer || {},
      createdAt: new Date().toISOString()
    });

    // We are using Paystack INLINE on frontend. Inline can work with any unique reference.
    // Verification will call Paystack verify endpoint using the secret key.
    return res.json({ reference, public_key: PAYSTACK_PUBLIC_KEY });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error initializing payment." });
  }
});

/**
 * GET /api/paystack/verify/:reference
 * Frontend calls this after Paystack callback.
 * We verify via Paystack API.
 */
app.get("/api/paystack/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Missing Paystack secret key on server." });
    }

    const reference = String(req.params.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Reference required." });

    const verifyUrl = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;

    const r = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || "Paystack verify failed." });
    }

    const status = data?.data?.status;            // "success"
    const paidAmount = data?.data?.amount;        // pesewas
    const paidCurrency = data?.data?.currency;    // "GHS"
    const paidAt = data?.data?.paid_at;

    // You can also attach stored order for convenience
    const stored = orderStore.get(reference) || null;

    if (status === "success") {
      return res.json({
        status: "success",
        reference,
        paid_amount: paidAmount,
        currency: paidCurrency,
        paid_at: paidAt,
        stored_order: stored
      });
    }

    return res.json({
      status: status || "unknown",
      reference,
      paystack: data?.data || null,
      stored_order: stored
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error verifying payment." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
