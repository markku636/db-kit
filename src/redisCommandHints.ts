// Redis 主控台的指令語法提示（redis-cli 風格：輸入指令名稱時在下方顯示參數格式）。
// 只收常用指令；語法照官方文件的寫法，[] 為選填、| 為擇一、... 為可重複。

export const REDIS_COMMAND_SYNTAX: Record<string, string> = {
  // 通用 / 鍵
  DEL: "key [key ...]",
  UNLINK: "key [key ...]",
  EXISTS: "key [key ...]",
  EXPIRE: "key seconds [NX | XX | GT | LT]",
  PEXPIRE: "key milliseconds [NX | XX | GT | LT]",
  EXPIREAT: "key unix-time-seconds [NX | XX | GT | LT]",
  PERSIST: "key",
  TTL: "key",
  PTTL: "key",
  TYPE: "key",
  RENAME: "key newkey",
  RENAMENX: "key newkey",
  COPY: "source destination [DB destination-db] [REPLACE]",
  SCAN: "cursor [MATCH pattern] [COUNT count] [TYPE type]",
  KEYS: "pattern",
  RANDOMKEY: "",
  DUMP: "key",
  OBJECT: "ENCODING | FREQ | IDLETIME | REFCOUNT key",
  MEMORY: "USAGE key [SAMPLES count] | STATS | DOCTOR",
  TOUCH: "key [key ...]",
  // 字串
  GET: "key",
  SET: "key value [NX | XX] [GET] [EX seconds | PX milliseconds | KEEPTTL]",
  SETNX: "key value",
  SETEX: "key seconds value",
  GETDEL: "key",
  GETEX: "key [EX seconds | PX milliseconds | PERSIST]",
  MGET: "key [key ...]",
  MSET: "key value [key value ...]",
  INCR: "key",
  INCRBY: "key increment",
  INCRBYFLOAT: "key increment",
  DECR: "key",
  DECRBY: "key decrement",
  APPEND: "key value",
  STRLEN: "key",
  GETRANGE: "key start end",
  SETRANGE: "key offset value",
  // Hash
  HGET: "key field",
  HSET: "key field value [field value ...]",
  HSETNX: "key field value",
  HMGET: "key field [field ...]",
  HGETALL: "key",
  HDEL: "key field [field ...]",
  HEXISTS: "key field",
  HKEYS: "key",
  HVALS: "key",
  HLEN: "key",
  HINCRBY: "key field increment",
  HSCAN: "key cursor [MATCH pattern] [COUNT count]",
  // List
  LPUSH: "key element [element ...]",
  RPUSH: "key element [element ...]",
  LPOP: "key [count]",
  RPOP: "key [count]",
  LRANGE: "key start stop",
  LLEN: "key",
  LINDEX: "key index",
  LSET: "key index element",
  LREM: "key count element",
  LTRIM: "key start stop",
  LMOVE: "source destination LEFT | RIGHT LEFT | RIGHT",
  BLPOP: "key [key ...] timeout",
  BRPOP: "key [key ...] timeout",
  // Set
  SADD: "key member [member ...]",
  SREM: "key member [member ...]",
  SMEMBERS: "key",
  SISMEMBER: "key member",
  SCARD: "key",
  SINTER: "key [key ...]",
  SUNION: "key [key ...]",
  SDIFF: "key [key ...]",
  SSCAN: "key cursor [MATCH pattern] [COUNT count]",
  // Sorted set
  ZADD: "key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]",
  ZREM: "key member [member ...]",
  ZRANGE: "key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]",
  ZREVRANGE: "key start stop [WITHSCORES]",
  ZRANGEBYSCORE: "key min max [WITHSCORES] [LIMIT offset count]",
  ZSCORE: "key member",
  ZRANK: "key member [WITHSCORE]",
  ZCARD: "key",
  ZCOUNT: "key min max",
  ZINCRBY: "key increment member",
  ZSCAN: "key cursor [MATCH pattern] [COUNT count]",
  // Stream
  XADD: "key [NOMKSTREAM] [MAXLEN | MINID [= | ~] threshold] * | id field value [field value ...]",
  XRANGE: "key start end [COUNT count]",
  XREVRANGE: "key end start [COUNT count]",
  XLEN: "key",
  XDEL: "key id [id ...]",
  XTRIM: "key MAXLEN | MINID [= | ~] threshold",
  XREAD: "[COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]",
  XINFO: "STREAM key | GROUPS key | CONSUMERS key group",
  XGROUP: "CREATE key group id | $ [MKSTREAM] | DESTROY key group",
  XPENDING: "key group [start end count [consumer]]",
  XACK: "key group id [id ...]",
  // 伺服器 / 其他
  PING: "[message]",
  INFO: "[section ...]",
  DBSIZE: "",
  CLIENT: "LIST | KILL ID client-id | SETNAME name | GETNAME",
  CONFIG: "GET parameter | SET parameter value",
  SLOWLOG: "GET [count] | LEN | RESET",
  FLUSHDB: "[ASYNC | SYNC]",
  FLUSHALL: "[ASYNC | SYNC]",
  PUBLISH: "channel message",
  EVAL: "script numkeys [key ...] [arg ...]",
  TIME: "",
  // RedisJSON（有裝模組才有）
  "JSON.GET": "key [path ...]",
  "JSON.SET": "key path value [NX | XX]",
};

/** 主控台的指令名稱提示：已打完整的指令給語法，打一半給候選。 */
export function redisCommandHint(input: string): { command: string | null; syntax: string | null; candidates: string[] } {
  // 去掉 `3:` 這種 DB 前綴；只看第一個字詞。
  const line = input.replace(/^\s*\d{1,18}:/, "").trimStart();
  const m = /^(\S+)(\s?)/.exec(line);
  if (!m) return { command: null, syntax: null, candidates: [] };
  const word = m[1].toUpperCase();
  const typedSpace = m[2] !== "";
  if (word in REDIS_COMMAND_SYNTAX) {
    return { command: word, syntax: REDIS_COMMAND_SYNTAX[word], candidates: [] };
  }
  if (typedSpace) return { command: null, syntax: null, candidates: [] };
  const candidates = Object.keys(REDIS_COMMAND_SYNTAX)
    .filter((c) => c.startsWith(word))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
  return { command: null, syntax: null, candidates };
}

/** Tab 補完：把第一個字詞換成唯一（或最短）的候選，保留 DB 前綴，後面加一個空白。 */
export function completeRedisCommand(input: string): string | null {
  const prefix = /^\s*\d{1,18}:/.exec(input)?.[0] ?? "";
  const rest = input.slice(prefix.length).trimStart();
  if (/\s/.test(rest)) return null; // 已經在打參數了
  const { candidates } = redisCommandHint(input);
  if (candidates.length === 0) return null;
  return `${prefix}${candidates[0]} `;
}

/** KEYS 會一次掃描整個 keyspace、期間 Redis 無法處理其他指令；主控台執行前要先確認。 */
export function isBlockingKeysCommand(cmd: string): boolean {
  return /^\s*(\d{1,18}:)?\s*keys\b/i.test(cmd);
}
