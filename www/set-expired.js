const sqlite3=require("sqlite3").verbose();
const db=new sqlite3.Database("C:/POS/pos.db");
db.run("UPDATE member SET status=? WHERE kode_member=?",["EXPIRED","TEST-MBR-001"],e=>{console.log(e||"OK");db.close();});
