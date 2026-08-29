// ==================================================
// WAITING LIST API & HELPER FUNCTIONS
// ==================================================

async function getWaitingList() {
  const response = await fetch("/api/waiting-list");
  const result = await response.json();
  if (result.success) {
    return result.data || [];
  } else {
    throw new Error(result.message || "Gagal mengambil data waiting list");
  }
}

async function createWaitingList(payload) {
  const response = await fetch("/api/waiting-list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal membuat waiting list");
  }
  return result;
}

async function updateWaitingList(id, payload) {
  const response = await fetch(`/api/waiting-list/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal memperbarui waiting list");
  }
  return result;
}

async function updateStatusWaitingList(id, status) {
  const response = await fetch(`/api/waiting-list/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: status })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal memperbarui status waiting list");
  }
  return result;
}

async function bukaSesiMejaWaitingList(nomorMeja, namaPemesan, kasir, durasiJam) {
  const response = await fetch("/api/meja/buka", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nomorMeja: Number(nomorMeja),
      namaPemesan: namaPemesan,
      kasir: kasir,
      durasiJam: Number(durasiJam)
    })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal membuka sesi meja");
  }
  return result;
}

async function tambahDurasiSesiWaitingList(sessionId, durasiTambahJam) {
  const response = await fetch("/api/meja/tambah-durasi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sessionId,
      durasiTambahJam: Number(durasiTambahJam)
    })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal menambah durasi meja");
  }
  return result;
}

async function tambahPaketBilliardWaitingList(sessionId, durasiJam) {
  const response = await fetch("/api/meja/pesanan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sessionId,
      namaBarang: "1 Jam",
      qty: Number(durasiJam)
    })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || "Gagal menambahkan paket billiard");
  }
  return result;
}

async function tambahPesananSesiWaitingList(sessionId, namaBarang, qty) {
  const response = await fetch("/api/meja/pesanan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sessionId,
      namaBarang: namaBarang,
      qty: Number(qty)
    })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || `Gagal menambahkan pesanan ${namaBarang}`);
  }
  return result;
}

async function getSesiMejaWaitingList() {
  const response = await fetch("/api/meja/sesi");
  
  let result;
  try {
    result = await response.json();
  } catch (err) {
    throw new Error("Gagal memparsing response JSON dari endpoint /api/meja/sesi");
  }

  let data = result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (result.success === false) {
      throw new Error(result.message || "Gagal mengambil sesi meja dari server");
    }
    data = result.data || result.sesi || [];
  }

  if (!Array.isArray(data)) {
    throw new Error("Format data sesi meja tidak valid (bukan array)");
  }

  return data.map(s => ({
    nomorMeja: s.nomorMeja,
    status: s.status,
    sessionId: s.sessionId || s.session_id,
    waktuMulai: s.waktuMulai || s.waktu_mulai,
    waktuSelesai: s.waktuSelesai || s.waktu_selesai
  }));
}