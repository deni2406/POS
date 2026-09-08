/**
 * Priority Bubble Module - PollardBilliard Management System (PBMS)
 * File: C:\POS\meja-bubble.js
 * 
 * Fitur Priority Bubble untuk menampilkan ranking sisa waktu meja aktif
 * pada popup PILIH MEJA secara otomatis dan handal.
 */

(function () {
  'use strict';

  let isRendering = false;
  let debounceTimer = null;

  // Inject CSS style khusus priority bubble ke <head>
  function injectStyles() {
    if (document.getElementById('meja-bubble-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'meja-bubble-styles';
    styleEl.textContent = `
      /* Override position & overflow pada kartu meja agar bubble di pojok kanan atas tidak terpotong */
      #pilihMejaPopup .popup-table-btn,
      #pilihMejaPopup button.popup-table-btn,
      #pilihMejaPopup div.popup-table-btn {
        position: relative !important;
        overflow: visible !important;
      }

      /* Styling Priority Bubble di pojok kanan atas kartu meja */
      .meja-priority-bubble {
        position: absolute !important;
        top: -8px !important;
        right: -8px !important;
        width: 26px !important;
        height: 26px !important;
        border-radius: 50% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 0.75rem !important;
        font-weight: 900 !important;
        color: #ffffff !important;
        border: 2px solid #ffffff !important;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35) !important;
        z-index: 99 !important;
        pointer-events: none !important;
        line-height: 1 !important;
        box-sizing: border-box !important;
      }

      /* Warna bubble berdasarkan sisa waktu bermain */
      .meja-priority-bubble.bubble-hijau {
        background-color: #16a34a !important; /* Sisa waktu > 30 menit */
      }

      .meja-priority-bubble.bubble-kuning {
        background-color: #d97706 !important; /* Sisa waktu 15 - 30 menit */
      }

      .meja-priority-bubble.bubble-merah {
        background-color: #dc2626 !important; /* Sisa waktu < 15 menit */
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Membaca data mejaSessions dari parameter atau scope global
  function getGlobalSessions() {
    if (typeof window.mejaSessions !== 'undefined' && window.mejaSessions) {
      return window.mejaSessions;
    }
    try {
      if (typeof mejaSessions !== 'undefined' && mejaSessions) {
        return mejaSessions;
      }
    } catch (e) {}
    return null;
  }

  // Parser waktuSelesai yang fleksibel & konsisten dengan sistem MejaTimer
  function parseWaktuSelesai(waktuSelesai) {
    if (!waktuSelesai) return null;
    if (waktuSelesai instanceof Date) {
      return isNaN(waktuSelesai.getTime()) ? null : waktuSelesai;
    }

    if (window.MejaTimer && typeof window.MejaTimer.parseDate === 'function') {
      const parsed = window.MejaTimer.parseDate(waktuSelesai);
      if (parsed && parsed instanceof Date && !isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    let d = new Date(waktuSelesai);
    if (!isNaN(d.getTime())) return d;

    if (typeof waktuSelesai === 'string') {
      d = new Date(waktuSelesai.replace(' ', 'T'));
      if (!isNaN(d.getTime())) return d;
    }

    return null;
  }

  // Membaca nomor meja dari atribut onclick="klikMejaPopup(X)"
  function getTableNumberFromCard(cardEl) {
    if (!cardEl) return null;
    const onclickAttr = cardEl.getAttribute('onclick') || '';
    const match = onclickAttr.match(/klikMejaPopup\(\s*(\d+)\s*\)/);
    if (match && match[1]) {
      return Number(match[1]);
    }
    return null;
  }

  // Logika internal render bubble ke DOM
  function renderBubblesInternal(sessionsData) {
    if (isRendering) return;
    isRendering = true;

    try {
      injectStyles();

      const now = new Date();
      const activeTables = [];

      // Normalisasi & kumpulkan data sesi meja AKTIF (non-LOSS)
      if (sessionsData && typeof sessionsData === 'object') {
        Object.keys(sessionsData).forEach(function (key) {
          const rawSession = sessionsData[key];
          if (!rawSession) return;

          const session = (window.MejaTimer && typeof window.MejaTimer.normalisasiSesiMeja === 'function')
            ? window.MejaTimer.normalisasiSesiMeja(rawSession)
            : rawSession;

          if (!session) return;

          const status = String(session.status || '').toUpperCase();
          const jenisSesi = String(session.jenisSesi || session.jenis_sesi || '').toUpperCase();

          // Hanya meja AKTIF, non-LOSS, dan memiliki waktuSelesai
          if (status === 'AKTIF' && jenisSesi !== 'LOSS' && session.waktuSelesai) {
            const endDate = parseWaktuSelesai(session.waktuSelesai);
            if (endDate) {
              const diffMs = endDate.getTime() - now.getTime();
              const sisaMenit = diffMs / (1000 * 60);

              const nomor = Number(session.nomorMeja || session.nomor_meja || key);
              if (nomor && !isNaN(nomor)) {
                activeTables.push({
                  nomorMeja: nomor,
                  sisaMenit: sisaMenit
                });
              }
            }
          }
        });
      }

      // Urutkan meja berdasarkan sisa waktu paling cepat selesai (sisaMenit terkecil)
      activeTables.sort(function (a, b) {
        return a.sisaMenit - b.sisaMenit;
      });

      // Petakan ranking (1, 2, 3...) dan warna bubble berdasarkan sisa menit
      const bubbleMap = {};
      activeTables.forEach(function (item, index) {
        const rank = index + 1;
        let colorClass = 'bubble-hijau';

        if (item.sisaMenit < 15) {
          colorClass = 'bubble-merah';
        } else if (item.sisaMenit <= 30) {
          colorClass = 'bubble-kuning';
        } else {
          colorClass = 'bubble-hijau';
        }

        bubbleMap[item.nomorMeja] = {
          rank: rank,
          colorClass: colorClass
        };
      });

      // Cari semua elemen kartu di DOM dan pasang/hapus bubble
      const cards = document.querySelectorAll('#pilihMejaPopup .popup-table-btn');
      cards.forEach(function (cardEl) {
        const tableNo = getTableNumberFromCard(cardEl);
        if (!tableNo) return;

        let bubbleEl = cardEl.querySelector('.meja-priority-bubble');

        if (bubbleMap[tableNo]) {
          const info = bubbleMap[tableNo];
          if (!bubbleEl) {
            bubbleEl = document.createElement('div');
            cardEl.appendChild(bubbleEl);
          }
          bubbleEl.className = 'meja-priority-bubble ' + info.colorClass;
          bubbleEl.textContent = info.rank;
        } else {
          if (bubbleEl) {
            bubbleEl.remove();
          }
        }
      });

    } finally {
      setTimeout(function () {
        isRendering = false;
      }, 30);
    }
  }

  // Fungsi update publik: jika dipanggil langsung dengan data, langsung jalankan render
  function update(explicitSessions) {
    const sessions = explicitSessions || getGlobalSessions();
    if (sessions) {
      renderBubblesInternal(sessions);
    }
  }

  // Penjadwalan otomatis dengan debounce (80ms)
  function scheduleAutoUpdate() {
    if (isRendering) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      autoUpdate();
    }, 80);
  }

  // Auto update yang memverifikasi kesiapan DOM & data
  function autoUpdate() {
    const popup = document.getElementById('pilihMejaPopup');
    if (!popup) return;

    const isVisible = popup.classList.contains('show') || popup.offsetWidth > 0 || popup.offsetHeight > 0;
    if (!isVisible) return;

    const cards = popup.querySelectorAll('.popup-table-btn');
    if (!cards || cards.length === 0) return;

    const sessions = getGlobalSessions();
    if (!sessions) return;

    renderBubblesInternal(sessions);
  }

  // Observer untuk memantau perubahan DOM pada document.body
  function setupMutationObserver() {
    if (typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(function (mutations) {
      if (isRendering) return;

      let shouldUpdate = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];

        // Abaikan mutasi pada elemen bubble itu sendiri
        if (m.target && m.target.classList && m.target.classList.contains('meja-priority-bubble')) {
          continue;
        }

        if (m.type === 'childList' || (m.type === 'attributes' && m.attributeName === 'class')) {
          shouldUpdate = true;
          break;
        }
      }

      if (shouldUpdate) {
        scheduleAutoUpdate();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  // Export module ke window
  window.MejaBubble = {
    update: update,
    injectStyles: injectStyles
  };

  // Inisialisasi observer saat dokumen siap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMutationObserver);
  } else {
    setupMutationObserver();
  }
})();