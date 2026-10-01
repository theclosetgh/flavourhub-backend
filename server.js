import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import multer from "multer";
import crypto from "crypto";
import { rateLimit } from "express-rate-limit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { createOrder, getOrders } from "./orders.store.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("🚀 FlavourHub backend is live");
});

const PORT = Number(process.env.PORT || 3000);

/* -------------------------
   Helpers
------------------------- */
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} not set`);
  return v;
}

/* -------------------------
   PostgreSQL (Discounts)
------------------------- */
const DATABASE_URL = requireEnv("DATABASE_URL");
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discounts (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed')),
      value NUMERIC(12,2) NOT NULL CHECK (value > 0),
      active BOOLEAN NOT NULL DEFAULT true,
      expires_at TIMESTAMPTZ NULL,
      min_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function mapDiscountRow(row) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: Number(row.value),
    active: !!row.active,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    minSubtotal: Number(row.min_subtotal || 0),
    description: row.description || "",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function sanitizeDiscountInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);

  if (!partial || has("code")) {
    const code = String(body?.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      throw new Error("Code must be 2-40 letters, numbers, hyphens, or underscores");
    }
    out.code = code;
  }

  if (!partial || has("type")) {
    const type = String(body?.type ?? "").trim().toLowerCase();
    if (!["percentage", "fixed"].includes(type)) {
      throw new Error("Type must be percentage or fixed");
    }
    out.type = type;
  }

  if (!partial || has("value")) {
    const value = Number(body?.value);
    const typeForValidation = out.type || String(body?.type ?? "").trim().toLowerCase();
    if (!Number.isFinite(value) || value <= 0) throw new Error("Value must be greater than 0");
    if (typeForValidation === "percentage" && value > 100) {
      throw new Error("Percentage must be greater than 0 and at most 100");
    }
    out.value = Number(value.toFixed(2));
  }

  if (!partial || has("active")) {
    const active = body?.active === undefined ? true : body.active;
    if (typeof active !== "boolean") throw new Error("Active must be a boolean");
    out.active = active;
  }

  if (!partial || has("expiresAt")) {
    const raw = body?.expiresAt;
    if (raw === undefined || raw === null || raw === "") {
      out.expiresAt = null;
    } else {
      const d = new Date(raw);
      if (!Number.isFinite(d.getTime())) throw new Error("Invalid expiration date");
      out.expiresAt = d.toISOString();
    }
  }

  if (!partial || has("minSubtotal")) {
    const raw = body?.minSubtotal;
    const minSubtotal = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(minSubtotal) || minSubtotal < 0) {
      throw new Error("Minimum subtotal must be a non-negative number");
    }
    out.minSubtotal = Number(minSubtotal.toFixed(2));
  }

  if (!partial || has("description")) {
    out.description = String(body?.description ?? "").trim();
  }

  return out;
}

async function getDiscounts() {
  const { rows } = await pool.query(`SELECT * FROM discounts ORDER BY created_at DESC`);
  return rows.map(mapDiscountRow);
}

async function getDiscountById(id) {
  const { rows } = await pool.query(`SELECT * FROM discounts WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? mapDiscountRow(rows[0]) : null;
}

async function getDiscountByCode(codeInput) {
  const code = String(codeInput ?? "").trim().toUpperCase();
  if (!code) return null;
  const { rows } = await pool.query(`SELECT * FROM discounts WHERE code = $1 LIMIT 1`, [code]);
  return rows[0] ? mapDiscountRow(rows[0]) : null;
}

async function createDiscount(input) {
  const clean = sanitizeDiscountInput(input, { partial: false });
  const id = crypto.randomUUID();

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO discounts (id, code, type, value, active, expires_at, min_subtotal, description, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
      RETURNING *;
      `,
      [
        id,
        clean.code,
        clean.type,
        clean.value,
        clean.active ?? true,
        clean.expiresAt,
        clean.minSubtotal ?? 0,
        clean.description ?? "",
      ]
    );
    return mapDiscountRow(rows[0]);
  } catch (e) {
    if (String(e?.message || "").includes("duplicate key")) {
      throw new Error("A discount with this code already exists");
    }
    throw e;
  }
}

async function updateDiscount(id, input) {
  const existing = await getDiscountById(id);
  if (!existing) return null;

  const mergedInput = { ...existing, ...input };
  const clean = sanitizeDiscountInput(mergedInput, { partial: false });

  try {
    const { rows } = await pool.query(
      `
      UPDATE discounts
      SET code = $2,
          type = $3,
          value = $4,
          active = $5,
          expires_at = $6,
          min_subtotal = $7,
          description = $8,
          updated_at = now()
      WHERE id = $1
      RETURNING *;
      `,
      [
        id,
        clean.code,
        clean.type,
        clean.value,
        clean.active ?? true,
        clean.expiresAt,
        clean.minSubtotal ?? 0,
        clean.description ?? "",
      ]
    );
    return rows[0] ? mapDiscountRow(rows[0]) : null;
  } catch (e) {
    if (String(e?.message || "").includes("duplicate key")) {
      throw new Error("A discount with this code already exists");
    }
    throw e;
  }
}

async function deleteDiscount(id) {
  const r = await pool.query(`DELETE FROM discounts WHERE id = $1`, [id]);
  return r.rowCount > 0;
}

function isDiscountUsable(discount) {
  if (!discount) return { ok: false, reason: "Discount not found" };
  if (!discount.active) return { ok: false, reason: "Discount is inactive" };
  if (discount.expiresAt && new Date(discount.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "Discount has expired" };
  }
  return { ok: true };
}

function computeDiscount(discount, subtotal) {
  const amount =
    discount.type === "percentage"
      ? (subtotal * Number(discount.value)) / 100
      : Number(discount.value);

  const discountAmount = Math.min(Math.max(amount, 0), subtotal);
  const total = Math.max(subtotal - discountAmount, 0);
  const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  return { discountAmount: round(discountAmount), total: round(total) };
}

async function resolveDiscountForSubtotal(code, subtotal) {
  const sub = Number(subtotal);
  if (!Number.isFinite(sub) || sub < 0) throw new Error("A valid subtotal is required");

  const discount = await getDiscountByCode(code);
  const usable = isDiscountUsable(discount);
  if (!usable.ok) throw new Error(usable.reason);

  if (sub < Number(discount.minSubtotal || 0)) {
    throw new Error(`Subtotal must be at least ${discount.minSubtotal} to use this discount`);
  }

  const { discountAmount, total } = computeDiscount(discount, sub);

  return {
    id: discount.id,
    code: discount.code,
    type: discount.type,
    value: discount.value,
    subtotal: sub,
    discountAmount,
    total,
    finalTotal: total,
  };
}

/* -------------------------
   CORS
------------------------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* -------------------------
   Health
------------------------- */
app.get("/api/health", async (req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.json({
    ok: true,
    dbOk,
    hasPaystackKeys: !!process.env.PAYSTACK_SECRET_KEY && !!process.env.PAYSTACK_PUBLIC_KEY,
    hasAdminPassword: !!process.env.ADMIN_PASSWORD,
    hasJwtSecret: !!process.env.JWT_SECRET,
    hasR2:
      !!process.env.CLOUDFLARE_ACCOUNT_ID &&
      !!process.env.R2_ACCESS_KEY_ID &&
      !!process.env.R2_SECRET_ACCESS_KEY &&
      !!process.env.R2_BUCKET_NAME &&
      !!process.env.R2_PUBLIC_BASE_URL,
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

/* -------------------------
   Menu Storage (menu.json)
------------------------- */
const DATA_FILE = path.join(process.cwd(), "menu.json");

function defaultMenu() {
  return { updatedAt: new Date().toISOString(), categories: [] };
}

function readMenu() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const d = defaultMenu();
      fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
      return d;
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    const d = defaultMenu();
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
    return d;
  }
}

function writeMenu(menu) {
  const data = { ...menu, updatedAt: new Date().toISOString() };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  return data;
}

/* -------------------------
   Public Menu
------------------------- */
app.get("/api/menu", (req, res) => res.json(readMenu()));

app.get("/api/menu/flat", (req, res) => {
  const d = readMenu();
  const out = [];
  for (const c of d.categories || []) {
    for (const it of c.items || []) out.push({ ...it, category: c.name });
  }
  res.json({ updatedAt: d.updatedAt, items: out });
});

/* -------------------------
   Admin Auth (JWT)
------------------------- */
function signToken() {
  const secret = requireEnv("JWT_SECRET");
  return jwt.sign({ role: "admin" }, secret, { expiresIn: "12h" });
}

function requireAdmin(req, res, next) {
  try {
    const secret = requireEnv("JWT_SECRET");
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

const limitDiscountAdminRequests = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

const publicDiscountRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

app.post("/api/admin/login", (req, res) => {
  try {
    const adminPass = requireEnv("ADMIN_PASSWORD");
    requireEnv("JWT_SECRET");

    const password = (req.body?.password || "").toString();
    if (!password || password !== adminPass) {
      return res.status(401).json({ error: "Wrong password" });
    }
    return res.json({ token: signToken() });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server misconfigured" });
  }
});

/* -------------------------
   Menu Save
------------------------- */
function coerceMenuBody(body) {
  if (body && Array.isArray(body.categories)) return body;

  if (Array.isArray(body)) {
    return {
      categories: body.map((c) => ({
        name: (c.category ?? c.name ?? "Menu").toString(),
        items: Array.isArray(c.items) ? c.items : [],
      })),
    };
  }

  if (body?.menu && Array.isArray(body.menu.categories)) return body.menu;

  return null;
}

function sanitizeMenu(menu) {
  if (!menu || !Array.isArray(menu.categories)) throw new Error("Invalid menu format");

  for (const cat of menu.categories) {
    cat.name = (cat.name ?? "").toString().trim();
    if (!cat.name) throw new Error("Category name missing");

    if (!Array.isArray(cat.items)) throw new Error("Invalid items for category: " + cat.name);

    for (const it of cat.items) {
      it.id = (it.id ?? "").toString();
      it.name = (it.name ?? "").toString().trim();
      it.desc = (it.desc ?? "").toString();
      it.image = (it.image ?? "").toString().trim();
      it.price = Number(it.price || 0);

      if (!it.name) throw new Error("Item name missing in: " + cat.name);
      if (!Number.isFinite(it.price) || it.price < 0) throw new Error("Invalid price for: " + it.name);

      if (!it.image && it.img) it.image = (it.img ?? "").toString().trim();
    }
  }

  return menu;
}

app.put("/api/admin/menu", requireAdmin, (req, res) => {
  try {
    const menu = coerceMenuBody(req.body);
    if (!menu) return res.status(400).json({ error: "Invalid menu format" });

    const clean = sanitizeMenu(menu);
    const saved = writeMenu(clean);
    return res.json(saved);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid menu" });
  }
});

/* -------------------------
   Discounts (Postgres-backed)
------------------------- */
app.get("/api/discounts", publicDiscountRateLimit, async (req, res) => {
  try {
    const discounts = await getDiscounts();
    const active = discounts
      .filter((d) => isDiscountUsable(d).ok)
      .map(({ id, code, type, value, expiresAt, minSubtotal, description }) => ({
        id,
        code,
        type,
        value,
        expiresAt,
        minSubtotal,
        description,
      }));
    return res.json({ discounts: active });
  } catch {
    return res.status(500).json({ error: "Unable to load discounts" });
  }
});

app.get("/api/admin/discounts", limitDiscountAdminRequests, requireAdmin, async (req, res) => {
  try {
    return res.json({ discounts: await getDiscounts() });
  } catch {
    return res.status(500).json({ error: "Unable to load discounts" });
  }
});

app.post("/api/admin/discounts", limitDiscountAdminRequests, requireAdmin, async (req, res) => {
  try {
    const created = await createDiscount(req.body || {});
    return res.status(201).json(created);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid discount" });
  }
});

app.put("/api/admin/discounts/:id", limitDiscountAdminRequests, requireAdmin, async (req, res) => {
  try {
    const discount = await updateDiscount(req.params.id, req.body || {});
    if (!discount) return res.status(404).json({ error: "Discount not found" });
    return res.json(discount);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid discount" });
  }
});

app.patch("/api/admin/discounts/:id/status", limitDiscountAdminRequests, requireAdmin, async (req, res) => {
  try {
    if (typeof req.body?.active !== "boolean") {
      return res.status(400).json({ error: "'active' boolean is required" });
    }
    const discount = await updateDiscount(req.params.id, { active: req.body.active });
    if (!discount) return res.status(404).json({ error: "Discount not found" });
    return res.json(discount);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Unable to update discount status" });
  }
});

app.delete("/api/admin/discounts/:id", limitDiscountAdminRequests, requireAdmin, async (req, res) => {
  try {
    if (!(await deleteDiscount(req.params.id))) return res.status(404).json({ error: "Discount not found" });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Unable to delete discount" });
  }
});

app.post("/api/discounts/validate", publicDiscountRateLimit, async (req, res) => {
  try {
    const code = (req.body?.code || "").toString().trim();
    if (!code) return res.status(400).json({ valid: false, error: "Discount code is required" });

    const result = await resolveDiscountForSubtotal(code, req.body?.subtotal);
    return res.json({ valid: true, ...result });
  } catch (e) {
    return res.status(400).json({ valid: false, error: e.message || "Invalid discount" });
  }
});

/* -------------------------
   Cloudflare R2 Upload (Admin)
------------------------- */
function requireR2Env() {
  const required = [
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL",
  ];

  const missing = required.filter((k) => !(process.env[k] || "").trim());
  if (missing.length) {
    throw new Error("Missing R2 env vars: " + missing.join(", "));
  }
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "");
    cb(ok ? null : new Error("Only JPG/PNG/WebP allowed"), ok);
  },
});

app.post("/api/admin/upload", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    requireR2Env();

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const ext = (req.file.originalname.split(".").pop() || "webp").toLowerCase();
    const key = `menu/${crypto.randomUUID()}.${ext}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const base = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
    const url = `${base}/${key}`;

    return res.json({ url, key });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ error: e.message || "Upload failed" });
  }
});

/* -------------------------
   Orders
------------------------- */
app.post("/api/orders", async (req, res) => {
  try {
    const body = req.body || {};
    const discountCode = String(body.discountCode ?? "").trim();
    const subtotalInput = body.subtotal ?? (discountCode ? undefined : body.total ?? body.amount ?? 0);
    const subtotal = Number(subtotalInput);
    if (!Number.isFinite(subtotal) || subtotal < 0) {
      return res.status(400).json({ error: "Subtotal must be a non-negative number" });
    }

    const discount = discountCode ? await resolveDiscountForSubtotal(discountCode, subtotal) : null;
    const total = discount ? discount.total : Number(body.total ?? subtotal);
    if (!Number.isFinite(total) || total < 0) {
      return res.status(400).json({ error: "Total must be a non-negative number" });
    }

    const order = {
      ...body,
      id: body.id || "ORD-" + Date.now(),
      subtotal,
      discountCode: discount ? discount.code : null,
      discountAmount: discount ? discount.discountAmount : 0,
      total,
      finalTotal: total,
      ...(discount ? { discount } : {}),
      status: "paid",
      createdAt: new Date().toISOString(),
    };

    createOrder(order);

    console.log("✅ ORDER SAVED:", order.id);
    console.log("📦 TOTAL ORDERS:", getOrders().length);
    console.log("🧾 ORDER DATA:", order);

    res.json({ success: true, order });
  } catch (e) {
    console.error("❌ ORDER SAVE FAILED", e);
    res.status(400).json({ error: e.message || "Failed to save order" });
  }
});

app.get("/api/orders/admin", requireAdmin, (req, res) => {
  res.json(getOrders());
});

/* -------------------------
   Paystack
------------------------- */
async function paystackInitialize({ email, amount, currency }) {
  const secret = requireEnv("PAYSTACK_SECRET_KEY");
  const url = "https://api.paystack.co/transaction/initialize";

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, amount, currency: currency || "GHS" }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.status) throw new Error(data?.message || "Paystack initialize failed");
  return data.data;
}

async function paystackVerify(reference) {
  const secret = requireEnv("PAYSTACK_SECRET_KEY");
  const url = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;

  const r = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${secret}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.status) throw new Error(data?.message || "Paystack verify failed");
  return data.data;
}

function validateInitBody(req) {
  const email = (req.body?.email || "").toString().trim();
  const amount = Number(req.body?.amount || 0);
  const currency = (req.body?.currency || "GHS").toString();

  if (!email) throw new Error("Email is required");
  if (!Number.isFinite(amount) || amount < 50) throw new Error("Amount is invalid");

  return { email, amount, currency };
}

async function handleInitialize(req, res) {
  try {
    const pub = requireEnv("PAYSTACK_PUBLIC_KEY");
    const { email, amount, currency } = validateInitBody(req);
    const init = await paystackInitialize({ email, amount, currency });
    return res.json({ public_key: pub, reference: init.reference, access_code: init.access_code });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Initialize failed" });
  }
}

async function handleVerify(req, res) {
  try {
    const reference = (req.params.reference || "").toString().trim();
    if (!reference) return res.status(400).json({ error: "Missing reference" });

    const tx = await paystackVerify(reference);
    if (tx.status === "success") return res.json({ status: "success", reference });

    return res.json({ status: tx.status || "unknown", reference });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Verify failed" });
  }
}

app.post("/api/paystack/initialize", handleInitialize);
app.get("/api/paystack/verify/:reference", handleVerify);
app.post("/paystack/initialize", handleInitialize);
app.get("/paystack/verify/:reference", handleVerify);

/* -------------------------
   Bootstrap
------------------------- */
async function start() {
  try {
    await initDb();
    await pool.query("SELECT 1");
    app.listen(PORT, () => console.log("Server running on port", PORT));
  } catch (e) {
    console.error("❌ Failed to start server:", e);
    process.exit(1);
  }
}

start();
