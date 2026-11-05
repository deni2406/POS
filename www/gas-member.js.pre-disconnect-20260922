const config = require("./config");

async function callMemberGas(data) {
  if (!config.GAS_MEMBER_URL) {
    throw new Error("GAS_MEMBER_URL belum dikonfigurasi");
  }

  const payload = {
    apiKey: config.API_KEY,
    ...(data || {})
  };

  const response = await fetch(config.GAS_MEMBER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error("Response JSON tidak valid dari GAS Member");
  }

  return result;
}

async function callMemberGasGet(params) {
  if (!config.GAS_MEMBER_URL) {
    throw new Error("GAS_MEMBER_URL belum dikonfigurasi");
  }

  const queryParams = new URLSearchParams({
    apiKey: config.API_KEY,
    ...(params || {})
  });

  const url = `${config.GAS_MEMBER_URL}?${queryParams.toString()}`;

  console.log("[DEBUG_MEMBER_URL]", url);
  
  const response = await fetch(url, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error("Response JSON tidak valid dari GAS Member");
  }

  return result;
}

module.exports = {
  callMemberGas,
  callMemberGasGet
};