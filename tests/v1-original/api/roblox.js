import { Redis } from "@upstash/redis";
import { timingSafeEqual } from "node:crypto";

const redis = Redis.fromEnv();

function reply(res, status, data) {
  return res.status(status).json(data);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function parseDonation(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const expectedKey = process.env.ROBLOX_API_KEY;
  const suppliedKey = req.headers["x-api-key"];

  if (!expectedKey || !safeEqual(String(suppliedKey || ""), expectedKey)) {
    return reply(res, 401, { error: "Unauthorized" });
  }

  try {
    const rawSince = Number(req.query.since ?? 0);
    const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : Date.now();

    const [rawFeed, rawTop, rawHistory] = await Promise.all([
      redis.zrange("bb:feed", since, "+inf", {
        byScore: true,
        offset: 0,
        count: 100
      }),
      redis.zrange("bb:donors", 0, 9, {
        rev: true,
        withScores: true
      }),
      redis.lrange("bb:history", 0, 19)
    ]);

    const donations = rawFeed.map(parseDonation).filter(Boolean);

    const leaderboard = [];
    for (let i = 0; i < rawTop.length; i += 2) {
      const donorKey = String(rawTop[i]);
      const total = Number(rawTop[i + 1]);
      const profile = await redis.hgetall(`bb:donor:${donorKey}`);

      leaderboard.push({
        name: String(profile?.name || "Donatur"),
        robloxUsername: String(profile?.robloxUsername || ""),
        total: Number.isFinite(total) ? total : 0
      });
    }

    const history = rawHistory.map(parseDonation).filter(Boolean);

    res.setHeader("Cache-Control", "no-store");
    return reply(res, 200, {
      ok: true,
      serverTime: Date.now(),
      donations,
      leaderboard,
      history
    });
  } catch (error) {
    console.error("Roblox feed error:", error);
    return reply(res, 500, { error: "Could not read donation data" });
  }
}
