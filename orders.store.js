let orders = [];

export function createOrder(order){
  orders.unshift(order);
  return order;
}

export function getOrders(){
  return orders;
}
