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
motion.js          DeviceOrientation (kompas) + DeviceMotion (kemiringan)
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
- Desain (layout 40/60, warna, tipografi) sengaja dikunci sesuai brief — ubah `style.css` dengan hati-hati bila ingin menyesuaikan.
