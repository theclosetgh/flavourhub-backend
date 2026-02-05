let orders = [];

function createOrder(order){
  orders.unshift(order);
  return order;
}

function getOrders(){
  return orders;
}

module.exports = { createOrder, getOrders };

