import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * ENV REQUIRED:
 *  - ADMIN_PASSWORD (choose a strong password)
 *  - JWT_SECRET (random long string)
 *  - ALLOWED_ORIGINS (comma-separated)
 *  - PAYSTACK_PUBLIC_KEY, PAYSTACK_SECRET_KEY (existing)
 */

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin / server-to-server / tools with no origin
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin), false);
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasPaystackKeys: !!process.env.PAYSTACK_SECRET_KEY && !!process.env.PAYSTACK_PUBLIC_KEY,
    hasAdminPassword: !!process.env.ADMIN_PASSWORD,
    hasJwtSecret: !!process.env.JWT_SECRET,
    allowedOrigins: ALLOWED_ORIGINS
  });
});

/**
 * MENU STORAGE
 * - Stored in menu.json on the server filesystem.
 * - NOTE: Render’s filesystem can reset on redeploy/restart.
 *   If you want permanent storage later, we can move this to Firebase/DB.
 */
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
          { id: "d1", name: "Obolo Sobolo Can", price: 40, desc: "", image: "" },
          { id: "d2", name: "Biggie Bissap Can", price: 30, desc: "", image: "" },
          { id: "d3", name: "Smallie Can", price: 20, desc: "", image: "" },
          { id: "d4", name: "Obolo Pine Can", price: 40, desc: "", image: "" },
          { id: "d5", name: "Biggie Pine Can", price: 30, desc: "", image: "" },
          { id: "d6", name: "Smallie Pine Can", price: 20, desc: "", image: "" }
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
  } catch (e) {
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

// Public menu
app.get("/api/menu", (req, res) => {
  res.json(readMenu());
});

// Admin auth
function signToken() {
  const secret = process.env.JWT_SECRET;
  const payload = { role: "admin" };
  return jwt.sign(payload, secret, { expiresIn: "12h" });
}

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
  if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET not set" });

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }
  return res.json({ token: signToken() });
});

// Save updated menu (admin)
app.put("/api/admin/menu", requireAdmin, (req, res) => {
  const menu = req.body;
  if (!menu || !Array.isArray(menu.categories)) {
    return res.status(400).json({ error: "Invalid menu format" });
  }

  // Ensure each item has an id
  for (const cat of menu.categories) {
    if (!cat.name || !Array.isArray(cat.items)) {
      return res.status(400).json({ error: "Invalid category" });
    }
    for (const it of cat.items) {
      if (!it.id) it.id = crypto.randomUUID();
      if (typeof it.price !== "number") it.price = Number(it.price || 0);
      if (it.image == null) it.image = "";
      if (it.desc == null) it.desc = "";
    }
  }

  const saved = writeMenu(menu);
  return res.json(saved);
});

/* =========================
   PAYSTACK ROUTES
   (Keep your existing Paystack logic here)
   Ensure your routes match the frontend:
   POST /api/paystack/initialize
   GET  /api/paystack/verify/:reference
========================= */

// NOTE: If you already have these routes in another file, keep them.
// Do not duplicate.

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
