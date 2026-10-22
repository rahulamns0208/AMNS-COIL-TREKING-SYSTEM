const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'amns-coils.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','CRANE','DEPARTMENT')),
  scope TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coil_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
  current_area TEXT,
  current_location TEXT,
  layer INTEGER,
  status TEXT NOT NULL DEFAULT 'REGISTERED',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coil_no TEXT NOT NULL COLLATE NOCASE,
  from_area TEXT,
  from_location TEXT,
  to_area TEXT,
  to_location TEXT,
  action TEXT NOT NULL,
  performed_by INTEGER REFERENCES users(id),
  performed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS saddles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department TEXT NOT NULL,
  pit_key TEXT NOT NULL CHECK(pit_key IN ('p1','p2')),
  position_index INTEGER NOT NULL CHECK(position_index BETWEEN 0 AND 2),
  coil_no TEXT UNIQUE COLLATE NOCASE,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(department,pit_key,position_index)
);
CREATE TABLE IF NOT EXISTS transfer_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coil_no TEXT NOT NULL COLLATE NOCASE,
  from_area TEXT,
  from_location TEXT,
  to_area TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_CRANE',
  created_by INTEGER REFERENCES users(id),
  completed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
`);
const departments = [
 'CRM 1','CRM 3','CRS','TRM 1','TRM 2','CGL 1','CGL 2','FSL','CCL','CNRNTY',
 'CGL 1 EXIT','CGL 2 EXIT','CCL 1 EXIT','CCL 2 EXIT','CRM 1 EXIT','CRM 2 EXIT',
 'PICKLING 1 EXIT','HOT ROLL 1 EXIT','PACKING 1 EXIT'
];
const yards = ['CGL AREA','CRM AREA','CCL AREA','PICKLING AREA','HOT ROLL COIL AREA','PACKING AREA'];
const entries = ['CGL 1 ENTRY','CGL 2 ENTRY','CCL 1 ENTRY','CCL 2 ENTRY','CRM 1 ENTRY','CRM 2 ENTRY','PICKLING 1 ENTRY','HOT ROLL 1 ENTRY','PACKING 1 ENTRY'];
const saddleDepartments = departments.filter(d => d.endsWith('EXIT'));

const adminCount = db.prepare("SELECT COUNT(*) n FROM users WHERE role='ADMIN'").get().n;
if (!adminCount && process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD) {
  const hash = bcrypt.hashSync(process.env.INITIAL_ADMIN_PASSWORD, 12);
  db.prepare('INSERT INTO users(username,password_hash,role,scope) VALUES(?,?,?,?)')
    .run(process.env.INITIAL_ADMIN_USERNAME, hash, 'ADMIN', '*');
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
const SQLiteStore = SQLiteStoreFactory(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req,res,next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  const u = db.prepare('SELECT id,username,role,scope,active FROM users WHERE id=?').get(req.session.user.id);
  if (!u || !u.active) { req.session.destroy(()=>{}); return res.status(401).json({error:'Account disabled.'}); }
  req.user = u; next();
}
function allow(...roles) {
  return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'Permission denied.'});
}
function clean(v, max=120) { return String(v ?? '').trim().slice(0,max); }
function normalizeCoil(v) { return clean(v,80).toUpperCase(); }
function canAccessDepartment(user, dept) {
  return user.role === 'ADMIN' || user.role === 'CRANE' || (user.role === 'DEPARTMENT' && user.scope.toUpperCase() === dept.toUpperCase());
}
function logMovement(coilNo, fromArea, fromLoc, toArea, toLoc, action, userId, notes='') {
  db.prepare(`INSERT INTO movements(coil_no,from_area,from_location,to_area,to_location,action,performed_by,notes)
              VALUES(?,?,?,?,?,?,?,?)`).run(coilNo,fromArea||'',fromLoc||'',toArea||'',toLoc||'',action,userId,notes);
}
app.get('/api/health', (req,res) => res.json({ok:true, service:'AM/NS Coil Tracking System'}));
app.post('/api/login', (req,res) => {
  const username = clean(req.body.username,80);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1').get(username);
  if (!user || !bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:'Invalid username or password.'});
  req.session.regenerate(err => {
    if (err) return res.status(500).json({error:'Unable to start session.'});
    req.session.user = {id:user.id};
    res.json({user:{id:user.id,username:user.username,role:user.role,scope:user.scope}});
  });
});
app.get('/api/me', auth, (req,res) => res.json({user:{id:req.user.id,username:req.user.username,role:req.user.role,scope:req.user.scope}}));
app.post('/api/logout', auth, (req,res) => req.session.destroy(err => err ? res.status(500).json({error:'Logout failed.'}) : res.json({ok:true})));

app.get('/api/config', auth, (req,res) => res.json({departments,yards,entries,saddleDepartments,rows:[1,2,3,4,5,6],columns:['A','B','C','D','E']}));
app.get('/api/users', auth, allow('ADMIN'), (req,res) => {
  res.json(db.prepare('SELECT id,username,role,scope,active,created_at FROM users ORDER BY username').all());
});
app.post('/api/users', auth, allow('ADMIN'), (req,res) => {
  const username=clean(req.body.username,80), password=String(req.body.password||''), role=clean(req.body.role,20).toUpperCase(), scope=clean(req.body.scope,80);
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username)) return res.status(400).json({error:'Username must be 3–80 letters, digits, dot, underscore or hyphen.'});
  if (password.length < 12) return res.status(400).json({error:'Use a password of at least 12 characters.'});
  if (!['ADMIN','CRANE','DEPARTMENT'].includes(role)) return res.status(400).json({error:'Invalid role.'});
  if (role==='CRANE' && !/^CRANE (0?[1-9]|1[0-9]|2[0-5])$/.test(scope.toUpperCase())) return res.status(400).json({error:'Crane scope must be CRANE 1 through CRANE 25.'});
  if (role==='DEPARTMENT' && !departments.includes(scope)) return res.status(400).json({error:'Choose a listed department.'});
  try {
    const info=db.prepare('INSERT INTO users(username,password_hash,role,scope) VALUES(?,?,?,?)')
      .run(username,bcrypt.hashSync(password,12),role,scope);
    res.status(201).json({id:info.lastInsertRowid,username,role,scope});
  } catch(e) { res.status(409).json({error:'Username already exists.'}); }
});
app.patch('/api/users/:id', auth, allow('ADMIN'), (req,res) => {
  const id=Number(req.params.id);
  if (id===req.user.id && req.body.active===false) return res.status(400).json({error:'You cannot disable your own account.'});
  const active=req.body.active ? 1 : 0;
  const info=db.prepare('UPDATE users SET active=? WHERE id=?').run(active,id);
  if (!info.changes) return res.status(404).json({error:'User not found.'});
  res.json({ok:true});
});
app.post('/api/users/:id/reset-password', auth, allow('ADMIN'), (req,res) => {
  const password=String(req.body.password||'');
  if (password.length<12) return res.status(400).json({error:'Use a password of at least 12 characters.'});
  const info=db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,12),Number(req.params.id));
  if (!info.changes) return res.status(404).json({error:'User not found.'});
  res.json({ok:true});
});

app.get('/api/coils', auth, (req,res) => {
  const q=clean(req.query.q,80);
  const rows=q
    ? db.prepare(`SELECT c.*,u.username created_by_name FROM coils c LEFT JOIN users u ON u.id=c.created_by WHERE c.coil_no LIKE ? ORDER BY c.coil_no`).all(`%${q}%`)
    : db.prepare(`SELECT c.*,u.username created_by_name FROM coils c LEFT JOIN users u ON u.id=c.created_by ORDER BY c.updated_at DESC`).all();
  res.json(rows);
});
app.post('/api/coils', auth, (req,res) => {
  const coil=normalizeCoil(req.body.coil_no), area=clean(req.body.current_area,100), loc=clean(req.body.current_location,120), notes=clean(req.body.notes,500);
  if (!coil) return res.status(400).json({error:'Coil number is required.'});
  if (req.user.role==='DEPARTMENT' && area && !canAccessDepartment(req.user,area)) return res.status(403).json({error:'This department cannot register coils in that area.'});
  try {
    const info=db.prepare('INSERT INTO coils(coil_no,current_area,current_location,notes,created_by) VALUES(?,?,?,?,?)').run(coil,area,loc,notes,req.user.id);
    logMovement(coil,'','',area,loc,'REGISTERED',req.user.id,notes);
    res.status(201).json(db.prepare('SELECT * FROM coils WHERE id=?').get(info.lastInsertRowid));
  } catch(e) { res.status(409).json({error:'This coil number is already registered.'}); }
});
app.patch('/api/coils/:id', auth, (req,res) => {
  const coilRow=db.prepare('SELECT * FROM coils WHERE id=?').get(Number(req.params.id));
  if (!coilRow) return res.status(404).json({error:'Coil not found.'});
  if (req.user.role==='DEPARTMENT' && !canAccessDepartment(req.user,coilRow.current_area||'')) return res.status(403).json({error:'Permission denied for this coil.'});
  const area=clean(req.body.current_area,100), loc=clean(req.body.current_location,120), layer=req.body.layer===''||req.body.layer==null?null:Number(req.body.layer), status=clean(req.body.status||coilRow.status,40), notes=clean(req.body.notes ?? coilRow.notes,500);
  if (layer!==null && ![1,2,3].includes(layer)) return res.status(400).json({error:'Layer must be 1, 2 or 3.'});
  if (req.user.role==='DEPARTMENT' && area && !canAccessDepartment(req.user,area)) return res.status(403).json({error:'This department cannot move coils to that area.'});
  db.prepare('UPDATE coils SET current_area=?,current_location=?,layer=?,status=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(area,loc,layer,status,notes,coilRow.id);
  logMovement(coilRow.coil_no,coilRow.current_area,coilRow.current_location,area,loc,'LOCATION_UPDATED',req.user.id,notes);
  res.json(db.prepare('SELECT * FROM coils WHERE id=?').get(coilRow.id));
});
app.get('/api/inventory.xlsx', auth, (req,res) => {
  const rows=db.prepare(`SELECT coil_no AS "Coil Number", current_area AS "Current Area", current_location AS "Current Location", layer AS "Layer", status AS "Status", notes AS "Notes", created_at AS "Registered At", updated_at AS "Last Updated" FROM coils ORDER BY coil_no`).all();
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{"Coil Number":"No registered coils yet"}]),'Current Inventory');
  const movements=db.prepare(`SELECT m.coil_no AS "Coil Number",m.action AS "Action",m.from_area AS "From Area",m.from_location AS "From Location",m.to_area AS "To Area",m.to_location AS "To Location",u.username AS "Performed By",m.performed_at AS "Time",m.notes AS "Notes" FROM movements m LEFT JOIN users u ON u.id=m.performed_by ORDER BY m.performed_at DESC`).all();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(movements.length?movements:[{"Coil Number":"No movement history yet"}]),'Movement History');
  const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="AMNS_Current_Coil_Inventory.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
});
app.get('/api/movements', auth, (req,res) => {
  const rows=db.prepare(`SELECT m.*,u.username FROM movements m LEFT JOIN users u ON u.id=m.performed_by ORDER BY m.performed_at DESC LIMIT 1000`).all();
  res.json(rows);
});

app.get('/api/saddles', auth, (req,res) => res.json(db.prepare('SELECT * FROM saddles ORDER BY department,pit_key,position_index').all()));
app.put('/api/saddles/:department/:pit/:position', auth, (req,res) => {
  const department=decodeURIComponent(req.params.department), pit=req.params.pit, pos=Number(req.params.position), coil=normalizeCoil(req.body.coil_no);
  if (!saddleDepartments.includes(department)) return res.status(400).json({error:'Unknown exit department.'});
  if (!['p1','p2'].includes(pit) || !Number.isInteger(pos) || pos<0 || pos>2) return res.status(400).json({error:'Invalid saddle position.'});
  if (req.user.role==='DEPARTMENT' && req.user.scope!==department.replace(' EXIT','')) return res.status(403).json({error:'Permission denied for this exit line.'});
  const existing=db.prepare('SELECT * FROM saddles WHERE department=? AND pit_key=? AND position_index=?').get(department,pit,pos);
  const prior=existing?.coil_no || '';
  if (coil) {
    const elsewhere=db.prepare('SELECT department,pit_key,position_index FROM saddles WHERE coil_no=? COLLATE NOCASE AND NOT(department=? AND pit_key=? AND position_index=?)').get(coil,department,pit,pos);
    const inYard=db.prepare('SELECT current_area,current_location FROM coils WHERE coil_no=? COLLATE NOCASE').get(coil);
    if (elsewhere || (inYard && inYard.current_location)) return res.status(409).json({error:'Coil is already assigned to another location.'});
  }
  db.prepare(`INSERT INTO saddles(department,pit_key,position_index,coil_no,updated_by,updated_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(department,pit_key,position_index) DO UPDATE SET coil_no=excluded.coil_no,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(department,pit,pos,coil||null,req.user.id);
  if (prior && prior!==coil) logMovement(prior,department,`${pit}:${pos+1}`,'','', 'REMOVED_FROM_SADDLE',req.user.id);
  if (coil) {
    db.prepare(`INSERT INTO coils(coil_no,current_area,current_location,status,created_by) VALUES(?,?,?,?,?)
      ON CONFLICT(coil_no) DO UPDATE SET current_area=excluded.current_area,current_location=excluded.current_location,status='ON_EXIT_SADDLE',updated_at=CURRENT_TIMESTAMP`)
      .run(coil,department,`${pit}:${pos+1}`,'ON_EXIT_SADDLE',req.user.id);
    logMovement(coil,prior?department:'',prior?`${pit}:${pos+1}`:'',department,`${pit}:${pos+1}`,'PLACED_ON_SADDLE',req.user.id);
  }
  res.json({ok:true});
});

app.get('/api/yard', auth, (req,res) => {
  const area=clean(req.query.area,100);
  const rows=area ? db.prepare('SELECT * FROM coils WHERE current_area=? ORDER BY current_location').all(area) : db.prepare('SELECT * FROM coils WHERE current_location IS NOT NULL AND current_location<>"" ORDER BY current_area,current_location').all();
  res.json(rows);
});
app.post('/api/transfers', auth, (req,res) => {
  const coil=normalizeCoil(req.body.coil_no), dest=clean(req.body.to_area,100);
  const row=db.prepare('SELECT * FROM coils WHERE coil_no=? COLLATE NOCASE').get(coil);
  const saddle=db.prepare('SELECT * FROM saddles WHERE coil_no=? COLLATE NOCASE').get(coil);
  if (!row && !saddle) return res.status(404).json({error:'Coil is not registered at a known location.'});
  if (!entries.includes(dest)) return res.status(400).json({error:'Choose a valid entry line.'});
  const fromArea=saddle?.department || row.current_area || '', fromLoc=saddle?`${saddle.pit_key}:${saddle.position_index+1}`:row.current_location || '';
  const info=db.prepare('INSERT INTO transfer_requests(coil_no,from_area,from_location,to_area,created_by) VALUES(?,?,?,?,?)').run(coil,fromArea,fromLoc,dest,req.user.id);
  logMovement(coil,fromArea,fromLoc,dest,'','TRANSFER_REQUESTED',req.user.id);
  res.status(201).json({id:info.lastInsertRowid});
});
app.get('/api/transfers', auth, (req,res) => res.json(db.prepare(`SELECT t.*,u.username AS requested_by FROM transfer_requests t LEFT JOIN users u ON u.id=t.created_by WHERE t.status<>'CONFIRMED' ORDER BY t.created_at`).all()));
app.post('/api/transfers/:id/complete', auth, allow('ADMIN','CRANE'), (req,res) => {
  const t=db.prepare('SELECT * FROM transfer_requests WHERE id=?').get(Number(req.params.id));
  if (!t || t.status!=='PENDING_CRANE') return res.status(404).json({error:'Pending transfer not found.'});
  const tx=db.transaction(() => {
    db.prepare("UPDATE transfer_requests SET status='PENDING_CONFIRMATION',completed_by=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,t.id);
    db.prepare('DELETE FROM saddles WHERE coil_no=? COLLATE NOCASE').run(t.coil_no);
    db.prepare("UPDATE coils SET current_area=?,current_location=?,status='AWAITING_CONFIRMATION',updated_at=CURRENT_TIMESTAMP WHERE coil_no=? COLLATE NOCASE").run(t.to_area,'',t.coil_no);
    logMovement(t.coil_no,t.from_area,t.from_location,t.to_area,'','CRANE_DELIVERED',req.user.id);
  });
  tx(); res.json({ok:true});
});
app.post('/api/transfers/:id/confirm', auth, (req,res) => {
  const t=db.prepare('SELECT * FROM transfer_requests WHERE id=?').get(Number(req.params.id));
  if (!t || t.status!=='PENDING_CONFIRMATION') return res.status(404).json({error:'Transfer awaiting confirmation not found.'});
  if (req.user.role==='DEPARTMENT' && !canAccessDepartment(req.user,t.to_area)) return res.status(403).json({error:'Only the destination department can confirm this transfer.'});
  db.prepare("UPDATE transfer_requests SET status='CONFIRMED' WHERE id=?").run(t.id);
  db.prepare("UPDATE coils SET status='AT_ENTRY',updated_at=CURRENT_TIMESTAMP WHERE coil_no=? COLLATE NOCASE").run(t.coil_no);
  logMovement(t.coil_no,t.to_area,'','', '', 'ARRIVAL_CONFIRMED',req.user.id);
  res.json({ok:true});
});

app.use('/api', (err,req,res,next) => { console.error(err); res.status(500).json({error:'Internal server error.'}); });
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,HOST,()=>console.log(`AM/NS Coil Tracking System listening on http://${HOST}:${PORT}`));
