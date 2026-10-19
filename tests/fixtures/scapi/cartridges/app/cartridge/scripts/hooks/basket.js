function modifyGETResponse(basket, doc) {
  doc.c_note = "seen";
  return doc;
}

function beforePOST(basket) {
  return basket;
}

exports.modifyGETResponse = modifyGETResponse;
exports.modifyGETResponse.public = true;
exports.beforePOST = beforePOST;
