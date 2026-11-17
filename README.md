# BagiBagi.co → Roblox Donation System (Vercel)

Paket ini berisi backend webhook BagiBagi, endpoint feed privat untuk Roblox, dan dua script Roblox. Sistem memakai Vercel Functions + Upstash Redis. Nominal donasi disimpan sebagai IDR.

## Penting sebelum mulai

- Webhook BagiBagi yang resmi mengirim `POST application/json` dengan field `transaction_id`, `name`, `amount`, `message`, `mediaShareUrl`, `created_at`.
- Signature diverifikasi dari header `X-Bagibagi-Signature` menggunakan HMAC-SHA256 dan Webhook Token BagiBagi.
- Jangan menaruh token BagiBagi atau API key backend di LocalScript.
- Avatar podium hanya bisa dicoba jika donatur menulis username Roblox dengan format `@Username` pada pesan donasi. Nama donatur biasa tidak otomatis bisa dipastikan sebagai username Roblox.
- Paket ini tidak menghubungkan donasi ke pembelian Robux atau Developer Products. Ini hanya notifikasi dukungan eksternal.

## A. Deploy backend ke Vercel

1. Buat database Redis di Upstash: https://upstash.com/
2. Catat `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`.
3. Buat project GitHub baru dan upload seluruh isi folder paket ini ke root repository.
4. Import repository tersebut ke https://vercel.com/ lalu Deploy.
5. Di Vercel buka Project → Settings → Environment Variables.
6. Tambahkan empat environment variables berikut untuk Production (dan Preview jika akan menguji Preview):

| Name | Value |
|---|---|
| `BAGIBAGI_WEBHOOK_TOKEN` | Webhook Token dari halaman integrasi akun BagiBagi |
| `ROBLOX_API_KEY` | Rahasia acak panjang yang kamu buat sendiri |
| `UPSTASH_REDIS_REST_URL` | REST URL dari Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | REST token dari Upstash |

7. Redeploy setelah semua environment variables disimpan.
8. Ganti URL placeholder pada `roblox/DonationServer.server.lua` dengan URL project Vercel milikmu:
   `https://NAMA-PROJECT.vercel.app/api/roblox`

### Membuat API key yang kuat

Di terminal komputer yang memiliki Node.js, jalankan:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Gunakan hasilnya sebagai `ROBLOX_API_KEY` di Vercel. Simpan hasil yang sama sebagai Roblox Secret pada langkah C. Jangan kirimkan nilainya ke orang lain.

### Deploy memakai Vercel CLI (alternatif GitHub)

Di dalam folder project jalankan:

```bash
npm install
npm install -g vercel
vercel
vercel --prod
```

Atur environment variables di dashboard dan lakukan redeploy.

## B. Pasang webhook BagiBagi

1. Login ke BagiBagi.co.
2. Buka Stream Overlay → tab Integration Page.
3. Cari bagian Custom Webhook URL / Webhook Integration.
4. Masukkan:
   `https://NAMA-PROJECT.vercel.app/api/webhook`
5. Simpan.
6. Buka tab Integrasi Akun dan salin Webhook Token.
7. Masukkan token tersebut ke Vercel sebagai `BAGIBAGI_WEBHOOK_TOKEN`, lalu redeploy.

Jangan memakai Webhook Token sebagai API key Roblox. Keduanya adalah rahasia yang berbeda.

## C. Siapkan Roblox Secret

1. Buka Creator Dashboard dan pilih experience yang benar.
2. Buka konfigurasi experience / Secrets.
3. Tambahkan Secret dengan nama persis:
   `BAGIBAGI_API_KEY`
4. Isi value dengan nilai yang sama persis seperti `ROBLOX_API_KEY` di Vercel.
5. Publish experience.

Jika menu Secrets belum tersedia untuk experience atau akunmu, cek dokumentasi Roblox Secrets. Jangan menaruh API key pada LocalScript. Untuk tes sementara, jangan publikasikan script dengan key hard-coded.

## D. Pasang script Roblox

1. Buka place di Roblox Studio.
2. Buka View → Explorer dan Properties.
3. Di Explorer, buka ServerScriptService.
4. Tambahkan Script bernama `DonationServer`.
5. Salin isi `roblox/DonationServer.server.lua` ke Script tersebut.
6. Ganti `YOUR-VERCEL-PROJECT` dengan subdomain Vercel milikmu.
7. Buka StarterPlayer → StarterPlayerScripts.
8. Tambahkan LocalScript bernama `DonationClient`.
9. Salin isi `roblox/DonationClient.client.lua` ke LocalScript.
10. Buka File → Game Settings → Security.
11. Aktifkan Allow HTTP Requests.
12. Publish / Update experience.

## E. Atur posisi papan dan podium

Script akan memakai dua Part yang sudah ada di Workspace, atau membuat posisi default jika Part belum dibuat. Agar posisi tersimpan di map, buat keduanya secara manual dalam mode edit:

1. Di Workspace, Insert Object → Part.
2. Rename menjadi `DonationAlertAnchor`.
3. Atur Anchored = true, CanCollide = false, Transparency = 1, Size = 1,1,1.
4. Pindahkan ke lokasi tempat Billboard alert 3D ingin ditampilkan.
5. Buat Part kedua bernama `DonationPodiumAnchor`.
6. Atur properti yang sama dan pindahkan ke pusat area podium.
7. Publish / Update experience.

Podium memakai avatar Roblox sungguhan. Minta donatur menulis `@UsernameRoblox` di pesan donasi. Contoh:
`Semangat map-nya! @NamaRoblox`

Jika username tidak valid atau tidak ditulis, podium tetap menampilkan nama dan total donasi, tetapi tanpa avatar.

## F. Tes integrasi

1. Buka URL `https://NAMA-PROJECT.vercel.app/api/roblox` di browser. Respons `401 Unauthorized` adalah hasil yang diharapkan karena endpoint feed diproteksi.
2. Pastikan endpoint webhook di Vercel aktif dengan metode POST; membuka URL webhook dengan browser (GET) akan menghasilkan `405 Method not allowed`.
3. Gunakan fitur test webhook resmi BagiBagi jika tersedia, atau lakukan donasi percobaan yang benar-benar berhasil.
4. Buka Roblox Studio → View → Output.
5. Jalankan experience. Perhatikan log `[DonationSystem]`.
6. Jika webhook diterima, dalam sekitar 8 detik notifikasi akan muncul di GUI dan Billboard dunia, partikel menyala, riwayat dan leaderboard diperbarui.
7. Uji juga dengan server Roblox yang sudah dipublikasikan, karena Secrets dan perilaku HTTP perlu diuji pada experience yang dipublish.

## G. Struktur file

```text
api/
  webhook.js       # menerima + memverifikasi webhook BagiBagi
  roblox.js        # endpoint feed privat untuk Roblox
roblox/
  DonationServer.server.lua
  DonationClient.client.lua
package.json
README.md
```

## H. Troubleshooting

- **Webhook 401**: Webhook Token salah, signature tidak cocok, atau body webhook tidak sesuai format BagiBagi.
- **Webhook 500**: cek environment variables Upstash dan Function Logs di Vercel.
- **Roblox 401**: `ROBLOX_API_KEY` di Vercel tidak sama dengan Secret `BAGIBAGI_API_KEY` di Roblox.
- **Roblox tidak bisa HTTP**: aktifkan Allow HTTP Requests dan pastikan URL memakai HTTPS.
- **Alert tidak muncul**: cek Output, URL endpoint, API key, dan pastikan transaksi sukses.
- **Avatar tidak tampil**: pesan donasi harus memuat `@UsernameRoblox` yang valid.
- **Data tidak tersimpan**: periksa Redis REST URL/token dan log Vercel.

## Catatan teknis

- Feed menyimpan maksimal 500 transaksi terbaru; riwayat menyimpan maksimal 100.
- Leaderboard menggabungkan donasi berdasarkan nama donatur yang dinormalisasi menjadi huruf kecil. Dua orang dengan nama sama dapat tergabung.
- Endpoint Roblox mengirim maksimal 100 transaksi baru per polling.
- Polling default 8 detik per server game. Bila game ramai dengan banyak server, pertimbangkan antrean terdistribusi dan pembatasan konsumsi per server agar satu transaksi tidak diumumkan berulang kali di semua server.
- Implementasi ini adalah fondasi siap dipasang, tetapi perlu diuji dengan webhook nyata dari akun BagiBagi sebelum dipakai publik.
