const jwt = require("jsonwebtoken");

function sign(payload, privateKey, algorithm) {
  return jwt.sign(JSON.stringify(payload), privateKey, {
    algorithm
  });
}

function signES256(payload, privateKey) {
  return sign(payload, privateKey, 'ES256');
}

module.exports = {
  sign,
  signES256
};