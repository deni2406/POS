const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI();

async function ujiAnalisa() {
  const prompt = Bertindaklah sebagai Senior Backend Engineer. Analisis aturan validasi qty berikut untuk endpoint POST /api/transaksi:+
- Qty bersumber dari item.qty, harus dikonversi dengan Number(item.qty).+
- Sebelum subtotal dihitung, qty harus berupa integer dan > 0 (nol, negatif, NaN, Infinity ditolak).+
- Setelah lolos, subtotal dihitung (hargaJual * clientQty) dan stok dikurangi.+
+
Berikan penilaian singkat (apakah aturan ini sudah aman secara logika bisnis) dan berikan contoh kode JavaScript singkat untuk validasi tersebut!;

  console.log('Mengirim permintaan analisis ke Gemini...\n');
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  console.log('=== HASIL ANALISIS GEMINI ===');
  console.log(response.text);
}

ujiAnalisa();
