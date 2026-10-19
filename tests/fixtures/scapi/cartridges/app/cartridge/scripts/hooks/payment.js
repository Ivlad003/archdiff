function Handle(basket, paymentInformation) {
  return { success: true };
}

function Authorize(orderNumber, paymentInstrument) {
  return { authorized: true };
}

exports.Handle = Handle;
exports.Authorize = Authorize;
