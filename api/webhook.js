import { Redis } from "@upstash/redis";
import { createHmac, timingSafeEqual } from "node:crypto";

const redis = Redis.fromEnv();

function reply(res, status, data) {
  return res.status(status).json(data);
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validSignature(body, token, signature) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  // This follows BagiBagi's documented Node.js example:
  // HMAC-SHA256(JSON.stringify(parsedBody), webhookToken).
  const expected = createHmac("sha256", token)
    .update(JSON.stringify(body))
    .digest();

  const received = Buffer.from(signature, "hex");
  return received.length === expected.length &&
    timingSafeEqual(received, expected);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const webhookToken = process.env.BAGIBAGI_WEBHOOK_TOKEN;
  if (!webhookToken) {
    return reply(res, 500, { error: "Webhook is not configured" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply(res, 400, { error: "Invalid JSON body" });
  }

  const signature = req.headers["x-bagibagi-signature"];
  if (!validSignature(body, webhookToken, signature)) {
    return reply(res, 401, { error: "Invalid BagiBagi signature" });
  }

  const transactionId = cleanText(body.transaction_id, 120);
  const donorName = cleanText(body.name, 40) || "Donatur";
  const amount = Number(body.amount);
  const message = cleanText(body.message, 180);

  if (!transactionId || !Number.isSafeInteger(amount) || amount <= 0) {
    return reply(res, 400, { error: "Invalid transaction fields" });
  }

  // Ask donors to include their Roblox username in the message as @Username.
  // This is optional; it is used only for the 3D avatar podium.
  const usernameMatch = message.match(/(?:^|\s)@([A-Za-z0-9_]{3,20})(?=$|\s)/);
  const robloxUsername = usernameMatch ? usernameMatch[1] : null;

  const donation = {
    id: transactionId,
    name: donorName,
    amount,
    message,
    robloxUsername,
    createdAt: cleanText(body.created_at, 60),
    receivedAt: Date.now()
  };

  const idempotencyKey = `bb:processed:${transactionId}`;

  try {
    // NX prevents the same webhook transaction being counted twice.
    const firstDelivery = await redis.set(idempotencyKey, "1", {
      nx: true,
      ex: 60 * 60 * 24 * 365
    });

    if (!firstDelivery) {
      return reply(res, 200, { ok: true, duplicate: true });
    }

    const donorKey = Buffer.from(donorName.toLowerCase(), "utf8").toString("base64url");

    await redis.zadd("bb:feed", {
      score: donation.receivedAt,
      member: JSON.stringify(donation)
    });
    await redis.zremrangebyrank("bb:feed", 0, -501);

    await redis.lpush("bb:history", JSON.stringify(donation));
    await redis.ltrim("bb:history", 0, 99);

    await redis.zincrby("bb:donors", amount, donorKey);
    await redis.hset(`bb:donor:${donorKey}`, {
      name: donorName,
      robloxUsername: robloxUsername || ""
    });

    return reply(res, 200, { ok: true, accepted: true });
  } catch (error) {
    // Let BagiBagi retry if storage failed after the idempotency key was set.
    try {
      await redis.del(idempotencyKey);
    } catch (_) {}

    console.error("BagiBagi webhook storage error:", error);
    return reply(res, 500, { error: "Could not store donation" });
  }
}
