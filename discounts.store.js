import fs from "fs";
import path from "path";
import crypto from "crypto";

const DISCOUNTS_FILE = path.join(process.cwd(), "discounts.json");

function readDiscounts() {
  try {
    const discounts = JSON.parse(fs.readFileSync(DISCOUNTS_FILE, "utf8"));
    if (!Array.isArray(discounts)) throw new Error("Invalid discounts file");
    return discounts;
  } catch (error) {
    if (!fs.existsSync(DISCOUNTS_FILE)) {
      fs.writeFileSync(DISCOUNTS_FILE, "[]\n", "utf8");
      return [];
    }
    throw error;
  }
}

function writeDiscounts(discounts) {
  fs.writeFileSync(DISCOUNTS_FILE, JSON.stringify(discounts, null, 2) + "\n", "utf8");
  return discounts;
}

function normalizeExpiration(value) {
  if (value === undefined || value === null || value === "") return null;

  let date;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date = new Date(`${value}T23:59:59.999Z`);
    if (date.toISOString().slice(0, 10) !== value) throw new Error("Invalid expiration date");
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid expiration date");
  return date.toISOString();
}

function normalizeDiscount(input, existing = {}) {
  const data = { ...existing, ...input };
  const code = String(data.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
    throw new Error("Code must be 2-40 letters, numbers, hyphens, or underscores");
  }

  const type = String(data.type ?? "").trim().toLowerCase();
  if (!["percentage", "fixed"].includes(type)) {
    throw new Error("Type must be percentage or fixed");
  }

  const value = Number(data.value);
  if (!Number.isFinite(value) || value <= 0 || (type === "percentage" && value > 100)) {
    throw new Error(type === "percentage" ? "Percentage must be greater than 0 and at most 100" : "Value must be greater than 0");
  }

  const active = data.active === undefined ? true : data.active;
  if (typeof active !== "boolean") throw new Error("Active must be a boolean");

  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    code,
    type,
    value,
    active,
    expiresAt: normalizeExpiration(data.expiresAt),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function getDiscounts() {
  return readDiscounts();
}

export function createDiscount(input) {
  const discounts = readDiscounts();
  const discount = normalizeDiscount(input);
  if (discounts.some((item) => item.code === discount.code)) {
    throw new Error("A discount with this code already exists");
  }
  discounts.unshift(discount);
  writeDiscounts(discounts);
  return discount;
}

export function updateDiscount(id, input) {
  const discounts = readDiscounts();
  const index = discounts.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const discount = normalizeDiscount(input, discounts[index]);
  if (discounts.some((item, itemIndex) => itemIndex !== index && item.code === discount.code)) {
    throw new Error("A discount with this code already exists");
  }
  discounts[index] = discount;
  writeDiscounts(discounts);
  return discount;
}

export function deleteDiscount(id) {
  const discounts = readDiscounts();
  const filtered = discounts.filter((item) => item.id !== id);
  if (filtered.length === discounts.length) return false;
  writeDiscounts(filtered);
  return true;
}

export function calculateDiscount(codeInput, subtotalInput, now = new Date()) {
  const code = String(codeInput ?? "").trim().toUpperCase();
  if (!code) throw new Error("Discount code is required");

  const subtotal = Number(subtotalInput);
  if (!Number.isFinite(subtotal) || subtotal < 0) throw new Error("Subtotal must be a non-negative number");

  const discount = readDiscounts().find((item) => item.code === code);
  if (!discount) throw new Error("Invalid discount code");
  if (!discount.active) throw new Error("This discount is inactive");
  if (discount.expiresAt && now.getTime() > new Date(discount.expiresAt).getTime()) {
    throw new Error("This discount has expired");
  }

  const round = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;
  const discountAmount = Math.min(
    subtotal,
    round(discount.type === "percentage" ? subtotal * discount.value / 100 : discount.value)
  );
  const total = round(subtotal - discountAmount);

  return {
    code: discount.code,
    type: discount.type,
    value: discount.value,
    subtotal: round(subtotal),
    discountAmount,
    total,
    finalTotal: total
  };
}
