/* ==================================================
   POPUP PENGINGAT CEK HARGA MEJA
   --------------------------------------------------
   Fungsi file ini HANYA untuk:
   1. Menampilkan popup pengingat Cek Harga.
   2. CSS popup.
   3. Tombol TUTUP.
   4. Tombol CEK HARGA yang memanggil fungsi cekHargaMeja()
      yang SUDAH ADA di index.html.
   5. Popup hanya muncul 1x untuk setiap sessionId.

   Tidak ada logika perhitungan harga di file ini.
================================================== */

(function () {
  "use strict";

  const POPUP_ID = "popupCekHargaMeja";
  const STYLE_ID = "popupCekHargaMejaStyle";

  // Menyimpan sessionId yang popup-nya sudah pernah ditampilkan.
  // Satu sessionId = maksimal satu popup dalam satu halaman aplikasi.
  const popupShownSessions = new Set();

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${POPUP_ID} {
        position: fixed;
        inset: 0;
        z-index: 1000010;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
        background: rgba(15, 23, 42, 0.48);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
      }

      #${POPUP_ID}.show {
        display: flex;
      }

      #${POPUP_ID} .cek-harga-popup-card {
        width: min(380px, calc(100vw - 32px));
        box-sizing: border-box;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 20px 60px rgba(15, 23, 42, 0.24);
        animation: cekHargaPopupIn 0.18s ease-out;
      }

      @keyframes cekHargaPopupIn {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.98);
        }

        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      #${POPUP_ID} .cek-harga-popup-title {
        margin: 0;
        color: #111827;
        font-size: 1.08rem;
        line-height: 1.25;
        font-weight: 800;
        text-align: center;
      }

      #${POPUP_ID} .cek-harga-popup-meja {
        margin: 7px 0 0;
        color: #2563eb;
        font-size: 0.92rem;
        font-weight: 800;
        text-align: center;
      }

      #${POPUP_ID} .cek-harga-popup-text {
        margin: 12px 0 0;
        color: #4b5563;
        font-size: 0.86rem;
        line-height: 1.5;
        text-align: center;
      }

      #${POPUP_ID} .cek-harga-popup-actions {
        display: flex;
        gap: 8px;
        margin-top: 18px;
      }

      #${POPUP_ID} .cek-harga-popup-btn {
        flex: 1 1 0;
        min-height: 42px;
        border: 1px solid transparent;
        border-radius: 9px;
        padding: 9px 12px;
        font-size: 0.86rem;
        font-weight: 800;
        cursor: pointer;
        box-sizing: border-box;
      }

      #${POPUP_ID} .cek-harga-popup-btn.tutup {
        background: #f3f4f6;
        border-color: #d1d5db;
        color: #374151;
      }

      #${POPUP_ID} .cek-harga-popup-btn.tutup:hover {
        background: #e5e7eb;
      }

      #${POPUP_ID} .cek-harga-popup-btn.cek {
        background: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
      }

      #${POPUP_ID} .cek-harga-popup-btn.cek:hover {
        background: #1d4ed8;
        border-color: #1d4ed8;
      }

      @media (max-width: 520px) {
        #${POPUP_ID} {
          padding: 14px;
        }

        #${POPUP_ID} .cek-harga-popup-card {
          width: min(380px, calc(100vw - 28px));
          padding: 18px;
        }

        #${POPUP_ID} .cek-harga-popup-actions {
          gap: 7px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function ensurePopupElement() {
    let popup = document.getElementById(POPUP_ID);

    if (popup) {
      return popup;
    }

    popup = document.createElement("div");
    popup.id = POPUP_ID;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    popup.setAttribute("aria-labelledby", "cekHargaPopupTitle");

    popup.innerHTML = `
      <div class="cek-harga-popup-card" role="document">

        <h3
          id="cekHargaPopupTitle"
          class="cek-harga-popup-title"
        >
          PENGINGAT CEK HARGA
        </h3>

        <div
          id="cekHargaPopupMeja"
          class="cek-harga-popup-meja"
        >
          MEJA -
        </div>

        <p class="cek-harga-popup-text">
          Pastikan harga meja sudah dicek sebelum transaksi dilanjutkan.
        </p>

        <div class="cek-harga-popup-actions">

          <button
            id="cekHargaPopupTutupBtn"
            class="cek-harga-popup-btn tutup"
            type="button"
          >
            TUTUP
          </button>

          <button
            id="cekHargaPopupCekBtn"
            class="cek-harga-popup-btn cek"
            type="button"
          >
            CEK HARGA
          </button>

        </div>

      </div>
    `;

    // Klik area gelap di luar card hanya menutup popup.
    popup.addEventListener("click", function (event) {
      if (event.target === popup) {
        closePopup();
      }
    });

    const closeButton = popup.querySelector("#cekHargaPopupTutupBtn");

    if (closeButton) {
      closeButton.addEventListener("click", closePopup);
    }

    const cekButton = popup.querySelector("#cekHargaPopupCekBtn");

    if (cekButton) {
      cekButton.addEventListener("click", function () {

        closePopup();

        // Gunakan fungsi Cek Harga yang sudah ada.
        // Tidak membuat logika harga baru.
        if (typeof window.cekHargaMeja === "function") {
          window.cekHargaMeja();
        } else {
          console.error(
            "Fungsi cekHargaMeja() belum tersedia."
          );
        }

      });
    }

    document.body.appendChild(popup);

    return popup;
  }

  function closePopup() {
    const popup = document.getElementById(POPUP_ID);

    if (!popup) {
      return;
    }

    popup.classList.remove("show");
  }

  function showPopup(sessionId, nomorMeja) {
    const normalizedSessionId = String(sessionId || "").trim();

    if (!normalizedSessionId) {
      return false;
    }

    // Popup hanya boleh muncul satu kali
    // untuk sessionId yang sama.
    if (popupShownSessions.has(normalizedSessionId)) {
      return false;
    }

    popupShownSessions.add(normalizedSessionId);

    ensureStyle();

    const popup = ensurePopupElement();

    const mejaElement = popup.querySelector(
      "#cekHargaPopupMeja"
    );

    if (mejaElement) {
      const nomor = Number(nomorMeja);

      mejaElement.textContent =
        Number.isFinite(nomor) && nomor > 0
          ? `MEJA ${nomor < 10 ? "0" + nomor : nomor}`
          : "MEJA -";
    }

    popup.classList.add("show");

    return true;
  }

  function resetSession(sessionId) {
    const normalizedSessionId =
      String(sessionId || "").trim();

    if (!normalizedSessionId) {
      return;
    }

    popupShownSessions.delete(
      normalizedSessionId
    );
  }

  function close() {
    closePopup();
  }

  window.PBMSCekHargaPopup = {
    show: showPopup,
    close: close,
    resetSession: resetSession
  };

})();