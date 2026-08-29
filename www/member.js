/**
 * member.js
 * Modul khusus mandiri untuk menangani UI modal Member POS PollarBilliard.
 */

(function () {
  console.log("DEBUG LOAD MemberModal");

  let memberList = [];
  let selectedMember = null;
  let modalElement = null;
  let formModalElement = null;
  let kategoriListCache = [];

  async function loadMembers() {
    const container = document.getElementById('memberList');
    if (container) {
      container.innerHTML = `<div class="member-empty">Memuat data member...</div>`;
    }

    try {
      const response = await fetch("/api/member");
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
      const response = await fetch("/api/member/kategori");
      const result = await response.json();
      if (result.success === true && Array.isArray(result.data)) {
        kategoriListCache = result.data;
      } else {
        kategoriListCache = [];
      }
    } catch (error) {
      console.error("Gagal memuat kategori member:", error);
      kategoriListCache = [];
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
    await loadKategori();

    const katSelect = document.getElementById('memberKategoriSelect');
    if (katSelect) {
      katSelect.innerHTML = kategoriListCache.map(k => `
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
    const kategoriId = katSelect ? Number(katSelect.value) : null;
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
      nama,
      alamat,
      nomorHp,
      tanggalLahir,
      kategoriId,
      namaSekolah: namaKategori === "PELAJAR" ? namaSekolah : "",
      nisn: namaKategori === "PELAJAR" ? nisn : ""
    };

    const btnSimpan = document.getElementById('memberBtnSimpan');
    if (btnSimpan) {
      btnSimpan.innerText = "MENYIMPAN...";
      btnSimpan.setAttribute('disabled', 'true');
    }

    try {
      const response = await fetch("/api/member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
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
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 3300;
          opacity: 0;
          visibility: hidden;
          transition: all 0.25s ease-in-out;
          padding: 15px;
          box-sizing: border-box;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .member-modal-overlay.show {
          opacity: 1;
          visibility: visible;
        }
        .member-modal-card {
          background: #ffffff;
          width: 100%;
          max-width: 480px;
          height: 85vh;
          max-height: 600px;
          border-radius: 16px;
          padding: 24px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          transform: scale(0.95);
          transition: transform 0.25s ease-in-out;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
        }
        .member-modal-overlay.show .member-modal-card {
          transform: scale(1);
        }
        .member-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          border-bottom: 1px solid #e5e7eb;
          padding-bottom: 12px;
          flex-shrink: 0;
        }
        .member-modal-title {
          font-size: 1.2rem;
          font-weight: 800;
          color: #111827;
          margin: 0;
          letter-spacing: 0.5px;
        }
        .member-modal-close {
          background: none;
          border: none;
          font-size: 26px;
          line-height: 1;
          cursor: pointer;
          color: #6b7280;
          padding: 4px 8px;
          border-radius: 8px;
        }
        .member-modal-close:hover {
          color: #111827;
          background: #f3f4f6;
        }
        .member-modal-search {
          width: 100%;
          padding: 14px 16px;
          font-size: 1.05rem;
          border: 2px solid #d1d5db;
          border-radius: 10px;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.2s;
          margin-bottom: 12px;
          background: #f9fafb;
          flex-shrink: 0;
        }
        .member-modal-search:focus {
          border-color: #3b82f6;
          background: #ffffff;
        }
        .member-top-action {
          margin-bottom: 16px;
          flex-shrink: 0;
        }
        .member-add-btn {
          width: 100%;
          padding: 12px;
          font-size: 0.9rem;
          font-weight: 700;
          border: 2px dashed #cbd5e1;
          border-radius: 10px;
          background: #f8fafc;
          color: #334155;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
        }
        .member-add-btn:hover {
          background: #f1f5f9;
          border-color: #94a3b8;
          color: #0f172a;
        }
        .member-list-container {
          flex: 1;
          overflow-y: auto;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 10px;
          background: #f9fafb;
          margin-bottom: 16px;
          min-height: 0;
        }
        .member-item-row {
          padding: 12px 14px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          margin-bottom: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .member-item-row:hover {
          border-color: #93c5fd;
          background: #eff6ff;
        }
        .member-item-row.selected {
          border-color: #3b82f6;
          background: #eff6ff;
          box-shadow: 0 0 0 1px #3b82f6;
        }
        .member-name {
          font-weight: bold;
          font-size: 1rem;
          color: #111827;
          margin-bottom: 2px;
        }
        .member-phone {
          font-size: 0.85rem;
          color: #6b7280;
        }
        .member-empty {
          font-size: 0.9rem;
          color: #6b7280;
          text-align: center;
          padding: 20px;
        }
        .member-modal-footer {
          display: flex;
          gap: 12px;
          flex-shrink: 0;
        }
        .member-btn-batal {
          flex: 1;
          padding: 14px;
          background: #f3f4f6;
          color: #374151;
          border: none;
          border-radius: 10px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .member-btn-batal:hover {
          background: #e5e7eb;
        }
        .member-btn-pilih {
          flex: 1;
          padding: 14px;
          background: #3b82f6;
          color: #ffffff;
          border: none;
          border-radius: 10px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .member-btn-pilih:hover {
          background: #2563eb;
        }
        .member-btn-pilih:disabled {
          background: #9ca3af;
          cursor: not-allowed;
        }
      </style>

      <div class="member-modal-card">
        <div class="member-modal-header">
          <h3 class="member-modal-title">MEMBER</h3>
          <button class="member-modal-close" onclick="MemberModal.tutup()">&times;</button>
        </div>

        <input 
          id="memberSearch" 
          class="member-modal-search" 
          type="text" 
          placeholder="Cari nama / nomor HP" 
          autocomplete="off"
        >

        <div class="member-top-action">
          <button class="member-add-btn" onclick="bukaFormTambahMember()">
            + TAMBAH MEMBER
          </button>
        </div>

        <div id="memberList" class="member-list-container">
          <!-- Daftar member dirender dinamis -->
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
    }
  }

  function renderMemberList() {
    const container = document.getElementById('memberList');
    if (!container) return;

    const searchInput = document.getElementById('memberSearch');
    const keyword = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let filtered = memberList;
    if (keyword) {
      filtered = memberList.filter(m => {
        const nama = String(m.nama || "").toLowerCase();
        const nomorHp = String(m.nomorHp || "").toLowerCase();
        const kodeMember = String(m.kodeMember || "").toLowerCase();
        return nama.includes(keyword) || nomorHp.includes(keyword) || kodeMember.includes(keyword);
      });
    }

    if (!filtered.length) {
      container.innerHTML = `<div class="member-empty">Member tidak ditemukan.</div>`;
      updatePilihButtonState();
      return;
    }

    container.innerHTML = filtered.map(m => {
      const isSelected = selectedMember && selectedMember.id === m.id;
      return `
        <div class="member-item-row ${isSelected ? 'selected' : ''}" onclick='MemberModal.pilihMember(${JSON.stringify(m)})'>
          <div class="member-name">${escapeHtml(m.nama)}</div>
          <div class="member-phone">${escapeHtml(m.kodeMember)} | ${escapeHtml(m.nomorHp)} | ${escapeHtml(m.kategori || "")} | ${escapeHtml(m.status || "")}</div>
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

  window.MemberModal = {
    buka,
    tutup,
    pilihMember,
    getSelectedMember,
    clearSelectedMember
  };

  document.addEventListener('DOMContentLoaded', () => {
    initModal();
  });
})();