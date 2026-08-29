const config = require("./config");

async function callGas(data) {
  const response = await fetch(config.GAS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      apiKey: config.API_KEY,
      ...data
    })
  });

  if (!response.ok) {
    throw new Error(`GAS Error: ${response.status}`);
  }

  return await response.json();
}

module.exports = {
  callGas
};