const sqlite3=require("sqlite3");
const db=new sqlite3.Database("C:/POS/pos.db");
db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",(err,rows)=>{
if(err){console.error(err.message);process.exit(1)}
console.log(rows.map(r=>r.name).join("\n"));
db.close();
});
