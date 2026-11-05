const { callMemberGasGet } = require("./gas-member");

async function testMemberGasGet() {
  // =================================
  // TEST PLATINUM
  // =================================
  console.log("=================================");
  console.log("TEST PLATINUM");
  console.log("=================================");
  try {
    const result = await callMemberGasGet({
      action: "member_platinum_list"
    });

    console.log("RAW RESPONSE:", JSON.stringify(result, null, 2));
    console.log("SUCCESS:", result?.success);
    console.log("IS ARRAY:", Array.isArray(result?.data));
    console.log("TOTAL:", Array.isArray(result?.data) ? result.data.length : "BUKAN ARRAY");
  } catch (error) {
    console.error("ERROR:", error.message);
  }

  // =================================
  // TEST UMUM
  // =================================
  console.log("\n=================================");
  console.log("TEST UMUM");
  console.log("=================================");
  try {
    const result = await callMemberGasGet({
      action: "member_umum_list"
    });

    console.log("RAW RESPONSE:", JSON.stringify(result, null, 2));
    console.log("SUCCESS:", result?.success);
    console.log("IS ARRAY:", Array.isArray(result?.data));
    console.log("TOTAL:", Array.isArray(result?.data) ? result.data.length : "BUKAN ARRAY");
  } catch (error) {
    console.error("ERROR:", error.message);
  }

  // =================================
  // TEST PELAJAR
  // =================================
  console.log("\n=================================");
  console.log("TEST PELAJAR");
  console.log("=================================");
  try {
    const result = await callMemberGasGet({
      action: "member_pelajar_list"
    });

    console.log("RAW RESPONSE:", JSON.stringify(result, null, 2));
    console.log("SUCCESS:", result?.success);
    console.log("IS ARRAY:", Array.isArray(result?.data));
    console.log("TOTAL:", Array.isArray(result?.data) ? result.data.length : "BUKAN ARRAY");
  } catch (error) {
    console.error("ERROR:", error.message);
  }

  // =================================
  // SELESAI
  // =================================
  console.log("\n=================================");
  console.log("SELESAI");
  console.log("=================================");
}

testMemberGasGet();