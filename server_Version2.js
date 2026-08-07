const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const methodOverride = require('method-override');
const { createObjectCsvWriter } = require('csv-writer');

const app = express();
const PORT = process.env.PORT || 3000;

// Views & layout
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');

// Static & middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride('_method'));

app.use(session({
  secret: 'absensi-secret',
  resave: false,
  saveUninitialized: true
}));

// Ensure upload folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random()*1E9) + ext);
  }
});
const upload = multer({ storage });

// Database init (SQLite)
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    nama TEXT,
    role TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS siswa (
    id_siswa INTEGER PRIMARY KEY AUTOINCREMENT,
    nis TEXT UNIQUE,
    nama TEXT,
    kelas TEXT,
    foto TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS guru (
    id_guru INTEGER PRIMARY KEY AUTOINCREMENT,
    nip TEXT UNIQUE,
    nama TEXT,
    mata_pelajaran TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS kelas (
    id_kelas INTEGER PRIMARY KEY AUTOINCREMENT,
    nama_kelas TEXT UNIQUE,
    wali_kelas TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS presensi (
    id_presensi INTEGER PRIMARY KEY AUTOINCREMENT,
    id_siswa INTEGER,
    tanggal TEXT,
    jam_masuk TEXT,
    status TEXT,
    foto_kehadiran TEXT,
    keterangan TEXT,
    FOREIGN KEY (id_siswa) REFERENCES siswa(id_siswa) ON DELETE CASCADE
  );`);

  db.get(`SELECT COUNT(*) as c FROM users`, (err,row) => {
    if (!err && row.c === 0) {
      const saltRounds = 10;
      const plainUsers = [
        {username:'siswa1', password:'siswa123', nama:'Andi Siswa', role:'siswa'},
        {username:'guru1', password:'guru123', nama:'Bu Ani', role:'guru'},
        {username:'admin', password:'admin123', nama:'Admin', role:'admin'}
      ];
      plainUsers.forEach(u => {
        const hash = bcrypt.hashSync(u.password, saltRounds);
        db.run(`INSERT INTO users (username,password,nama,role) VALUES (?,?,?,?)`, [u.username, hash, u.nama, u.role]);
      });
      db.run(`INSERT OR IGNORE INTO kelas (nama_kelas, wali_kelas) VALUES ('10A','Bu Ani'), ('10B','Pak Budi')`);
      db.run(`INSERT OR IGNORE INTO siswa (nis,nama,kelas,foto) VALUES ('1001','Andi Siswa','10A',''), ('1002','Siti Siswa','10A','')`);
      db.run(`INSERT OR IGNORE INTO guru (nip,nama,mata_pelajaran) VALUES ('G001','Bu Ani','Matematika')`);
    }
  });
});

// Middleware: auth
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/');
}

// Routes
app.get('/', (req, res) => {
  res.render('login', { user: null, error: null });
});

app.post('/login', (req, res) => {
  const { username, password, role } = req.body;
  db.get(`SELECT * FROM users WHERE username = ? AND role = ?`, [username, role], (err, user) => {
    if (err || !user) return res.render('login', { user: null, error: 'Login gagal: username/role salah' });
    if (!bcrypt.compareSync(password, user.password)) return res.render('login', { user: null, error: 'Login gagal: password salah' });
    req.session.user = { id: user.id, username: user.username, nama: user.nama, role: user.role };
    if (user.role === 'siswa') return res.redirect('/student');
    if (user.role === 'guru') return res.redirect('/teacher');
    return res.redirect('/admin');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(()=>res.redirect('/'));
});

/* STUDENT */
app.get('/student', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'siswa') return res.redirect('/');
  db.get(`SELECT * FROM siswa WHERE nama = ?`, [req.session.user.nama], (err, siswa) => {
    if (err) return res.sendStatus(500);
    if (!siswa) {
      db.get(`SELECT * FROM siswa LIMIT 1`, (e,s) => {
        renderStudentPage(req,res,s);
      });
    } else renderStudentPage(req,res,siswa);
  });
});

function renderStudentPage(req,res,siswa){
  const today = new Date();
  const tgl = today.toISOString().split('T')[0];
  db.get(`SELECT * FROM presensi WHERE id_siswa = ? AND tanggal = ?`, [siswa.id_siswa, tgl], (err, pres) => {
    db.all(`SELECT * FROM presensi WHERE id_siswa = ? ORDER BY tanggal DESC LIMIT 20`, [siswa.id_siswa], (e, rows) => {
      res.render('student_dashboard', {
        user: req.session.user,
        siswa,
        presensiToday: pres,
        history: rows || []
      });
    });
  });
}

app.post('/student/attendance', ensureAuth, upload.single('foto_kehadiran'), (req, res) => {
  if (req.session.user.role !== 'siswa') return res.json({ success:false, message:'Akses ditolak' });
  const { status, keterangan, id_siswa } = req.body;
  const file = req.file ? path.posix.join('uploads', path.basename(req.file.path)) : '';
  const today = new Date();
  const tgl = today.toISOString().split('T')[0];
  const jam = today.toTimeString().split(' ')[0].slice(0,8);
  db.get(`SELECT * FROM presensi WHERE id_siswa = ? AND tanggal = ?`, [id_siswa, tgl], (err, existing) => {
    if (existing) {
      return res.json({ success: false, message: 'Anda sudah melakukan absensi hari ini.' });
    }
    db.run(`INSERT INTO presensi (id_siswa,tanggal,jam_masuk,status,foto_kehadiran,keterangan) VALUES (?,?,?,?,?,?)`,
      [id_siswa, tgl, jam, status, file || '', keterangan || ''],
      function(err){
        if (err) return res.json({ success: false, message: 'Gagal menyimpan absensi.' });
        return res.json({ success: true, message: 'Absensi berhasil dikirim.' });
      });
  });
});

/* TEACHER */
app.get('/teacher', ensureAuth, (req,res) => {
  if (req.session.user.role !== 'guru') return res.redirect('/');
  const qNama = req.query.nama || '';
  const kelasFilter = req.query.kelas || '';
  const tanggal = req.query.tanggal || '';
  let sql = `SELECT p.*, s.nama as nama_siswa, s.nis, s.kelas
    FROM presensi p JOIN siswa s ON p.id_siswa = s.id_siswa WHERE 1=1`;
  const params = [];
  if (qNama) { sql += ` AND s.nama LIKE ?`; params.push('%'+qNama+'%'); }
  if (kelasFilter) { sql += ` AND s.kelas = ?`; params.push(kelasFilter); }
  if (tanggal) { sql += ` AND p.tanggal = ?`; params.push(tanggal); }
  sql += ` ORDER BY p.tanggal DESC, p.jam_masuk DESC`;
  db.all(sql, params, (err, rows) => {
    db.all(`SELECT DISTINCT kelas AS kelas FROM siswa`, [], (e, kelasList) => {
      res.render('teacher_dashboard', {
        user: req.session.user,
        rows: rows || [],
        kelasList: kelasList || [],
        filters: { qNama: qNama, kelas: kelasFilter, tanggal: tanggal }
      });
    });
  });
});

app.post('/teacher/update-status', ensureAuth, (req,res) => {
  if (req.session.user.role !== 'guru') return res.json({ success:false });
  const { id_presensi, status } = req.body;
  db.run(`UPDATE presensi SET status = ? WHERE id_presensi = ?`, [status, id_presensi], function(err){
    if (err) return res.json({ success:false });
    return res.json({ success:true });
  });
});

/* ADMIN */
app.get('/admin', ensureAuth, (req,res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  db.serialize(() => {
    db.all(`SELECT * FROM siswa`, [], (e1, siswa) => {
      db.all(`SELECT * FROM guru`, [], (e2, guru) => {
        db.all(`SELECT * FROM kelas`, [], (e3, kelas) => {
          res.render('admin_dashboard', { user: req.session.user, siswa: siswa || [], guru: guru || [], kelas: kelas || [] });
        });
      });
    });
  });
});

app.delete('/admin/siswa/:id', ensureAuth, (req,res) => {
  db.run(`DELETE FROM siswa WHERE id_siswa = ?`, [req.params.id], function(err){
    res.redirect('/admin');
  });
});

/* LAPORAN */
app.get('/laporan', ensureAuth, (req,res) => {
  if (req.session.user.role === 'siswa') return res.redirect('/');
  const { tanggal_mulai, tanggal_akhir, kelas } = req.query;
  let sql = `SELECT p.*, s.nama as nama_siswa, s.nis, s.kelas FROM presensi p JOIN siswa s ON p.id_siswa = s.id_siswa WHERE 1=1`;
  const params = [];
  if (tanggal_mulai) { sql += ` AND p.tanggal >= ?`; params.push(tanggal_mulai); }
  if (tanggal_akhir) { sql += ` AND p.tanggal <= ?`; params.push(tanggal_akhir); }
  if (kelas) { sql += ` AND s.kelas = ?`; params.push(kelas); }
  sql += ` ORDER BY p.tanggal DESC`;
  db.all(sql, params, (err, rows) => {
    const summary = { hadir:0, izin:0, sakit:0, alpa:0 };
    (rows || []).forEach(r => {
      const s = (r.status||'').toLowerCase();
      if (s==='hadir') summary.hadir++;
      else if (s==='izin') summary.izin++;
      else if (s==='sakit') summary.sakit++;
      else if (s==='alpa') summary.alpa++;
    });
    db.all(`SELECT DISTINCT kelas AS kelas FROM siswa`, [], (e, kelasList) => {
      res.render('laporan', { user:req.session.user, rows: rows || [], summary, kelasList: kelasList || [], filters:{ tanggal_mulai, tanggal_akhir, kelas } });
    });
  });
});

app.get('/laporan/download', ensureAuth, async (req,res) => {
  if (req.session.user.role === 'siswa') return res.redirect('/');
  const { tanggal_mulai, tanggal_akhir, kelas } = req.query;
  let sql = `SELECT p.*, s.nama as nama_siswa, s.nis, s.kelas FROM presensi p JOIN siswa s ON p.id_siswa = s.id_siswa WHERE 1=1`;
  const params = [];
  if (tanggal_mulai) { sql += ` AND p.tanggal >= ?`; params.push(tanggal_mulai); }
  if (tanggal_akhir) { sql += ` AND p.tanggal <= ?`; params.push(tanggal_akhir); }
  if (kelas) { sql += ` AND s.kelas = ?`; params.push(kelas); }
  db.all(sql, params, async (err, rows) => {
    const csvWriter = createObjectCsvWriter({
      path: 'laporan.csv',
      header: [
        {id:'tanggal', title:'Tanggal'},
        {id:'jam_masuk', title:'Jam'},
        {id:'nis', title:'NIS'},
        {id:'nama_siswa', title:'Nama'},
        {id:'kelas', title:'Kelas'},
        {id:'status', title:'Status'},
        {id:'keterangan', title:'Keterangan'},
        {id:'foto_kehadiran', title:'Foto'}
      ]
    });
    await csvWriter.writeRecords(rows || []);
    res.download('laporan.csv');
  });
});

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));