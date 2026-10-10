const fs = require('fs');
const lines = fs.readFileSync('www/index.html', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (/konfirmasi|mulaiSesi|bukaMeja|buka/i.test(l)) {
    console.log((i + 1) + ': ' + l.trim());
  }
});
