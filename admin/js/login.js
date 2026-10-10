document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const btnLogin = document.getElementById('btnLogin');
  const msgEl = document.getElementById('loginMessage');

  function showMessage(text, type) {
    msgEl.textContent = text;
    msgEl.className = `login-message is-visible is-${type}`;
  }

  function clearMessage() {
    msgEl.textContent = '';
    msgEl.className = 'login-message';
  }

  const usernameInput = document.getElementById('adminUsername');
  const pinInput = document.getElementById('adminPin');

  // PIN input: allow digits only, max 6
  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessage();

    const username = usernameInput.value.trim();
    const pin = pinInput.value.trim();

    if (!username || !pin) {
      showMessage('Username dan PIN wajib diisi.', 'error');
      return;
    }

    if (pin.length !== 6) {
      showMessage('PIN harus 6 digit angka.', 'error');
      return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Memeriksa…';

    try {
      const resp = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      });

      const data = await resp.json();

      if (resp.ok && data.success) {
        sessionStorage.setItem('pbms_admin_session', JSON.stringify({
          username: data.username || username,
          nama: data.nama || '',
          loggedAt: new Date().toISOString(),
        }));
        showMessage('Login berhasil. Mengarahkan…', 'success');
        setTimeout(() => {
          window.location.href = '/admin/dashboard.html';
        }, 600);
      } else {
        showMessage(data.message || 'Username atau PIN salah.', 'error');
      }
    } catch (err) {
      showMessage('Gagal terhubung ke server. Coba lagi.', 'error');
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Masuk';
    }
  });
});
