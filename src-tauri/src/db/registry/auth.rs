//! Registry 認證：解析 `WWW-Authenticate` challenge、以帳密（或匿名）向 token 服務換 Bearer token，依 scope 快取。
//!
//! 流程（Docker Registry token auth spec）：請求 → 401 + `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`
//! → `GET realm?service=…&scope=…`（有帳密則帶 basic auth）→ `{token | access_token, expires_in}` → 帶 `Authorization: Bearer` 重送。
//! `Basic realm=…` 的 registry（自架 htpasswd）則直接每次帶 basic auth。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// 一個 challenge。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Challenge {
    Basic,
    Bearer { realm: String, service: String, scope: String },
}

/// 解析 `WWW-Authenticate` header。引號內可含逗號（`scope="repository:a:pull,push"`）。
pub fn parse_challenge(header: &str) -> Option<Challenge> {
    let h = header.trim();
    let (scheme, rest) = h.split_once(char::is_whitespace).unwrap_or((h, ""));
    match scheme.to_ascii_lowercase().as_str() {
        "basic" => Some(Challenge::Basic),
        "bearer" => {
            let params = parse_params(rest);
            let get = |k: &str| params.get(k).cloned().unwrap_or_default();
            let realm = get("realm");
            if realm.is_empty() {
                return None;
            }
            Some(Challenge::Bearer { realm, service: get("service"), scope: get("scope") })
        }
        _ => None,
    }
}

/// `k="v", k2=v2` → map（鍵小寫）。
fn parse_params(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i] == b',' || b[i].is_ascii_whitespace()) {
            i += 1;
        }
        let ks = i;
        while i < b.len() && b[i] != b'=' && b[i] != b',' {
            i += 1;
        }
        let key = s[ks..i].trim().to_ascii_lowercase();
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        let val = if i < b.len() && b[i] == b'"' {
            i += 1;
            let mut v = String::new();
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' && i + 1 < b.len() {
                    i += 1;
                }
                // 值只含 ASCII 以外字元時逐 byte 推會破壞 UTF-8：改以 char 邊界取。
                let ch_len = utf8_len(b[i]);
                v.push_str(&s[i..i + ch_len]);
                i += ch_len;
            }
            i += 1;
            v
        } else {
            let vs = i;
            while i < b.len() && b[i] != b',' {
                i += 1;
            }
            s[vs..i].trim().to_string()
        };
        if !key.is_empty() {
            out.insert(key, val);
        }
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0xF0..=0xFF => 4,
        0xE0..=0xEF => 3,
        0xC0..=0xDF => 2,
        _ => 1,
    }
}

/// 依 scope 快取的 Bearer token。
#[derive(Default)]
pub struct TokenCache {
    inner: Mutex<HashMap<String, (String, Instant)>>,
}

impl TokenCache {
    pub fn get(&self, scope: &str) -> Option<String> {
        let map = self.inner.lock();
        map.get(scope).filter(|(_, exp)| *exp > Instant::now()).map(|(t, _)| t.clone())
    }

    /// `expires_in` 秒（預設 60；提早 10 秒過期避免邊界失效）。
    pub fn put(&self, scope: &str, token: String, expires_in: u64) {
        let ttl = Duration::from_secs(expires_in.max(20).saturating_sub(10));
        self.inner.lock().insert(scope.to_string(), (token, Instant::now() + ttl));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_challenge_with_commas_in_scope() {
        let c = parse_challenge(
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull,push""#,
        )
        .unwrap();
        assert_eq!(
            c,
            Challenge::Bearer {
                realm: "https://auth.docker.io/token".into(),
                service: "registry.docker.io".into(),
                scope: "repository:library/nginx:pull,push".into(),
            }
        );
    }

    #[test]
    fn bearer_without_scope_and_unquoted() {
        let c = parse_challenge("bearer realm=https://h/service/token, service=harbor-registry").unwrap();
        assert_eq!(
            c,
            Challenge::Bearer { realm: "https://h/service/token".into(), service: "harbor-registry".into(), scope: String::new() }
        );
    }

    #[test]
    fn basic_and_garbage() {
        assert_eq!(parse_challenge(r#"Basic realm="Registry Realm""#), Some(Challenge::Basic));
        assert_eq!(parse_challenge("Bearer service=x"), None);
        assert_eq!(parse_challenge("Negotiate abc"), None);
    }

    #[test]
    fn token_cache_expiry() {
        let c = TokenCache::default();
        c.put("s", "tok".into(), 300);
        assert_eq!(c.get("s").as_deref(), Some("tok"));
        assert_eq!(c.get("other"), None);
    }
}
