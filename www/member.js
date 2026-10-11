/**
 * member(2).js
 * Modul khusus mandiri untuk menangani UI modal Member POS PollarBilliard.
 */

(function () {
  console.log("DEBUG LOAD MemberModal");

  let memberList = [];
  let selectedMember = null;
  let modalElement = null;
  let formModalElement = null;
  let kategoriListCache = [];

  // PLATINUM sengaja TIDAK termasuk — kategori eksklusif yang hanya
  // bisa diberikan internal (bukan opsi bebas di form pendaftaran).
  const MEMBER_KATEGORI_DEFAULT = [
    {
      id: "UMUM",
      nama: "UMUM",
      aktif: 1
    },
    {
      id: "PELAJAR",
      nama: "PELAJAR",
      aktif: 1
    }
  ];

  // PLATINUM disaring dari hasil fetch API kategori (Fix #26):
  // kategori eksklusif tetap ada di DB (member_kategori) untuk
  // kebutuhan internal, tapi tidak boleh tampil di dropdown
  // pendaftaran member baru.
  const filterKategoriPendaftaran = (list) =>
    (Array.isArray(list) ? list : []).filter(k =>
      String(k.nama || k.id || "").toUpperCase() !== "PLATINUM"
    );

  function getSessionId() {
    return sessionStorage.getItem("pbms_session_id") || 
           sessionStorage.getItem("sessionId") || 
           localStorage.getItem("sessionId") || 
           window.sessionId || "";
  }

  function getDeviceId() {
    return localStorage.getItem("pbms_device_id") || 
           localStorage.getItem("deviceId") || 
           sessionStorage.getItem("deviceId") || 
           window.deviceId || "";
  }

  async function loadMembers() {
    const container = document.getElementById('memberList');
    if (container) {
      container.innerHTML = `<div class="member-empty">Memuat data member...</div>`;
    }

    try {
      const sessionId = getSessionId();
      const deviceId = getDeviceId();
      console.log("[MEMBER] session:", sessionId ? "ADA" : "KOSONG");
      console.log("[MEMBER] device:", deviceId ? "ADA" : "KOSONG");

      if (!sessionId || !deviceId) {
        console.error("[MEMBER] Session atau DeviceId kosong saat memuat member");
        if (container) {
          container.innerHTML = `<div class="member-empty">Session login tidak ditemukan. Silakan login ulang.</div>`;
        }
        return;
      }

      const response = await fetch("/api/member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
          "X-Device-Id": deviceId
        },
        body: JSON.stringify({ action: "list" })
      });
      const result = await response.json();

      if (result.success === true) {
        memberList = Array.isArray(result.data)
          ? result.data
          : [];
        renderMemberList();
      } else {
        memberList = [];
        if (container) {
          container.innerHTML = `<div class="member-empty">Gagal memuat data member.</div>`;
        }
      }
    } catch (error) {
      console.error("Gagal memuat data member:", error);
      memberList = [];
      if (container) {
        container.innerHTML = `<div class="member-empty">Gagal memuat data member.</div>`;
      }
    }
  }

  async function loadKategori() {
    try {
      const sessionId = getSessionId();
      const deviceId = getDeviceId();
      console.log("[MEMBER] session:", sessionId ? "ADA" : "KOSONG");
      console.log("[MEMBER] device:", deviceId ? "ADA" : "KOSONG");

      if (!sessionId || !deviceId) {
        console.error("[MEMBER] Session atau DeviceId kosong saat memuat kategori");
        kategoriListCache = filterKategoriPendaftaran(MEMBER_KATEGORI_DEFAULT);
        return;
      }

      const response = await fetch("/api/member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
          "X-Device-Id": deviceId
        },
        body: JSON.stringify({ action: "kategori_list" })
      });
      const result = await response.json();

      console.log("[MEMBER] kategori request status:", response.status);
      console.log("[MEMBER] kategori response success:", result?.success);
      console.log("[MEMBER] jumlah kategori:", Array.isArray(result?.data) ? result.data.length : 0);

      if (result.success === true && Array.isArray(result.data) && result.data.length > 0) {
        // Filter PLATINUM dari hasil API (Fix #26) — kategoriListCache
        // hanya dipakai dropdown pendaftaran, bukan untuk kategori
        // member yang sudah terdaftar (daftar detail tetap dari
        // memberListCache / fetch terpisah).
        kategoriListCache = filterKategoriPendaftaran(result.data);
      } else {
        kategoriListCache = filterKategoriPendaftaran(MEMBER_KATEGORI_DEFAULT);
      }
    } catch (error) {
      console.error("Gagal memuat kategori member:", error);
      kategoriListCache = filterKategoriPendaftaran(MEMBER_KATEGORI_DEFAULT);
    }
  }

  function hitungUmurLokal(tanggalLahir) {
    if (!tanggalLahir) return 0;
    const lahir = new Date(tanggalLahir);
    const sekarang = new Date();
    let umur = sekarang.getFullYear() - lahir.getFullYear();
    const m = sekarang.getMonth() - lahir.getMonth();
    if (m < 0 || (m === 0 && sekarang.getDate() < lahir.getDate())) {
      umur--;
    }
    return umur;
  }

  function initFormModal() {
    if (document.getElementById('memberFormModal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'memberFormModal';
    overlay.className = 'member-modal-overlay';

    overlay.innerHTML = `
      <div class="member-modal-card" style="max-height: 90vh;">
        <div class="member-modal-header">
          <h3 class="member-modal-title">TAMBAH MEMBER</h3>
          <button class="member-modal-close" onclick="tutupFormTambahMember()">&times;</button>
        </div>

        <div style="flex: 1; overflow-y: auto; padding-right: 4px;">
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Kategori Member</label>
            <select id="memberKategoriSelect" class="member-modal-search" style="margin-bottom: 0;">
              <!-- Dirender dinamis -->
            </select>
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Nama</label>
            <input id="memberNama" class="member-modal-search" type="text" placeholder="Nama lengkap" style="margin-bottom: 0;" autocomplete="off">
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Alamat</label>
            <input id="memberAlamat" class="member-modal-search" type="text" placeholder="Alamat lengkap" style="margin-bottom: 0;" autocomplete="off">
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Nomor HP</label>
            <input id="memberNomorHp" class="member-modal-search" type="text" placeholder="08xxxxxxxxxx" style="margin-bottom: 0;" autocomplete="off">
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Tanggal Lahir</label>
            <input id="memberTanggalLahir" class="member-modal-search" type="date" style="margin-bottom: 0;">
            <div id="memberUmurInfo" style="font-size: 0.85rem; color: #4b5563; margin-top: 4px; font-weight: 600;"></div>
          </div>

          <div id="wrapperPelajarFields" style="display: none;">
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">Nama Sekolah</label>
              <input id="memberNamaSekolah" class="member-modal-search" type="text" placeholder="Nama sekolah" style="margin-bottom: 0;" autocomplete="off">
            </div>

            <div style="margin-bottom: 12px;">
              <label style="display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #374151;">NISN</label>
              <input id="memberNisn" class="member-modal-search" type="text" placeholder="10 digit angka" maxlength="10" style="margin-bottom: 0;" autocomplete="off">
            </div>
          </div>
        </div>

        <div class="member-modal-footer" style="margin-top: 16px;">
          <button class="member-btn-batal" onclick="tutupFormTambahMember()">BATAL</button>
          <button id="memberBtnSimpan" class="member-btn-pilih" onclick="submitTambahMember()">SIMPAN MEMBER</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    formModalElement = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        tutupFormTambahMember();
      }
    });

    const tglLahirInput = document.getElementById('memberTanggalLahir');
    if (tglLahirInput) {
      tglLahirInput.addEventListener('change', function() {
        const val = this.value;
        const info = document.getElementById('memberUmurInfo');
        if (!val) {
          if (info) info.innerText = '';
          return;
        }
        const umur = hitungUmurLokal(val);
        if (info) {
          info.innerText = `Umur: ${umur} tahun`;
        }
      });
    }

    const nisnInput = document.getElementById('memberNisn');
    if (nisnInput) {
      nisnInput.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, "").slice(0, 10);
      });
    }

    const katSelect = document.getElementById('memberKategoriSelect');
    if (katSelect) {
      katSelect.addEventListener('change', function() {
        togglePelajarFields();
      });
    }
  }

  function togglePelajarFields() {
    const katSelect = document.getElementById('memberKategoriSelect');
    const wrapper = document.getElementById('wrapperPelajarFields');
    if (!katSelect || !wrapper) return;

    const selectedOption = katSelect.options[katSelect.selectedIndex];
    const namaKat = selectedOption ? selectedOption.text.toUpperCase() : "";

    if (namaKat === "PELAJAR") {
      wrapper.style.display = "block";
    } else {
      wrapper.style.display = "none";
    }
  }

  window.bukaFormTambahMember = async function() {
    initFormModal();

    kategoriListCache = filterKategoriPendaftaran(MEMBER_KATEGORI_DEFAULT);
    const katSelect = document.getElementById('memberKategoriSelect');
    if (katSelect) {
      // Filter PLATINUM sebelum .map() (Fix #26) — kategoriListCache
      // sudah difilter, tetap di-filter lagi sebagai double-guard.
      katSelect.innerHTML = filterKategoriPendaftaran(kategoriListCache).map(k => `
        <option value="${k.id}">${escapeHtml(k.nama)}</option>
      `).join("");
    }

    await loadKategori();
    if (katSelect && kategoriListCache.length > 0) {
      katSelect.innerHTML = filterKategoriPendaftaran(kategoriListCache).map(k => `
        <option value="${k.id}">${escapeHtml(k.nama)}</option>
      `).join("");
    }

    // Reset form
    document.getElementById('memberNama').value = '';
    document.getElementById('memberAlamat').value = '';
    document.getElementById('memberNomorHp').value = '';
    document.getElementById('memberTanggalLahir').value = '';
    document.getElementById('memberUmurInfo').innerText = '';
    document.getElementById('memberNamaSekolah').value = '';
    document.getElementById('memberNisn').value = '';
    if (katSelect && katSelect.options.length > 0) {
      katSelect.selectedIndex = 0;
    }

    togglePelajarFields();

    if (formModalElement) {
      formModalElement.classList.add('show');
    }
  };

  window.tutupFormTambahMember = function() {
    if (formModalElement) {
      formModalElement.classList.remove('show');
    }
  };

  window.submitTambahMember = async function() {
    const katSelect = document.getElementById('memberKategoriSelect');
    const kategoriId = katSelect ? katSelect.value : null;
    const selectedOption = katSelect ? katSelect.options[katSelect.selectedIndex] : null;
    const namaKategori = selectedOption ? selectedOption.text.toUpperCase() : "";

    const nama = document.getElementById('memberNama').value.trim();
    const alamat = document.getElementById('memberAlamat').value.trim();
    const nomorHp = document.getElementById('memberNomorHp').value.trim();
    const tanggalLahir = document.getElementById('memberTanggalLahir').value.trim();
    const namaSekolah = document.getElementById('memberNamaSekolah').value.trim();
    const nisn = document.getElementById('memberNisn').value.trim();

    if (!kategoriId || !nama || !alamat || !nomorHp || !tanggalLahir) {
      alert("Semua field wajib diisi.");
      return;
    }

    const umur = hitungUmurLokal(tanggalLahir);

    if (namaKategori === "PELAJAR") {
      if (!namaSekolah) {
        alert("Nama sekolah wajib diisi untuk kategori Pelajar.");
        return;
      }
      if (!nisn || !/^\d{10}$/.test(nisn)) {
        alert("NISN harus 10 digit angka.");
        return;
      }
      if (umur >= 19) {
        alert("Member Pelajar maksimal berusia 18 tahun.");
        return;
      }
    }

    const payload = {
      action: "create",
      kategoriId,
      nama,
      alamat,
      nomorHp,
      tanggalLahir,
      ...(namaKategori === "PELAJAR" ? { namaSekolah, nisn } : {})
    };

    const btnSimpan = document.getElementById('memberBtnSimpan');
    if (btnSimpan) {
      btnSimpan.innerText = "MENYIMPAN...";
      btnSimpan.setAttribute('disabled', 'true');
    }

    const sessionId = getSessionId();
    const deviceId = getDeviceId();

    console.log("[MEMBER] session:", sessionId ? "ADA" : "KOSONG");
    console.log("[MEMBER] device:", deviceId ? "ADA" : "KOSONG");

    if (!sessionId || !deviceId) {
      console.error("[MEMBER] Session atau DeviceId kosong");
      alert("Session login tidak ditemukan. Silakan login ulang.");
      if (btnSimpan) {
        btnSimpan.innerText = "SIMPAN MEMBER";
        btnSimpan.removeAttribute('disabled');
      }
      return;
    }

    try {
      const response = await fetch("/api/member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
          "X-Device-Id": deviceId
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (btnSimpan) {
        btnSimpan.innerText = "SIMPAN MEMBER";
        btnSimpan.removeAttribute('disabled');
      }

      if (result.success === true) {
        alert("Member berhasil didaftarkan.");
        tutupFormTambahMember();
        selectedMember = null;
        await loadMembers();
      } else {
        alert(result.message || "Gagal mendaftarkan member.");
      }
    } catch (error) {
      if (btnSimpan) {
        btnSimpan.innerText = "SIMPAN MEMBER";
        btnSimpan.removeAttribute('disabled');
      }
      console.error("Error submit member:", error);
      alert("Terjadi kesalahan jaringan atau server.");
    }
  };

  function initModal() {
    if (document.getElementById('memberModal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'memberModal';
    overlay.className = 'member-modal-overlay';

    overlay.innerHTML = `
      <style>
        .member-modal-overlay {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          background: rgba(15, 23, 42, 0.68);
          backdrop-filter: blur(3px);
          -webkit-backdrop-filter: blur(3px);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 3300;
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.2s ease, visibility 0.2s ease;
          padding: 16px;
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        .member-modal-overlay.show {
          opacity: 1;
          visibility: visible;
        }

        .member-modal-card {
          background: #ffffff;
          width: 100%;
          max-width: 620px;
          max-height: min(720px, 92vh);
          border-radius: 18px;
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
          padding: 20px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          transform: translateY(8px) scale(0.985);
          transition: transform 0.2s ease;
          overflow: hidden;
        }

        .member-modal-overlay.show .member-modal-card {
          transform: translateY(0) scale(1);
        }

        .member-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding-bottom: 14px;
          border-bottom: 1px solid #e5e7eb;
          flex-shrink: 0;
        }

        .member-modal-title-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .member-modal-title-icon {
          width: 36px;
          height: 36px;
          flex: 0 0 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: #0f172a;
          box-shadow: 0 4px 10px rgba(15, 23, 42, 0.18);
        }

        .member-modal-title-text {
          min-width: 0;
        }

        .member-modal-title {
          font-size: 1.3rem;
          font-weight: 900;
          color: #0f172a;
          margin: 0;
          letter-spacing: 0.2px;
          line-height: 1.15;
        }

        .member-modal-subtitle {
          margin: 3px 0 0;
          font-size: 0.82rem;
          color: #64748b;
          line-height: 1.25;
        }

        .member-modal-close {
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          font-size: 24px;
          line-height: 1;
          cursor: pointer;
          color: #64748b;
          flex: 0 0 36px;
        }

        .member-modal-close:hover {
          color: #0f172a;
          background: #f1f5f9;
          border-color: #cbd5e1;
        }

        .member-search-wrap {
          position: relative;
          margin-top: 14px;
          flex-shrink: 0;
        }

        .member-search-icon {
          position: absolute;
          left: 14px;
          top: 50%;
          transform: translateY(-50%);
          color: #64748b;
          pointer-events: none;
        }

        .member-modal-search {
          width: 100%;
          height: 52px;
          padding: 0 42px 0 44px;
          font-size: 1rem;
          border: 1px solid #cbd5e1;
          border-radius: 12px;
          outline: none;
          box-sizing: border-box;
          background: #ffffff;
          color: #0f172a;
          margin: 0;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }

        .member-modal-search:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
        }

        .member-search-clear {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          width: 30px;
          height: 30px;
          display: none;
          align-items: center;
          justify-content: center;
          border: 0;
          background: transparent;
          color: #64748b;
          font-size: 20px;
          cursor: pointer;
          border-radius: 8px;
        }

        .member-search-clear:hover {
          background: #f1f5f9;
          color: #0f172a;
        }

        .member-top-action {
          margin-top: 10px;
          flex-shrink: 0;
        }

        .member-add-btn {
          width: 100%;
          min-height: 44px;
          padding: 10px 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: 0.9rem;
          font-weight: 800;
          border: 1px dashed #94a3b8;
          border-radius: 11px;
          background: #f8fafc;
          color: #334155;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }

        .member-add-btn:hover {
          background: #f1f5f9;
          border-color: #64748b;
          color: #0f172a;
        }

        .member-results-head {
          display: none;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 14px;
          margin-bottom: 8px;
          flex-shrink: 0;
        }

        .member-results-count {
          font-size: 0.78rem;
          font-weight: 800;
          color: #64748b;
          letter-spacing: 0.3px;
          text-transform: uppercase;
        }

        .member-results-hint {
          font-size: 0.75rem;
          color: #94a3b8;
        }

        .member-list-container {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          margin-top: 10px;
          padding-right: 3px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .member-list-container::-webkit-scrollbar {
          width: 5px;
        }

        .member-list-container::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 999px;
        }

        .member-search-placeholder,
        .member-empty {
          min-height: 170px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          border: 1px dashed #cbd5e1;
          border-radius: 14px;
          background: #f8fafc;
          color: #64748b;
          padding: 24px;
          box-sizing: border-box;
          line-height: 1.45;
        }

        .member-search-placeholder strong,
        .member-empty strong {
          color: #334155;
          font-size: 0.95rem;
          margin-top: 8px;
        }

        .member-search-placeholder span,
        .member-empty span {
          font-size: 0.8rem;
          margin-top: 3px;
          color: #94a3b8;
        }

        .member-item-row {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          min-height: 76px;
          padding: 11px 12px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 13px;
          cursor: pointer;
          box-sizing: border-box;
          transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease, background 0.15s ease;
        }

        .member-item-row:hover {
          border-color: #93c5fd;
          background: #f8fbff;
          box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
          transform: translateY(-1px);
        }

        .member-item-row.selected {
          border-color: #2563eb;
          background: #eff6ff;
          box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.10);
        }

        .member-avatar {
          width: 42px;
          height: 42px;
          flex: 0 0 42px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid currentColor;
        }

        .member-main-info {
          min-width: 0;
          flex: 1;
        }

        .member-name {
          font-weight: 900;
          font-size: 0.98rem;
          color: #0f172a;
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.2;
        }

        .member-meta {
          margin-top: 5px;
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
          color: #64748b;
          font-size: 0.76rem;
          line-height: 1.25;
        }

        .member-meta-separator {
          color: #cbd5e1;
        }

        .member-status {
          font-size: 0.7rem;
          font-weight: 800;
          padding: 2px 7px;
          border-radius: 999px;
          background: #f1f5f9;
          color: #64748b;
          white-space: nowrap;
        }

        .member-category-badge {
          flex: 0 0 auto;
          font-size: 0.7rem;
          font-weight: 900;
          padding: 5px 8px;
          border-radius: 999px;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          border: 1px solid currentColor;
          background: #ffffff;
        }

        .member-row-arrow {
          flex: 0 0 auto;
          color: #94a3b8;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .member-modal-footer {
          display: flex;
          gap: 10px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e5e7eb;
          flex-shrink: 0;
        }

        .member-btn-batal,
        .member-btn-pilih {
          flex: 1;
          min-height: 46px;
          padding: 11px 14px;
          border-radius: 11px;
          font-size: 0.9rem;
          font-weight: 900;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        }

        .member-btn-batal {
          background: #f8fafc;
          color: #334155;
          border: 1px solid #cbd5e1;
        }

        .member-btn-batal:hover {
          background: #f1f5f9;
        }

        .member-btn-pilih {
          background: #2563eb;
          color: #ffffff;
          border: 1px solid #2563eb;
        }

        .member-btn-pilih:hover {
          background: #1d4ed8;
          border-color: #1d4ed8;
        }

        .member-btn-pilih:disabled {
          background: #cbd5e1;
          border-color: #cbd5e1;
          cursor: not-allowed;
        }

        @media (max-width: 700px) {
          .member-modal-overlay {
            padding: 10px;
          }

          .member-modal-card {
            max-width: 100%;
            max-height: 94vh;
            padding: 15px;
            border-radius: 16px;
          }

          .member-modal-title {
            font-size: 1.15rem;
          }

          .member-modal-subtitle {
            font-size: 0.76rem;
          }

          .member-item-row {
            min-height: 70px;
            padding: 10px;
            gap: 10px;
          }

          .member-avatar {
            width: 38px;
            height: 38px;
            flex-basis: 38px;
          }

          .member-category-badge {
            font-size: 0.65rem;
            padding: 4px 7px;
          }
        }
      </style>

      <div class="member-modal-card">
        <div class="member-modal-header">
          <div class="member-modal-title-wrap">
            <div class="member-modal-title-icon" aria-hidden="true">
              <svg width="23" height="23" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="46" fill="#f59e0b" stroke="#ffffff" stroke-width="4"></circle>
                <path d="M 9 31 A 46 46 0 0 1 91 31 Z" fill="#ffffff"></path>
                <path d="M 9 69 A 46 46 0 0 0 91 69 Z" fill="#ffffff"></path>
                <circle cx="50" cy="50" r="21" fill="#ffffff" stroke="#0f172a" stroke-width="3"></circle>
                <text x="50" y="58" font-size="27" font-weight="900" fill="#0f172a" text-anchor="middle" font-family="Arial, sans-serif">9</text>
              </svg>
            </div>
            <div class="member-modal-title-text">
              <h3 class="member-modal-title">MEMBER</h3>
              <p class="member-modal-subtitle">Cari member untuk transaksi billiard</p>
            </div>
          </div>
          <button class="member-modal-close" onclick="MemberModal.tutup()" aria-label="Tutup">&times;</button>
        </div>

        <div class="member-search-wrap">
          <svg class="member-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            id="memberSearch"
            class="member-modal-search"
            type="text"
            placeholder="Cari nama atau nomor HP"
            autocomplete="off"
          >
          <button id="memberSearchClear" class="member-search-clear" type="button" onclick="MemberModal.clearSearch()" aria-label="Hapus pencarian">&times;</button>
        </div>

        <div class="member-top-action">
          <button class="member-add-btn" onclick="bukaFormTambahMember()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            TAMBAH MEMBER
          </button>
        </div>

        <div id="memberResultsHead" class="member-results-head">
          <span id="memberResultsCount" class="member-results-count"></span>
          <span class="member-results-hint">Pilih salah satu member</span>
        </div>

        <div id="memberList" class="member-list-container">
          <div class="member-search-placeholder">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <line x1="16.5" y1="16.5" x2="21" y2="21"></line>
            </svg>
            <strong>Ketik nama atau nomor HP</strong>
            <span>Daftar member akan muncul setelah pencarian</span>
          </div>
        </div>

        <div class="member-modal-footer">
          <button class="member-btn-batal" onclick="MemberModal.tutup()">BATAL</button>
          <button id="memberBtnPilih" class="member-btn-pilih" onclick="handlePilihMemberClick()">PILIH MEMBER</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    modalElement = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        tutup();
      }
    });

    const searchInput = document.getElementById('memberSearch');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        renderMemberList();
      });

      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          MemberModal.clearSearch();
        }
      });
    }
  }

  function renderMemberList() {
    const container = document.getElementById('memberList');
    if (!container) return;

    const searchInput = document.getElementById('memberSearch');
    const keyword = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const clearBtn = document.getElementById('memberSearchClear');
    const resultsHead = document.getElementById('memberResultsHead');
    const resultsCount = document.getElementById('memberResultsCount');

    if (clearBtn) {
      clearBtn.style.display = keyword ? 'inline-flex' : 'none';
    }

    // Jangan tampilkan daftar member sebelum ada pencarian.
    if (!keyword) {
      if (resultsHead) resultsHead.style.display = 'none';
      container.innerHTML = `
        <div class="member-search-placeholder">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="16.5" y1="16.5" x2="21" y2="21"></line>
          </svg>
          <strong>Ketik nama atau nomor HP</strong>
          <span>Daftar member akan muncul setelah pencarian</span>
        </div>
      `;
      updatePilihButtonState();
      return;
    }

    const filtered = memberList.filter(m => {
      const nama = String(m.nama || "").toLowerCase();
      const nomorHp = String(m.nomorHp || "").toLowerCase();
      const kodeMember = String(m.kodeMember || "").toLowerCase();
      return nama.includes(keyword) || nomorHp.includes(keyword) || kodeMember.includes(keyword);
    });

    if (resultsHead) {
      resultsHead.style.display = 'flex';
    }

    if (resultsCount) {
      resultsCount.textContent = `${filtered.length} MEMBER DITEMUKAN`;
    }

    if (!filtered.length) {
      container.innerHTML = `
        <div class="member-empty">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="16.5" y1="16.5" x2="21" y2="21"></line>
            <line x1="18" y1="18" x2="22" y2="22"></line>
          </svg>
          <strong>Member tidak ditemukan</strong>
          <span>Coba nama, nomor HP, atau kode member lain</span>
        </div>
      `;
      updatePilihButtonState();
      return;
    }

    const getCategoryMeta = (kategori) => {
      const k = String(kategori || "").trim().toUpperCase();
      if (k === "PLATINUM") {
        return {
          label: "PLATINUM",
          color: "#b7791f",
          bg: "#fffaf0",
          icon: "P"
        };
      }
      if (k === "PELAJAR") {
        return {
          label: "PELAJAR",
          color: "#7c3aed",
          bg: "#faf5ff",
          icon: "P"
        };
      }
      return {
        label: "UMUM",
        color: "#2563eb",
        bg: "#eff6ff",
        icon: "U"
      };
    };

    container.innerHTML = filtered.map(m => {
      const isSelected = selectedMember && selectedMember.id === m.id;
      const meta = getCategoryMeta(m.kategori);
      const nama = escapeHtml(m.nama || "-");
      const kode = escapeHtml(m.kodeMember || "-");
      const hp = escapeHtml(m.nomorHp || "-");
      const status = escapeHtml(m.status || "");

      return `
        <div class="member-item-row ${isSelected ? 'selected' : ''}" onclick='MemberModal.pilihMember(${JSON.stringify(m)})'>
          <div class="member-avatar" style="color:${meta.color};background:${meta.bg};border-color:${meta.color};">
            ${
              meta.label === "PLATINUM"
              ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${meta.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <path d="M12 3l2.3 4.66L19.4 8.4l-3.7 3.61.87 5.1L12 14.72l-4.57 2.4.87-5.1L4.6 8.4l5.1-.74L12 3z"></path>
                 </svg>`
              : meta.label === "PELAJAR"
              ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${meta.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <path d="M3 8.5L12 4l9 4.5-9 4.5L3 8.5z"></path>
                   <path d="M7 11v5c2.8 1.9 7.2 1.9 10 0v-5"></path>
                   <path d="M21 9v5"></path>
                 </svg>`
              : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${meta.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <circle cx="12" cy="8" r="3.2"></circle>
                   <path d="M5 20c.9-3.2 3.5-5 7-5s6.1 1.8 7 5"></path>
                 </svg>`
            }
          </div>

          <div class="member-main-info">
            <div class="member-name">${nama}</div>
            <div class="member-meta">
              <span>${kode}</span>
              <span class="member-meta-separator">•</span>
              <span>${hp}</span>
              ${status ? `<span class="member-meta-separator">•</span><span class="member-status">${status}</span>` : ""}
            </div>
          </div>

          <div class="member-category-badge" style="color:${meta.color};background:${meta.bg};border-color:${meta.color};">
            ${meta.label === "PLATINUM" ? "◇ " : ""}${meta.label}
          </div>

          <div class="member-row-arrow" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
        </div>
      `;
    }).join("");

    updatePilihButtonState();
  }

  function updatePilihButtonState() {
    const btnPilih = document.getElementById('memberBtnPilih');
    if (!btnPilih) return;

    if (selectedMember) {
      btnPilih.removeAttribute('disabled');
    } else {
      btnPilih.setAttribute('disabled', 'true');
    }
  }

  function pilihMember(member) {
    selectedMember = member;
    renderMemberList();
  }

  function getSelectedMember() {
    return selectedMember;
  }

  function clearSelectedMember() {
    selectedMember = null;
    renderMemberList();
  }

  async function buka() {
    initModal();
    selectedMember = null;
    const searchInput = document.getElementById('memberSearch');
    if (searchInput) {
      searchInput.value = '';
    }

    await loadMembers();

    if (modalElement) {
      modalElement.classList.add('show');
    }
  }

  function tutup() {
    if (modalElement) {
      modalElement.classList.remove('show');
    }
  }

  window.handlePilihMemberClick = function() {
    if (!selectedMember) {
      alert("Silakan pilih member terlebih dahulu.");
      return;
    }

    window.dispatchEvent(
      new CustomEvent("memberSelected", {
        detail: {
          member: selectedMember
        }
      })
    );

    tutup();
  };

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clearSearch() {
    const searchInput = document.getElementById('memberSearch');
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    renderMemberList();
  }

  window.MemberModal = {
    buka,
    tutup,
    pilihMember,
    getSelectedMember,
    clearSelectedMember,
    clearSearch
  };

  document.addEventListener('DOMContentLoaded', () => {
    initModal();
  });
})();