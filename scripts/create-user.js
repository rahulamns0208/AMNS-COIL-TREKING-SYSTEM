const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const dir=path.join(__dirname,'..','data');
if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
const db=new Database(path.join(dir,'amns-coils.sqlite'));
const [username,password,roleRaw,scope] = process.argv.slice(2);
const role=String(roleRaw||'').toUpperCase();
if (!username || !password || !role || !scope) {
  console.error('Usage: npm run create-user -- <username> <password> <ADMIN|CRANE|DEPARTMENT> <scope>');
  console.error('Examples: npm run create-user -- crane01 "long-password" CRANE "CRANE 1"');
  console.error('          npm run create-user -- cgl1user "long-password" DEPARTMENT "CGL 1"');
  process.exit(1);
}
if (password.length<12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
if (!['ADMIN','CRANE','DEPARTMENT'].includes(role)) { console.error('Invalid role.'); process.exit(1); }
try {
 const info=db.prepare('INSERT INTO users(username,password_hash,role,scope) VALUES(?,?,?,?)')
  .run(username,bcrypt.hashSync(password,12),role,scope);
 console.log(`Created ${role} account "${username}" with scope "${scope}" (id ${info.lastInsertRowid}).`);
} catch(e) { console.error('Could not create account:',e.message); process.exit(1); }
