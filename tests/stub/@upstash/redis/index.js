// LOCAL TEST STUB ONLY - talks to a local redis-server (never Upstash). Optional:
//   BB_STRICT_KEYS=1        every redis.call inside EVAL must use a key from KEYS (Upstash REST rule) or the script fails
//   BB_TEST_REDIS_USER/PASS connect as a restricted ACL user (to make a command fail in the middle of a script)
import net from "node:net";
export const faults = (globalThis.__bbFaults ||= {});
export const stats = (globalThis.__bbStats ||= { evals: 0, undeclared: 0 });
class RespError extends Error {}
const port = () => Number(process.env.BB_TEST_REDIS_PORT || 6390);
function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) { const b = Buffer.from(String(a), "utf8"); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")); }
  return Buffer.concat(parts);
}
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const type = String.fromCharCode(buf[pos]);
  const end = buf.indexOf("\r\n", pos);
  if (end < 0) return null;
  const line = buf.toString("utf8", pos + 1, end);
  if (type === "+") return [line, end + 2];
  if (type === "-") return [new RespError(line), end + 2];
  if (type === ":") return [Number(line), end + 2];
  if (type === "$") { const n = Number(line); if (n < 0) return [null, end + 2]; if (buf.length < end + 2 + n + 2) return null; return [buf.toString("utf8", end + 2, end + 2 + n), end + 4 + n]; }
  if (type === "*") { const n = Number(line); if (n < 0) return [null, end + 2]; const arr = []; let p = end + 2; for (let i = 0; i < n; i++) { const r = parse(buf, p); if (!r) return null; arr.push(r[0]); p = r[1]; } return [arr, p]; }
  throw new Error("bad RESP " + type);
}
export function raw(args, asUser = true) {
  const user = asUser ? process.env.BB_TEST_REDIS_USER : null;
  const cmds = user ? [["AUTH", user, process.env.BB_TEST_REDIS_PASS], args] : [args];
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port: port(), host: "127.0.0.1" });
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let p = 0; const replies = [];
      for (let i = 0; i < cmds.length; i++) { const r = parse(buf, p); if (!r) return; replies.push(r[0]); p = r[1]; }
      s.end(); resolve(replies[replies.length - 1]);
    });
    s.on("error", reject);
    s.write(Buffer.concat(cmds.map(encode)));
  });
}
const STRICT_PRELUDE = `
local __declared = {}
for _, k in ipairs(KEYS) do __declared[k] = true end
local function __rc(cmd, key, ...)
  if key ~= nil and not __declared[key] then error('UNDECLARED KEY ' .. cmd .. ' ' .. tostring(key)) end
  return redis.call(cmd, key, ...)
end
`;
async function cmd(...a) { const r = await raw(a.map(String)); if (r instanceof RespError) throw new Error(r.message); return r; }
export class Redis {
  // Mirrors @upstash/redis: with { automaticDeserialization: false } (what the backend uses) results come back raw
  constructor(opts = {}) { this.rawResults = opts?.automaticDeserialization === false; }
  static fromEnv(opts) { return new Redis(opts); }
  async eval(script, keys, args) {
    stats.evals++;
    if (faults.beforeEval) await faults.beforeEval(script, keys, args);
    const s = process.env.BB_STRICT_KEYS === "1" ? STRICT_PRELUDE + script.replace(/redis\.call\(/g, "__rc(") : script;
    const r = await raw(["EVAL", s, keys.length, ...keys, ...args.map(String)]);
    if (r instanceof RespError) { if (/UNDECLARED KEY/.test(r.message)) stats.undeclared++; throw new Error(r.message); }
    if (faults.afterEval) await faults.afterEval(script, r);
    return r;
  }
  async get(k) { if (faults.beforeGet) await faults.beforeGet(k); return cmd("GET", k); }
  async set(k, v, o = {}) { const a = ["SET", k, v]; if (o.nx) a.push("NX"); if (o.ex) a.push("EX", o.ex); return cmd(...a); }
  async del(k) { return cmd("DEL", k); }
  async type(k) { return cmd("TYPE", k); }
  async ttl(k) { return cmd("TTL", k); }
  async scan(c, o = {}) { const a = ["SCAN", c]; if (o.match) a.push("MATCH", o.match); if (o.count) a.push("COUNT", o.count); return cmd(...a); }
  async smembers(k) { return cmd("SMEMBERS", k); }
  async zadd(k, { score, member }) { return cmd("ZADD", k, score, member); }
  async zremrangebyrank(k, a, b) { return cmd("ZREMRANGEBYRANK", k, a, b); }
  async lpush(k, v) { return cmd("LPUSH", k, v); }
  async ltrim(k, a, b) { return cmd("LTRIM", k, a, b); }
  async zincrby(k, n, m) { return cmd("ZINCRBY", k, n, m); }
  async hset(k, obj) { return cmd("HSET", k, ...Object.entries(obj).flat()); }
  async lrange(k, a, b) { return cmd("LRANGE", k, a, b); }
  // raw mode: flat array [field, value, ...] and [] for a missing key (exactly like Upstash); otherwise object / null
  async hgetall(k) { const r = await cmd("HGETALL", k); if (this.rawResults) return r; if (!r.length) return null; const o = {}; for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1]; return o; }
  async zrange(k, a, b, o = {}) {
    const args = ["ZRANGE", k, a, b];
    if (o.byScore) args.push("BYSCORE");
    if (o.rev) args.push("REV");
    if (o.count !== undefined) args.push("LIMIT", o.offset || 0, o.count);
    if (o.withScores) args.push("WITHSCORES");
    return cmd(...args);
  }
}
