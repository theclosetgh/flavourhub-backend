import fs from "fs";
import path from "path";
import crypto from "crypto";

/* -------------------------
   Discount Storage (discounts.json)
   NOTE: File storage may reset on redeploy.
------------------------- */
const DATA_FILE = path.join(process.cwd(), "discounts.json");

function defaultData() {
  return { updatedAt: new Date().toISOString(), discounts: [] };
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const d = defaultData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
      return d;
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.discounts)) parsed.discounts = [];
    return parsed;
  } catch {
    const d = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
    return d;
  }
}

function writeData(discounts) {
  const data = { updatedAt: new Date().toISOString(), discounts };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  return data;
}

export function getDiscounts() {
  return readData().discounts;
}

export function getDiscountById(id) {
  return getDiscounts().find((d) => d.id === id) || null;
}

export function getDiscountByCode(code) {
  const normalized = (code || "").toString().trim().toUpperCase();
  if (!normalized) return null;
  return getDiscounts().find((d) => d.code === normalized) || null;
}

export function createDiscount(discount) {
  const discounts = getDiscounts();
  const now = new Date().toISOString();
  const record = {
    id: "DISC-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    ...discount,
    createdAt: now,
    updatedAt: now,
  };
  discounts.unshift(record);
  writeData(discounts);
  return record;
}

export function updateDiscount(id, updates) {
  const discounts = getDiscounts();
  const idx = discounts.findIndex((d) => d.id === id);
  if (idx === -1) return null;

  const updated = {
    ...discounts[idx],
    ...updates,
    id: discounts[idx].id,
    createdAt: discounts[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  discounts[idx] = updated;
  writeData(discounts);
  return updated;
}

export function deleteDiscount(id) {
  const discounts = getDiscounts();
  const idx = discounts.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  discounts.splice(idx, 1);
  writeData(discounts);
  return true;
}
