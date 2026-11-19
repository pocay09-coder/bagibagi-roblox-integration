
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = Redis.fromEnv({
  automaticDeserialization: false
});

// Keamanan: pastikan URL database staging.
const host = new URL(process.env.UPSTASH_REDIS_REST_URL).hostname;
const fingerprint = createHash("sha256")
  .update(host).digest("hex").slice(0, 12);

if (fingerprint !== "e309d6250699") {
  console.error("STOP: Database bukan staging yang diverifikasi.");
  process.exit(1);
}

const sums = new Map();
const counts = new Map();
let cursor = "0";

do {
  const [next, keys] = await redis.scan(cursor, {
    match: "bb:tx:*",
    count: 500
  });
  cursor = String(next);

  for (const key of keys) {
    const raw = await redis.hgetall(key);

const tx = Array.isArray(raw)
  ? Object.fromEntries(
      Array.from(
        { length: Math.floor(raw.length / 2) },
        (_, i) => [String(raw[i * 2]), raw[i * 2 + 1]]
      )
    )
  : raw;
console.log("Tipe data:", typeof tx);
console.log("Apakah array:", Array.isArray(tx));
console.log("Apakah null:", tx === null);
console.log("Nama field:", tx && typeof tx === "object"
  ? Object.keys(tx).map((_, i) => `field_${i + 1}`)
  : "Tidak berupa objek");
console.log("Transaksi memiliki member:", Boolean(tx?.member), "| Status:", tx?.status ?? "kosong", "| Amount valid:", Number.isFinite(Number(tx?.amount)));
    if (!tx || !tx.member) continue;

    const member = String(tx.member);
    sums.set(member,
      (sums.get(member) || 0) + Number(tx.amount || 0));
    counts.set(member, (counts.get(member) || 0) + 1);
  }
} while (cursor !== "0");

const rank = await redis.zrange("bb:rank", 0, -1, {
  withScores: true
});

const ranked = new Set();
let mismatch = 0;

for (let i = 0; i < rank.length; i += 2) {
  const member = String(rank[i]);
  const score = Number(rank[i + 1]);
  const ledger = sums.get(member) || 0;
  ranked.add(member);

  if (Math.abs(score - ledger) > 0.0001) {
    mismatch++;
    console.log(`Donatur #${i / 2 + 1}: ranking=${score}, ledger=${ledger}, transaksi=${counts.get(member) || 0}, selisih=${score - ledger}`);
  }
}

for (const [member, total] of sums) {
  if (total > 0 && !ranked.has(member)) {
    mismatch++;
    console.log(`Ledger tanpa ranking: total=${total}, transaksi=${counts.get(member) || 0}`);
  }
}

console.log(`Total ketidaksesuaian: ${mismatch}`);
console.log("Pemeriksaan selesai (READ-ONLY).");
