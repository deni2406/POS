function renderWaitingList() {
  const container = document.getElementById("waitingListContainer");
  if (!container) return;

  if (!waitingListData || waitingListData.length === 0) {
    container.innerHTML = `
      <div class="wl-empty-state">
        Tidak ada data waiting list / booking.
      </div>
    `;
    return;
  }

  const activeWaitingList = waitingListData.filter(item => ["WAITING", "CONFIRMED"].includes(String(item.status || "").toUpperCase()));

  container.innerHTML = activeWaitingList.map((item, index) => {
    const status = String(item.status || "WAITING").toUpperCase();

    let statusClass = "wl-status-waiting";
    if (status === "CONFIRMED") statusClass = "wl-status-confirmed";
    else if (status === "SEATED" || status === "SERVED") statusClass = "wl-status-seated";
    else if (status === "CANCELLED" || status === "BATAL") statusClass = "wl-status-cancelled";
    else if (status === "EXPIRED") statusClass = "wl-status-expired";

    const nomorMejaText = item.nomorMeja
      ? `Meja ${Number(item.nomorMeja) < 10 ? "0" + Number(item.nomorMeja) : Number(item.nomorMeja)}`
      : "Bebas";

    const pesanan = Array.isArray(item.pesanan) ? item.pesanan : [];

    const pesananHtml = pesanan.length
      ? `
        <div class="wl-pesanan-list">
          ${pesanan.map(p => `
            <div class="wl-pesanan-row">
              <span>${escapeHtml(p.nama || p.name || p.namaProduk || "Produk")}</span>
              <span>${Number(p.qty || p.jumlah || 1)}x</span>
            </div>
          `).join("")}
        </div>
      `
      : `<div class="wl-pesanan-empty">Tidak ada pesanan pre-order</div>`;

    const actionHtml = status === "WAITING"
      ? `
        <div style="display:flex; gap:8px; margin-top:4px;">
          <button
            onclick="mejaSiap('${item.id}')"
            style="flex:1; padding:10px 12px; background:#16a34a; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer;"
          >
            PROSES MEJA
          </button>
          <button
            onclick="batalkanBooking('${item.id}')"
            style="padding:10px 14px; background:#ef4444; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer;"
          >
            BATAL
          </button>
        </div>
      `
      : "";

    return `
      <div class="wl-card">
        <div class="wl-card-header">
          <div>
            <div class="wl-customer-name">
              ${escapeHtml(item.namaCustomer || "-")}
            </div>
            <div class="wl-customer-wa">
              ${escapeHtml(item.noWa || "Nomor WA tidak tersedia")}
            </div>
          </div>

          <span class="wl-status-badge ${statusClass}">
            ${escapeHtml(status)}
          </span>
        </div>

        <div class="wl-card-info-grid">
          <div class="wl-info-box">
            <span class="wl-info-label">Tanggal</span>
            <span class="wl-info-value">${escapeHtml(item.tanggalBooking || "-")}</span>
          </div>

          <div class="wl-info-box">
            <span class="wl-info-label">Jam Booking</span>
            <span class="wl-info-value">${escapeHtml(item.jamBooking || "-")}</span>
          </div>
        </div>

        <div class="wl-meja-box">
          ${escapeHtml(nomorMejaText)}
        </div>

        <div class="wl-pesanan-section">
          <div class="wl-pesanan-title">Pre-Order</div>
          ${pesananHtml}
        </div>

        ${actionHtml}
      </div>
    `;
  }).join("");
}


