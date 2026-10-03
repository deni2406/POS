const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('./index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

let passed = 0;

scripts.forEach((match, index) => {
  const code = match[1].trim();
  if (!code) return;

  try {
    new vm.Script(code, { filename: `index.html:inline-script-${index + 1}.js` });
    console.log(`PASS inline script ${index + 1}`);
    passed++;
  } catch (err) {
    console.error(`FAIL inline script ${index + 1}`);
    console.error(err.message);
    process.exitCode = 1;
  }
});

console.log(`\nTotal inline script valid: ${passed}`);
console.log(`Total inline script ditemukan: ${scripts.length}`);
