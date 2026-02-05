const express = require("express");
const router = express.Router();
const store = require("../orders.store");
const { requireAdmin } = require("../middleware/auth");

// Save paid order
router.post("/", (req, res) => {
  const order = {
    id: "ORD-" + Date.now(),
    ...req.body,
    status: "paid",
    createdAt: new Date().toISOString()
  };
  store.createOrder(order);
  res.json({ success: true, order });
});

// Admin view orders
router.get("/admin", requireAdmin, (req,res)=>{
  res.json(store.getOrders());
});

module.exports = router;
