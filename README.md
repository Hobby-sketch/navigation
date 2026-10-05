# BeAT Dash — GPS Speedometer PWA

Dashboard speedometer GPS premium untuk Honda BeAT. Vanilla HTML/CSS/JS, tanpa framework, 100% berbasis sensor smartphone (GPS, kompas, akselerometer, giroskop). **Tidak** terhubung ke ECU, CAN Bus, OBD, atau sistem kelistrikan motor manapun.

## Revisi terbaru — Smart GPS Engine & UI Premium

Project ini sudah melalui satu putaran review/refactor tanpa mengubah struktur folder, nama file, atau layout utama:

- **gps.js** — "Smart GPS Engine": Kalman filter untuk posisi, EMA adaptif untuk speed, circular smoothing untuk heading/kompas (anti-jitter di 0°/360°), deteksi gerak (movement detection) dengan hysteresis, drift compensation (posisi dikunci saat motor benar-benar berhenti), noise/outlier rejection, kategori kualitas GPS (Poor/Fair/Good/Excellent), status watchdog (Mencari Lokasi/Lokasi Ditemukan/GPS Lemah/GPS Hilang), dan loop prediksi (dead reckoning) berbasis `requestAnimationFrame` agar titik di peta bergerak mulus di antara dua fix GPS, bukan meloncat.
- **motion.js** — kompas kini pakai circular smoother yang sama (reuse dari gps.js) agar tidak melompat saat melewati 0°/360°.
- **map.js** — marker lokasi ala Google Maps (blue dot + pulse + panah arah + accuracy circle akurat dalam meter), Follow GPS otomatis berhenti saat peta digeser manual lalu memunculkan tombol "Kembali Ikuti", seluruh pergerakan kamera (zoom/rotate/follow/fit) memakai easing halus.
- **storage.js** — tambahan riwayat pencarian & favorit lokasi (localStorage).
- **style.css** — tampilan dinaikkan ke kelas TFT premium: carbon-fiber weave, hexagon pattern, film-grain noise, dan glassmorphism — semuanya CSS murni (gradient/SVG data-uri), tanpa gambar besar, dan hanya memakai `transform`/`opacity` untuk animasi supaya tetap GPU-friendly & 60fps.
- **ui.js** — utilitas `debounce`/`throttle` reusable dipakai untuk pencarian & pencarian kategori supaya tidak membanjiri API publik (Nominatim/Overpass).

Semua fitur lama (boot screen, speedometer, trip/odometer, kategori peta, bottom nav, dsb.) tetap berjalan seperti sebelumnya — perubahan di atas bersifat aditif dan backward-compatible.

## Revisi: Heading, Lean Angle, Navigasi Turn-by-Turn & Layout Landscape

Perubahan ini bersifat aditif — loading screen (HTML, CSS, `boot.js`) **tidak diubah sama sekali**, dan tidak ada fitur lama yang dihapus.

### 1. Heading terpadu — `vehicleHeading` (`heading.js`)
Satu sumber arah untuk panah motor di peta, UI kompas, bearing peta (Heading Up), dead reckoning, dan navigasi.
`GPS bearing + kompas + kecepatan + confidence → vehicleHeading`
- Bergerak & bearing GPS valid → bobot GPS dominan; berhenti/pelan → kompas dominan; GPS tidak valid → kompas saja.
- Confidence rendah → heading **ditahan** (tidak dipakai), confidence turun bertahap. Smoothing adaptif: cepat saat belok, halus saat lurus.
- Kompas dikoreksi dengan *bias yang dipelajari dari GPS* saat melaju (per orientasi layar), sehingga deklinasi magnet / kuirk browser terserap otomatis. Orientasi **relatif** (bukan absolut) tidak pernah dianggap arah utara sebelum divalidasi GPS.

### 2. Sensor & orientasi layar (`orientation.js`, `motion.js`)
`sensor mentah → koreksi layar (screen.orientation.angle) → koreksi mounting → bingkai motor → roll/pitch/heading`
- Koreksi layar = transformasi koordinat sumbu sensor (bukan +90/-90 hardcode). Heading, roll, dan pitch **sama** di portrait, landscape kiri/kanan, dan saat layar diputar.
- Hanya **satu** aliran orientasi yang dipakai pada satu waktu: `webkitCompassHeading` → absolut (`deviceorientationabsolute`) → relatif (tidak dipercaya sampai divalidasi GPS) → tahan heading terakhir.
- Lean: complementary filter accelerometer + gyroscope (+ orientasi OS sebagai referensi lemah), kepercayaan accelerometer turun saat |a| ≠ 1 g (rem/tikungan), re-sync otomatis bila selisih besar. Dilanjutkan low-pass adaptif, deadband ±1°, hysteresis KANAN/KIRI (masuk >4°, tetap sampai <2°).
- **Kalibrasi mounting**: tombol ⌖ di panel Lean atau Pengaturan → Kalibrasi (motor tegak & diam). Disimpan permanen; menyimpan roll/pitch offset dan sumbu vertikal motor.
- SVG lean berotasi pada **titik kontak ban–tanah** (garis tanah tetap diam). Nilai lean hanyalah indikator kemiringan, **bukan** klaim keselamatan.

### 3. Navigasi (`geo.js`, `navigation.js`, `maneuver.js`, `voice.js`)
- **Nearest point on line segment**: GPS diproyeksikan ke tiap segmen rute → jarak dari rute, jarak kumulatif, progres, sisa jarak, ETA — semuanya dari **satu** sumber (geometri rute; jarak OSRM hanya metadata).
- **Off-route adaptif**: `max(minimum, akurasi GPS×2, kecepatan) + kelonggaran tikungan`, disesuaikan heading. Reroute hanya setelah ≥3 fix berturut-turut selama ≥5 dtk (atau 2 fix bila sangat jauh & akurat), fix akurasi >60 m diabaikan, tidak reroute saat diam / saat sudah kembali mendekat, dengan cooldown 20 dtk.
- **Dead reckoning** memakai `vehicleHeading`, dibatasi confidence, akurasi, umur fix, dan jarak maksimum 30 m.
- **Tiba**: `NAVIGATING → APPROACHING_DESTINATION → ARRIVED`; butuh kedekatan ke tujuan + posisi di rute + kecepatan rendah + 2 fix berturut-turut (bukan sekadar `< 25 m`).
- **Turn-by-turn** (`steps=true`): straight, left/right, slight, sharp, U-turn, bundaran, tujuan. State per maneuver: `CURRENT / APPROACHING / TURN_NOW / PASSED / NEXT_MANEUVER`; otomatis pindah ke maneuver berikutnya.
- **Suara** (SpeechSynthesis, bahasa Indonesia): "200 meter lagi, belok kanan." → "50 meter lagi…" → "Belok kanan sekarang." + keluar rute / hampir tiba / telah tiba. Setiap ucapan sekali per rute, ada jeda minimum & anti-duplikat. Toggle ON/OFF di Pengaturan.
- **Kamera**: North Up / Heading Up (tombol kompas di peta atau Pengaturan), kendaraan di bawah-tengah pada Heading Up, auto zoom mengikuti kecepatan (dan mendekati tikungan). Geser/zoom manual **tidak** dipaksa kembali; tombol "Kembali Ikuti" untuk recenter.
- **Memilih tujuan**: pencarian (tetap), ketuk peta → "Jadikan Tujuan", popup POI → "Jadikan Tujuan", riwayat & favorit → langsung rute.

### 4. Layout landscape
Dashboard kiri ≈ 33% / peta ≈ 67%. Panel kiri berupa CSS Grid ringkas (speedometer + kartu sensor, lean, odometer/Trip A/B, cuaca) dengan `overflow: hidden` — **tanpa scroll**; baris fleksibel sehingga semua info tampil dalam satu viewport pada 640×360, 667×375, 740×360, 800×360, 854×384. Saat navigasi aktif: banner belok besar di atas peta, bar bawah (belok berikutnya | ETA | jarak | kecepatan | Akhiri Navigasi). Warna: merah = identitas, biru = rute/navigasi, hijau = GPS valid, amber = peringatan.

### 5. PWA
Service worker men-*precache* per-file (`Promise.allSettled`) sehingga satu aset yang hilang tidak lagi menggagalkan install; modul baru, ikon, dan MapLibre (CDN) ikut di-cache untuk offline. Ikon root `icon-*.png` yang tidak pernah direferensikan (dan salah ukuran) dihapus; semua ikon yang dipakai ada di `assets/icons/`. Atribut HTML `hidden` kini selalu menang atas aturan `display` komponen.

### Pengujian
`tests/` berisi uji tanpa dependensi (`node tests/<nama>.test.mjs`): `orientation` (matematika sensor, portrait/landscape, kalibrasi, filter), `heading` (fusi), `nav` (segment, off-route, maneuver, arrival, suara), `static` (import/export, id elemen, variabel CSS, aset PWA, loading screen identik dengan aslinya).

## Arsitektur Engine

Project ini disusun sebagai kumpulan "engine" modular (tiap engine = satu file, satu tanggung jawab):

| Engine | File | Peran |
|---|---|---|
| GPS Engine | `gps.js` | Kalman filter, smoothing, quality, status, dead-reckoning |
| Motion Engine | `motion.js` + `orientation.js` | Orientasi layar, fusi accelerometer+gyroscope, kalibrasi mounting, roll/pitch |
| Heading Fusion | `heading.js` | `vehicleHeading` dari GPS bearing + kompas + kecepatan + confidence |
| Map Engine | `map.js` | Render peta, marker, search, kategori POI |
| Navigation Engine | `navigation.js` + `geo.js` | Rute alternatif, proyeksi segmen, progres/ETA, off-route adaptif, status tiba |
| Maneuver Engine | `maneuver.js` | Turn-by-turn: parsing langkah OSRM, state maneuver, teks & ikon |
| Voice Guidance | `voice.js` | Panduan suara (SpeechSynthesis) dengan anti-spam |
| Traffic Engine | `traffic.js` | Overlay lalu lintas live (Adapter Pattern: HERE/TomTom/Mapbox) |
| Weather Engine | `weather.js` | Cuaca minimalis (Open-Meteo, tanpa API key) |
| Ride Engine | `trip.js` | Odometer/trip, statistik sesi, riwayat berkendara harian |
| Storage Engine | `storage.js` | localStorage + IndexedDB, dipakai semua engine lain |
| UI Engine | `ui.js` | Status bar, toast, switching view, util debounce/throttle |
| — | `app.js` | Orkestrator: menghubungkan semua engine ke DOM |

Setiap engine punya API `.on(callback)` untuk event dan tidak saling mengimpor kecuali lewat kontrak publik yang jelas (mis. `navigation.js` memakai `map.js`'s `easeOutCubic` dan `route` source, `traffic.js` memakai `map.mapManager.map` untuk menambah layer sendiri) — supaya provider/algoritma di satu engine bisa diganti tanpa menyentuh engine lain.

### Traffic Engine — perlu API key sendiri

HERE/TomTom/Mapbox Traffic adalah layanan berbayar. Karena aplikasi ini statis (GitHub Pages, tanpa backend), key harus diisi sendiri di **Pengaturan → Traffic Engine** dan hanya tersimpan di localStorage browser Anda — tidak pernah dikirim ke pihak lain selain provider yang dipilih. Tanpa key, tombol traffic di peta akan menampilkan pesan untuk mengisi key dulu.

## Deploy ke GitHub Pages

1. Buat repo baru di GitHub, lalu push seluruh isi folder ini ke branch `main`.
2. Buka **Settings → Pages** pada repo, pilih source `main` branch, folder `/ (root)`.
3. Tunggu beberapa menit, aplikasi akan tersedia di `https://<username>.github.io/<repo>/`.
4. Buka URL tersebut di HP (Chrome/Safari) → gunakan menu browser **"Tambah ke Layar Utama" / "Install App"** agar berjalan sebagai PWA fullscreen.

PWA ini butuh HTTPS untuk Geolocation, Wake Lock, dan Service Worker — GitHub Pages sudah menyediakan HTTPS secara otomatis.

## Struktur Project

```
index.html        entry point + markup boot screen & dashboard
style.css          seluruh styling (tema TFT hitam/merah/silver)
app.js             entry module — menghubungkan semua modul
boot.js            animasi boot screen
gps.js             Geolocation API → kecepatan, altitude, akurasi
motion.js          DeviceOrientation (kompas) + DeviceMotion (kemiringan), kalibrasi
orientation.js     matematika sensor murni (normalisasi layar, mounting, filter)
heading.js         fusi heading → vehicleHeading
geo.js             util geometri: segmen, jarak kumulatif, bearing
maneuver.js        turn-by-turn (maneuver + state + ikon)
voice.js           panduan suara
theme.js           mode siang/malam (Otomatis berdasar matahari terbit/terbenam)
tests/             uji unit/statik (node)
speedometer.js      render gauge analog + digital (requestAnimationFrame)
trip.js            odometer & trip A/B (haversine + localStorage)
map.js             MapLibre GL + OpenStreetMap + Nominatim + Overpass + OSRM
ui.js              status bar, toast, navigasi antar-view
storage.js         localStorage + IndexedDB (riwayat perjalanan)
bluetooth.js       status Bluetooth ponsel (bukan koneksi ke motor)
settings.js        satuan, kecerahan, wake lock, reset data
manifest.json      manifest PWA
service-worker.js  offline cache (app shell + tile peta)
assets/            logo Honda, ikon PWA
```

## Keterbatasan platform browser (jujur & penting dibaca)

Beberapa data pada dashboard secara teknis **tidak tersedia** melalui API browser standar, jadi didekati sebagai berikut:

- **Jumlah satelit**: browser tidak pernah mengekspos angka satelit GNSS asli. Nilai yang tampil adalah **estimasi** dari akurasi GPS (chip GNSS asli pada HP tidak bisa diakses lewat web).
- **Kecerahan layar**: browser tidak bisa membaca/mengatur kecerahan fisik layar. Slider "Kecerahan" di Pengaturan hanya mensimulasikan efek gelap-terang lewat overlay pada UI, bukan mengubah brightness hardware.
- **Sensor kemiringan & kompas di iOS**: iOS 13+ mewajibkan izin eksplisit lewat ketukan layar (tidak bisa otomatis saat load). Aplikasi akan menampilkan toast "Ketuk layar untuk mengaktifkan sensor" pada perangkat yang membutuhkannya.
- **Kategori peta & pencarian** memanggil Nominatim/Overpass (data OpenStreetMap publik) dan OSRM demo router untuk garis rute — ketiganya API publik gratis dengan rate-limit; untuk penggunaan produksi/skala besar sebaiknya di-hosting sendiri.

## Kustomisasi

- Ganti `assets/images/honda-logo.png` dan file di `assets/icons/` bila ingin mengganti logo (jalankan ulang generator ikon dari gambar sumber jika perlu ukuran baru).
- Desain (layout ≈33/67 landscape, warna, tipografi) sengaja dikunci sesuai brief — ubah `style.css` dengan hati-hati bila ingin menyesuaikan.
