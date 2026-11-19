
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = Redis.fromEnv({
  automaticDeserialization: false
});

// Pengamanan: pastikan database adalah staging
const host = new URL(
  process.env.UPSTASH_REDIS_REST_URL
).hostname;

const fingerprint = createHash("sha256")
  .update(host)
  .digest("hex")
  .slice(0, 12);

if (fingerprint !== "e309d6250699") {
  console.error("STOP: Database bukan staging yang diverifikasi.");
  process.exit(1);
}

console.log("Database staging terverifikasi:", fingerprint);

// Pemeriksaan ranking
const rank = await redis.zrange("bb:rank", 0, -1, {
  withScores: true
});

console.log("Jumlah elemen:", rank.length);
console.log("Jumlah pasangan:", rank.length / 2);
console.log("Tipe elemen pertama:", typeof rank[0]);
console.log("Tipe elemen kedua:", typeof rank[1]);
console.log(
  "Skor pertama valid:",
  Number.isFinite(Number(rank[1]))
);
console.log("Elemen pertama object:", typeof rank[0] === "object");
