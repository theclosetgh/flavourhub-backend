import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin), false);
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

/* -------------------------
   HEALTH
------------------------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasPaystackKeys: !!process.env.PAYSTACK_SECRET_KEY && !!process.env.PAYSTACK_PUBLIC_KEY,
    allowedOrigins: ALLOWED_ORIGINS
  });
});

/* -------------------------
   MENU STORAGE
   (Render disk can reset on redeploy; for permanent storage later,
    we can move to Firebase/DB.)
------------------------- */
const DATA_FILE = path.join(process.cwd(), "menu.json");

function defaultMenu() {
  return {
    updatedAt: new Date().toISOString(),
    categories: [
      { name: "Shawarma", items: [
        { id:"shaw1", name:"Sizzling Shawarma (Chicken)", price:50, desc:"Classic chicken shawarma.", image:"" },
        { id:"shaw2", name:"Minced with Flavour (Minced Meat)", price:60, desc:"Minced meat shawarma with signature flavour.", image:"" },
        { id:"shaw3", name:"Flavor Twist (Shredded Beef)", price:80, desc:"Shredded beef shawarma.", image:"" },
        { id:"shaw4", name:"Flavor Twist (Shredded Beef & Chicken)", price:90, desc:"Mixed shredded beef and chicken.", image:"" }
      ]},
      { name: "Shawarma + Fries", items: [
        { id:"sf1", name:"Chic ’n’ Chips (Chicken Shawarma + Fries)", price:65, desc:"Chicken shawarma served with fries.", image:"" },
        { id:"sf2", name:"Beef ’n’ Fries Fusion (Minced Meat + Fries)", price:75, desc:"Minced meat shawarma with fries.", image:"" },
        { id:"sf3", name:"Beef ’n’ Fries Fusion (Shredded Beef + Fries)", price:90, desc:"Shredded beef shawarma with fries.", image:"" }
      ]},
      { name: "Noodles", items: [
        { id:"n1", name:"Budget Bowl Series — Medium", price:40, desc:"Corned beef, egg & sausage.", image:"" },
        { id:"n2", name:"Budget Bowl Series — Large", price:60, desc:"Corned beef, egg & sausage.", image:"" },
        { id:"n3", name:"Golden Chicken Strings (Chicken Only)", price:70, desc:"Chicken-only noodles.", image:"" },
        { id:"n4", name:"Street Beef Vibes (Beef Only)", price:90, desc:"Beef-only noodles.", image:"" }
      ]},
      { name: "Spaghetti", items: [
        { id:"sp1", name:"Quick Prep — Medium", price:40, desc:"Corned beef, egg & sausage.", image:"" },
        { id:"sp2", name:"Quick Prep — Large", price:60, desc:"Corned beef, egg & sausage.", image:"" },
        { id:"sp3", name:"Savory Beef Bowl", price:80, desc:"Beef spaghetti bowl.", image:"" },
        { id:"sp4", name:"Chicken Royal (Chicken Only)", price:60, desc:"Chicken-only spaghetti.", image:"" }
      ]},
      { name: "Loaded Fries", items: [
        { id:"lf1", name:"Flavour Burst Fries", price:100, desc:"Fries with beef or chicken & cheese.", image:"" },
        { id:"lf2", name:"Melt and Crunch", price:130, desc:"Fries with beef or chicken, extra cheese.", image:"" }
      ]},
      { name: "Special Combos", items: [
        { id:"c1", name:"Obolo Bia Ye Guy (Chicken & Beef Shawarma with Fries)", price:150, desc:"Chicken & beef shawarma with fries.", image:"" },
        { id:"c2", name:"Big Man (Chicken & Beef Noodles)", price:140, desc:"Chicken & beef noodles.", image:"" },
        { id:"c3", name:"Full Flavour (Chicken & Beef Spaghetti)", price:100, desc:"Chicken & beef spaghetti.", image:"" }
      ]},
      { name: "Extras", items: [
        { id:"e1", name:"Fries", price:20, desc:"Extra fries.", image:"" },
        { id:"e2", name:"Wings (6 pcs)", price:50, desc:"Six pieces of wings.", image:"" },
        { id:"e3", name:"Cheese", price:20, desc:"Extra cheese.", image:"" },
        { id:"e4", name:"Bacon", price:18, desc:"Add bacon.", image:"" },
        { id:"e5", name:"Egg", price:8, desc:"Add egg.", image:"" }
      ]},
      { name: "Local Drinks", items: [
        { id:"d1", name:"Obolo Sobolo Can", price:40, desc:"", image:"" },
        { id:"d2", name:"Biggie Bissap Can", price:30, desc:"", image:"" },
        { id:"d3", name:"Smallie Can", price:20, desc:"", image:"" },
        { id:"d4", name:"Obolo Pine Can", price:40, desc:"Pineapple drink.", image:"" },
        { id:"d5", name:"Biggie Pine Can", price:30, desc:"Pineapple drink.", image:"" },
        { id:"d6", name:"Smallie Pine Can", price:20, desc:"Small pineapple drink.", image:"" }
      ]}
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
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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

app.get("/api/menu", (req, res) => res.json(readMenu()));

/* -------------------------
   ADMIN AUTH
------------------------- */
function requireEnv(name){
  if(!process.env[name]) throw new Error(`${name} not set`);
  return process.env[name];
}

function signToken(){
  const secret = requireEnv("JWT_SECRET");
  return jwt.sign({ role: "admin" }, secret, { expiresIn: "12h" });
}

function requireAdmin(req, res, next){
  try{
    const secret = requireEnv("JWT_SECRET");
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if(!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, secret);
    next();
  }catch{
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

app.post("/api/admin/login", (req, res) => {
  try{
    const password = (req.body?.password || "").toString();
    const adminPass = requireEnv("ADMIN_PASSWORD");
    requireEnv("JWT_SECRET");
    if(!password || password !== adminPass){
      return res.status(401).json({ error: "Wrong password" });
    }
    return res.json({ token: signToken() });
  }catch(e){
    return res.status(500).json({ error: e.message || "Server misconfigured" });
  }
});

app.put("/api/admin/menu", requireAdmin, (req, res) => {
  const menu = req.body;
  if (!menu || !Array.isArray(menu.categories)) {
    return res.status(400).json({ error: "Invalid menu format" });
  }
  for (const cat of menu.categories) {
    if (!cat.name || !Array.isArray(cat.items)) return res.status(400).json({ error: "Invalid category" });
    for (const it of cat.items) {
      if (typeof it.price !== "number") it.price = Number(it.price || 0);
      if (it.desc == null) it.desc = "";
      if (it.image == null) it.image = "";
      if (it.id == null) it.id = "";
    }
  }
  const saved = writeMenu(menu);
  return res.json(saved);
});

/* -------------------------
   PAYSTACK (supports BOTH route styles)
------------------------- */
async function paystackInitialize({ email, amount, currency, reference }) {
  const secret = requireEnv("PAYSTACK_SECRET_KEY");
  const url = "https://api.paystack.co/transaction/initialize";
  const body = {
    email,
    amount,
    currency: currency || "GHS",
    ...(reference ? { reference } : {})
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.status) {
    throw new Error(data?.message || "Paystack initialize failed");
  }
  return data.data; // { authorization_url, access_code, reference }
}

async function paystackVerify(reference) {
  const secret = requireEnv("PAYSTACK_SECRET_KEY");
  const url = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.status) {
    throw new Error(data?.message || "Paystack verify failed");
  }
  return data.data; // transaction data
}

function validateInitBody(req){
  const email = (req.body?.email || "").toString().trim();
  const amount = Number(req.body?.amount || 0);
  if(!email) throw new Error("Email is required");
  if(!amount || amount < 50) throw new Error("Amount is invalid");
  return { email, amount, currency: req.body?.currency || "GHS" };
}

async function handleInitialize(req, res){
  try{
    const pub = requireEnv("PAYSTACK_PUBLIC_KEY");
    const { email, amount, currency } = validateInitBody(req);
    const init = await paystackInitialize({ email, amount, currency });
    return res.json({
      public_key: pub,
      reference: init.reference,
      access_code: init.access_code
    });
  }catch(e){
    return res.status(400).json({ error: e.message || "Initialize failed" });
  }
}

async function handleVerify(req, res){
  try{
    const reference = (req.params.reference || "").toString();
    if(!reference) return res.status(400).json({ error: "Missing reference" });

    const tx = await paystackVerify(reference);

    // Paystack returns status like "success"
    if (tx.status === "success") return res.json({ status: "success", reference });
    return res.json({ status: tx.status || "unknown", reference });
  }catch(e){
    return res.status(400).json({ error: e.message || "Verify failed" });
  }
}

// Primary (recommended)
app.post("/api/paystack/initialize", handleInitialize);
app.get("/api/paystack/verify/:reference", handleVerify);

// Compatibility (if older frontend calls without /api)
app.post("/paystack/initialize", handleInitialize);
app.get("/paystack/verify/:reference", handleVerify);

app.listen(PORT, () => console.log("Server running on port", PORT));
