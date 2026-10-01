import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import multer from "multer";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createOrder, getOrders } from "./orders.store.js";
import {
  getDiscounts,
  getDiscountById,
  getDiscountByCode,
  createDiscount,
  updateDiscount,
  deleteDiscount,
} from "./discounts.store.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("🚀 FlavourHub backend is live");
});

const PORT = process.env.PORT || 3000;

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
   Helpers
------------------------- */
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} not set`);
  return v;
}

/* -------------------------
   Health
------------------------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
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
   NOTE: File storage may reset on redeploy.
------------------------- */
const DATA_FILE = path.join(process.cwd(), "menu.json");

function defaultMenu() {
  return {
    updatedAt: new Date().toISOString(),
    categories: [
      {
        name: "Shawarma",
        items: [
          { id: "shaw1", name: "Sizzling Shawarma (Chicken)", price: 50, desc: "Classic chicken shawarma.", image: "" },
          { id: "shaw2", name: "Minced with Flavour (Minced Meat)", price: 60, desc: "Minced meat shawarma with signature flavour.", image: "" },
          { id: "shaw3", name: "Flavor Twist (Shredded Beef)", price: 80, desc: "Shredded beef shawarma.", image: "" },
          { id: "shaw4", name: "Flavor Twist (Shredded Beef & Chicken)", price: 90, desc: "Mixed shredded beef and chicken.", image: "" }
        ]
      },
      {
        name: "Shawarma + Fries",
        items: [
          { id: "sf1", name: "Chic ’n’ Chips (Chicken Shawarma + Fries)", price: 65, desc: "Chicken shawarma served with fries.", image: "" },
          { id: "sf2", name: "Beef ’n’ Fries Fusion (Minced Meat + Fries)", price: 75, desc: "Minced meat shawarma with fries.", image: "" },
          { id: "sf3", name: "Beef ’n’ Fries Fusion (Shredded Beef + Fries)", price: 90, desc: "Shredded beef shawarma with fries.", image: "" }
        ]
      },
      {
        name: "Noodles",
        items: [
          { id: "n1", name: "Budget Bowl Series — Medium", price: 40, desc: "Corned beef, egg & sausage.", image: "" },
          { id: "n2", name: "Budget Bowl Series — Large", price: 60, desc: "Corned beef, egg & sausage.", image: "" },
          { id: "n3", name: "Golden Chicken Strings (Chicken Only)", price: 70, desc: "Chicken-only noodles.", image: "" },
          { id: "n4", name: "Street Beef Vibes (Beef Only)", price: 90, desc: "Beef-only noodles.", image: "" }
        ]
      },
      {
        name: "Spaghetti",
        items: [
          { id: "sp1", name: "Quick Prep — Medium", price: 40, desc: "Corned beef, egg & sausage.", image: "" },
          { id: "sp2", name: "Quick Prep — Large", price: 60, desc: "Corned beef, egg & sausage.", image: "" },
          { id: "sp3", name: "Savory Beef Bowl", price: 80, desc: "Beef spaghetti bowl.", image: "" },
          { id: "sp4", name: "Chicken Royal (Chicken Only)", price: 60, desc: "Chicken-only spaghetti.", image: "" }
        ]
      },
      {
        name: "Loaded Fries",
        items: [
          { id: "lf1", name: "Flavour Burst Fries", price: 100, desc: "Fries with beef or chicken & cheese.", image: "" },
          { id: "lf2", name: "Melt and Crunch", price: 130, desc: "Fries with beef or chicken, extra cheese.", image: "" }
        ]
      },
      {
        name: "Special Combos",
        items: [
          { id: "c1", name: "Obolo Bia Ye Guy (Chicken & Beef Shawarma with Fries)", price: 150, desc: "Chicken & beef shawarma with fries.", image: "" },
          { id: "c2", name: "Big Man (Chicken & Beef Noodles)", price: 140, desc: "Chicken & beef noodles.", image: "" },
          { id: "c3", name: "Full Flavour (Chicken & Beef Spaghetti)", price: 100, desc: "Chicken & beef spaghetti.", image: "" }
        ]
      },
      {
        name: "Extras",
        items: [
          { id: "e1", name: "Fries", price: 20, desc: "Extra fries.", image: "" },
          { id: "e2", name: "Wings (6 pcs)", price: 50, desc: "Six pieces of wings.", image: "" },
          { id: "e3", name: "Cheese", price: 20, desc: "Extra cheese.", image: "" },
          { id: "e4", name: "Bacon", price: 18, desc: "Add bacon.", image: "" },
          { id: "e5", name: "Egg", price: 8, desc: "Add egg.", image: "" }
        ]
      },
      {
        name: "Local Drinks",
        items: [
          { id: "ld1", name: "Obolo Sobolo Can", price: 40, desc: "", image: "" },
          { id: "ld2", name: "Biggie Bissap Can", price: 30, desc: "", image: "" },
          { id: "ld3", name: "Smallie Can", price: 20, desc: "", image: "" },
          { id: "ld4", name: "Obolo Pine Can", price: 40, desc: "Pineapple drink.", image: "" },
          { id: "ld5", name: "Biggie Pine Can", price: 30, desc: "Pineapple drink.", image: "" },
          { id: "ld6", name: "Smallie Pine Can", price: 20, desc: "Small pineapple drink.", image: "" }
        ]
      }
    ]
  };
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

/* -------------------------
   Rate limiting
------------------------- */
const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
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
   Cloudflare R2 Upload (Admin)
------------------------- */
function requireR2Env() {
  const required = [
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL"
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
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "");
    cb(ok ? null : new Error("Only JPG/PNG/WebP allowed"), ok);
  }
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
        ContentType: req.file.mimetype
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
   Discounts
   NOTE: Persisted to discounts.json, same file-based
   approach used for the menu.
------------------------- */
const DISCOUNT_TYPES = ["percentage", "fixed"];

function sanitizeDiscountInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);

  if (!partial || has("code")) {
    const code = (body?.code ?? "").toString().trim().toUpperCase();
    if (!code) throw new Error("Discount code is required");
    out.code = code;
  }

  if (!partial || has("type")) {
    const type = (body?.type ?? "").toString().trim().toLowerCase();
    if (!DISCOUNT_TYPES.includes(type)) {
      throw new Error(`Discount type must be one of: ${DISCOUNT_TYPES.join(", ")}`);
    }
    out.type = type;
  }

  if (!partial || has("value")) {
    const value = Number(body?.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Discount value must be a positive number");
    const type = out.type || body?.type;
    if (type === "percentage" && value > 100) throw new Error("Percentage discount value cannot exceed 100");
    out.value = value;
  }

  if (!partial || has("active")) {
    out.active = body?.active === undefined ? true : !!body.active;
  }

  if (!partial || has("expiresAt")) {
    const raw = body?.expiresAt;
    if (raw === null || raw === undefined || raw === "") {
      out.expiresAt = null;
    } else {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error("Invalid expiresAt date");
      out.expiresAt = d.toISOString();
    }
  }

  if (!partial || has("minSubtotal")) {
    const raw = body?.minSubtotal;
    if (raw === null || raw === undefined || raw === "") {
      out.minSubtotal = 0;
    } else {
      const min = Number(raw);
      if (!Number.isFinite(min) || min < 0) throw new Error("minSubtotal must be a non-negative number");
      out.minSubtotal = min;
    }
  }

  if (!partial || has("description")) {
    out.description = (body?.description ?? "").toString().trim();
  }

  return out;
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
  const amount = discount.type === "percentage" ? (subtotal * discount.value) / 100 : discount.value;
  const discountAmount = Math.min(Math.max(amount, 0), subtotal);
  const total = Math.max(subtotal - discountAmount, 0);
  return { discountAmount, total };
}

function resolveDiscountForSubtotal(code, subtotal) {
  const sub = Number(subtotal);
  if (!Number.isFinite(sub) || sub < 0) throw new Error("A valid subtotal is required");

  const discount = getDiscountByCode(code);
  const usable = isDiscountUsable(discount);
  if (!usable.ok) throw new Error(usable.reason);

  if (discount.minSubtotal && sub < discount.minSubtotal) {
    throw new Error(`Subtotal must be at least ${discount.minSubtotal} to use this discount`);
  }

  const { discountAmount, total } = computeDiscount(discount, sub);
  return {
    code: discount.code,
    type: discount.type,
    value: discount.value,
    subtotal: sub,
    discountAmount,
    total,
  };
}

app.get("/api/discounts", publicDiscountRateLimit, (req, res) => {
  const active = getDiscounts()
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
  res.json({ discounts: active });
});

app.post("/api/discounts/validate", publicDiscountRateLimit, (req, res) => {
  try {
    const code = (req.body?.code || "").toString().trim();
    if (!code) return res.status(400).json({ error: "Discount code is required" });

    const result = resolveDiscountForSubtotal(code, req.body?.subtotal);
    return res.json({ valid: true, ...result });
  } catch (e) {
    return res.status(400).json({ valid: false, error: e.message || "Invalid discount code" });
  }
});

app.get("/api/admin/discounts", adminRateLimit, requireAdmin, (req, res) => {
  res.json({ discounts: getDiscounts() });
});

app.post("/api/admin/discounts", adminRateLimit, requireAdmin, (req, res) => {
  try {
    const clean = sanitizeDiscountInput(req.body);
    if (getDiscountByCode(clean.code)) {
      return res.status(400).json({ error: "A discount with this code already exists" });
    }
    const created = createDiscount(clean);
    return res.status(201).json(created);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid discount" });
  }
});

app.put("/api/admin/discounts/:id", adminRateLimit, requireAdmin, (req, res) => {
  try {
    const existing = getDiscountById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Discount not found" });

    const clean = sanitizeDiscountInput(req.body, { partial: true });
    if (clean.code && clean.code !== existing.code && getDiscountByCode(clean.code)) {
      return res.status(400).json({ error: "A discount with this code already exists" });
    }

    const updated = updateDiscount(req.params.id, clean);
    return res.json(updated);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid discount" });
  }
});

app.patch("/api/admin/discounts/:id/status", adminRateLimit, requireAdmin, (req, res) => {
  try {
    const existing = getDiscountById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Discount not found" });

    if (typeof req.body?.active !== "boolean") {
      return res.status(400).json({ error: "'active' boolean is required" });
    }

    const updated = updateDiscount(req.params.id, { active: req.body.active });
    return res.json(updated);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Failed to update discount status" });
  }
});

app.delete("/api/admin/discounts/:id", adminRateLimit, requireAdmin, (req, res) => {
  const existing = getDiscountById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Discount not found" });

  deleteDiscount(req.params.id);
  return res.json({ success: true });
});

/* -------------------------
   Orders
------------------------- */
app.post("/api/orders", (req, res) => {
  let discountInfo = null;
  const discountCode = (req.body?.discountCode || "").toString().trim();

  if (discountCode) {
    try {
      const subtotal = req.body?.subtotal ?? req.body?.amount;
      discountInfo = resolveDiscountForSubtotal(discountCode, subtotal);
    } catch (e) {
      return res.status(400).json({ error: e.message || "Invalid discount code" });
    }
  }

  try {
    const order = {
      id: "ORD-" + Date.now(),
      ...req.body,
      ...(discountInfo ? { discount: discountInfo } : {}),
      status: "paid",
      createdAt: new Date().toISOString()
    };

    createOrder(order);

    console.log("✅ ORDER SAVED:", order.id);
    console.log("📦 TOTAL ORDERS:", getOrders().length);
    console.log("🧾 ORDER DATA:", order);

    res.json({ success: true, order });
  } catch (e) {
    console.error("❌ ORDER SAVE FAILED", e);
    res.status(400).json({ error: "Failed to save order" });
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
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, amount, currency: currency || "GHS" })
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

app.listen(PORT, () => console.log("Server running on port", PORT));
