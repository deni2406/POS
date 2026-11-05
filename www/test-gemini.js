const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI();

async function main() {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'Halo Gemini, berikan satu tips singkat untuk optimasi kode JavaScript!',
  });
  console.log(response.text);
}

main();
