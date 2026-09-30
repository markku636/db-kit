//! kubeconfig 讀取與連線設定 → 叢集端點 / 認證解析。
//!
//! 兩種來源（`k8s_source` option）：
//! - `kubeconfig`（預設）：`k8s_kubeconfig` 指定檔案路徑；空白 = `KUBECONFIG` 環境變數（可多個檔案，
//!   Windows 以 `;`、其餘以 `:` 分隔，同名項目先出現者優先，與 kubectl 相同），再退回 `~/.kube/config`。
//!   `k8s_context` 選 context，空白 = `current-context`。檔內相對路徑以該 kubeconfig 所在資料夾為準。
//! - `manual`：`host` 欄填 API server 網址；`password` 欄（存 OS keychain）放 Bearer token；
//!   `k8s_tls_ca` / `k8s_tls_cert` / `k8s_tls_key`（PEM 內文或檔案路徑）、`k8s_tls_insecure`。
//!
//! 認證支援：token、tokenFile、用戶端憑證（檔案或 *-data）、帳密（basic）、exec plugin
//! （aws eks get-token、gke-gcloud-auth-plugin、kubelogin…；見 `auth.rs`），以及舊式 auth-provider 的
//! `id-token` / `access-token`（不做 refresh）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::db::http_tls::{opt, opt_bool, read_pem};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

// ---- kubeconfig 檔案格式（只取用得到的欄位；未知欄位忽略）----

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Kubeconfig {
    #[serde(default)]
    pub clusters: Vec<Named<Cluster>>,
    #[serde(default)]
    pub users: Vec<NamedUser>,
    #[serde(default)]
    pub contexts: Vec<Named<Context>>,
    #[serde(rename = "current-context", default)]
    pub current_context: String,
    /// 解析時記下各項目來自哪個檔案（相對路徑要以該檔所在資料夾為基準）。
    #[serde(skip)]
    pub origin: HashMap<String, PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Named<T> {
    pub name: String,
    #[serde(alias = "cluster", alias = "context")]
    pub value: Option<T>,
}

/// users 的項目鍵名是 `user`（Named 的 alias 不能共用 `cluster` / `context`，另立一型）。
#[derive(Debug, Clone, Deserialize)]
pub struct NamedUser {
    pub name: String,
    pub user: Option<User>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Cluster {
    #[serde(default)]
    pub server: String,
    #[serde(rename = "certificate-authority")]
    pub certificate_authority: Option<String>,
    #[serde(rename = "certificate-authority-data")]
    pub certificate_authority_data: Option<String>,
    #[serde(rename = "insecure-skip-tls-verify", default)]
    pub insecure_skip_tls_verify: bool,
    #[serde(rename = "tls-server-name")]
    pub tls_server_name: Option<String>,
    #[serde(rename = "proxy-url")]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Context {
    #[serde(default)]
    pub cluster: String,
    #[serde(default)]
    pub user: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct User {
    pub token: Option<String>,
    #[serde(rename = "tokenFile")]
    pub token_file: Option<String>,
    #[serde(rename = "client-certificate")]
    pub client_certificate: Option<String>,
    #[serde(rename = "client-certificate-data")]
    pub client_certificate_data: Option<String>,
    #[serde(rename = "client-key")]
    pub client_key: Option<String>,
    #[serde(rename = "client-key-data")]
    pub client_key_data: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub exec: Option<ExecConfig>,
    #[serde(rename = "auth-provider")]
    pub auth_provider: Option<AuthProvider>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExecConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<ExecEnv>,
    #[serde(rename = "apiVersion", default)]
    pub api_version: String,
    #[serde(rename = "provideClusterInfo", default)]
    pub provide_cluster_info: bool,
    #[serde(rename = "installHint")]
    pub install_hint: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExecEnv {
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct AuthProvider {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub config: HashMap<String, String>,
}

// ---- 解析結果 ----

/// 已解析的使用者認證（可同時有多種：例如 exec + 用戶端憑證）。
#[derive(Debug, Default, Clone)]
pub struct UserAuth {
    pub token: Option<String>,
    pub token_file: Option<PathBuf>,
    pub client_cert_pem: Option<Vec<u8>>,
    pub client_key_pem: Option<Vec<u8>>,
    pub basic: Option<(String, String)>,
    pub exec: Option<ExecConfig>,
    /// exec plugin 的工作目錄（kubeconfig 所在資料夾；相對 command 以此解析）。
    pub exec_dir: Option<PathBuf>,
}

/// 連到一個叢集所需的一切。
#[derive(Debug, Clone)]
pub struct ClusterSpec {
    /// API server 網址（`https://h:6443[/prefix]`）。
    pub server: String,
    pub ca_pem: Option<Vec<u8>>,
    pub insecure: bool,
    pub tls_server_name: Option<String>,
    pub proxy_url: Option<String>,
    /// context 預設 namespace。
    pub namespace: Option<String>,
    pub user: UserAuth,
    /// 顯示用：`context 名稱` 或手動模式的 server。
    pub label: String,
}

/// 對話框用：kubeconfig 裡的一個 context。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: String,
    pub server: String,
    pub current: bool,
    /// 認證方式摘要（token / cert / exec:aws …）。
    pub auth: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KubeconfigInfo {
    /// 實際讀到的檔案。
    pub files: Vec<String>,
    pub current_context: String,
    pub contexts: Vec<ContextInfo>,
}

/// 預設 kubeconfig 路徑清單（`KUBECONFIG` → `~/.kube/config`）。
pub fn default_paths() -> Vec<PathBuf> {
    if let Some(v) = std::env::var_os("KUBECONFIG") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let list: Vec<PathBuf> = v
            .to_string_lossy()
            .split(sep)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    match home_dir() {
        Some(h) => vec![h.join(".kube").join("config")],
        None => Vec::new(),
    }
}

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(h) = home_dir() {
            return h.join(rest);
        }
    }
    PathBuf::from(p)
}

/// `k8s_kubeconfig` option → 路徑清單（可用 `;` 分隔多個檔案）。
pub fn paths_from(value: Option<&str>) -> Vec<PathBuf> {
    match value {
        Some(v) => v.split(';').map(str::trim).filter(|s| !s.is_empty()).map(expand_home).collect(),
        None => default_paths(),
    }
}

/// 解析一份 kubeconfig 內文。
pub fn parse(text: &str) -> AppResult<Kubeconfig> {
    if text.trim().is_empty() {
        return Ok(Kubeconfig::default());
    }
    serde_yaml::from_str(text).map_err(|e| AppError::Connect(tf!("kubeconfig 格式不正確：{e}", e = e)))
}

/// 讀取並合併多個 kubeconfig（同名 cluster / user / context 先出現者優先；current-context 取第一個非空的）。
pub fn load(paths: &[PathBuf]) -> AppResult<(Kubeconfig, Vec<PathBuf>)> {
    let mut merged = Kubeconfig::default();
    let mut read = Vec::new();
    for p in paths {
        let text = match std::fs::read_to_string(p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && paths.len() > 1 => continue,
            Err(e) => {
                return Err(AppError::Connect(tf!("讀取 kubeconfig 失敗（{path}）：{e}", path = p.display(), e = e)));
            }
        };
        let kc = parse(&text).map_err(|e| match e {
            AppError::Connect(m) => AppError::Connect(format!("{m}（{}）", p.display())),
            other => other,
        })?;
        let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
        for c in kc.clusters {
            if !merged.clusters.iter().any(|x| x.name == c.name) {
                merged.origin.insert(format!("cluster:{}", c.name), dir.clone());
                merged.clusters.push(c);
            }
        }
        for u in kc.users {
            if !merged.users.iter().any(|x| x.name == u.name) {
                merged.origin.insert(format!("user:{}", u.name), dir.clone());
                merged.users.push(u);
            }
        }
        for c in kc.contexts {
            if !merged.contexts.iter().any(|x| x.name == c.name) {
                merged.contexts.push(c);
            }
        }
        if merged.current_context.is_empty() {
            merged.current_context = kc.current_context;
        }
        read.push(p.clone());
    }
    if read.is_empty() {
        let list = paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("; ");
        return Err(AppError::Connect(tf!("找不到 kubeconfig（{paths}）", paths = list)));
    }
    Ok((merged, read))
}

impl Kubeconfig {
    fn cluster(&self, name: &str) -> Option<&Cluster> {
        self.clusters.iter().find(|c| c.name == name).and_then(|c| c.value.as_ref())
    }
    fn user(&self, name: &str) -> Option<&User> {
        self.users.iter().find(|u| u.name == name).and_then(|u| u.user.as_ref())
    }
    fn context(&self, name: &str) -> Option<&Context> {
        self.contexts.iter().find(|c| c.name == name).and_then(|c| c.value.as_ref())
    }
    fn dir(&self, key: &str) -> PathBuf {
        self.origin.get(key).cloned().unwrap_or_default()
    }

    /// 對話框的 context 清單。
    pub fn context_infos(&self) -> Vec<ContextInfo> {
        self.contexts
            .iter()
            .map(|c| {
                let ctx = c.value.clone().unwrap_or_default();
                let server = self.cluster(&ctx.cluster).map(|x| x.server.clone()).unwrap_or_default();
                let auth = self.user(&ctx.user).map(auth_summary).unwrap_or_default();
                ContextInfo {
                    name: c.name.clone(),
                    cluster: ctx.cluster,
                    user: ctx.user,
                    namespace: ctx.namespace.unwrap_or_default(),
                    server,
                    current: c.name == self.current_context,
                    auth,
                }
            })
            .collect()
    }

    /// 選定 context → ClusterSpec。`context` 空白 = current-context。
    pub fn resolve(&self, context: Option<&str>) -> AppResult<ClusterSpec> {
        let name = match context {
            Some(c) => c.to_string(),
            None if !self.current_context.is_empty() => self.current_context.clone(),
            None if self.contexts.len() == 1 => self.contexts[0].name.clone(),
            None => return Err(AppError::Connect(t!("kubeconfig 沒有設定 current-context，請在連線設定選擇 context").into())),
        };
        let ctx = self
            .context(&name)
            .ok_or_else(|| AppError::Connect(tf!("kubeconfig 裡找不到 context「{name}」", name = name)))?;
        let cluster = self.cluster(&ctx.cluster).ok_or_else(|| {
            AppError::Connect(tf!("context「{ctx}」指向的 cluster「{c}」不存在", ctx = name, c = ctx.cluster))
        })?;
        if cluster.server.trim().is_empty() {
            return Err(AppError::Connect(tf!("cluster「{c}」沒有設定 server", c = ctx.cluster)));
        }
        let cdir = self.dir(&format!("cluster:{}", ctx.cluster));
        let ca_pem = match (&cluster.certificate_authority_data, &cluster.certificate_authority) {
            (Some(d), _) if !d.trim().is_empty() => Some(b64(d, &t!("certificate-authority-data"))?),
            (_, Some(p)) if !p.trim().is_empty() => Some(read_rel(&cdir, p, &t!("CA 憑證"))?),
            _ => None,
        };
        let user = match self.user(&ctx.user) {
            Some(u) => resolve_user(u, &self.dir(&format!("user:{}", ctx.user)))?,
            // 沒有 user（或 user 名稱空白）：匿名。
            None => UserAuth::default(),
        };
        Ok(ClusterSpec {
            server: cluster.server.trim().to_string(),
            ca_pem,
            insecure: cluster.insecure_skip_tls_verify,
            tls_server_name: cluster.tls_server_name.clone().filter(|s| !s.trim().is_empty()),
            proxy_url: cluster.proxy_url.clone().filter(|s| !s.trim().is_empty()),
            namespace: ctx.namespace.clone().filter(|s| !s.trim().is_empty()),
            user,
            label: name,
        })
    }
}

fn auth_summary(u: &User) -> String {
    if let Some(e) = &u.exec {
        let cmd = Path::new(&e.command).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        return format!("exec:{cmd}");
    }
    if let Some(p) = &u.auth_provider {
        return format!("auth-provider:{}", p.name);
    }
    if u.client_certificate.is_some() || u.client_certificate_data.is_some() {
        return "cert".into();
    }
    if u.token.is_some() || u.token_file.is_some() {
        return "token".into();
    }
    if u.username.is_some() {
        return "basic".into();
    }
    String::new()
}

fn b64(data: &str, what: &str) -> AppResult<Vec<u8>> {
    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(clean)
        .map_err(|e| AppError::Connect(tf!("{what} 不是有效的 base64：{e}", what = what, e = e)))
}

fn rel(dir: &Path, p: &str) -> PathBuf {
    let path = expand_home(p.trim());
    if path.is_absolute() || dir.as_os_str().is_empty() {
        path
    } else {
        dir.join(path)
    }
}

fn read_rel(dir: &Path, p: &str, what: &str) -> AppResult<Vec<u8>> {
    let path = rel(dir, p);
    std::fs::read(&path)
        .map_err(|e| AppError::Connect(tf!("讀取{what}失敗（{path}）：{e}", what = what, path = path.display(), e = e)))
}

fn resolve_user(u: &User, dir: &Path) -> AppResult<UserAuth> {
    let mut out = UserAuth::default();
    out.token = u.token.clone().filter(|s| !s.trim().is_empty());
    out.token_file = u.token_file.as_deref().filter(|s| !s.trim().is_empty()).map(|p| rel(dir, p));
    out.client_cert_pem = match (&u.client_certificate_data, &u.client_certificate) {
        (Some(d), _) if !d.trim().is_empty() => Some(b64(d, "client-certificate-data")?),
        (_, Some(p)) if !p.trim().is_empty() => Some(read_rel(dir, p, &t!("用戶端憑證"))?),
        _ => None,
    };
    out.client_key_pem = match (&u.client_key_data, &u.client_key) {
        (Some(d), _) if !d.trim().is_empty() => Some(b64(d, "client-key-data")?),
        (_, Some(p)) if !p.trim().is_empty() => Some(read_rel(dir, p, &t!("用戶端私鑰"))?),
        _ => None,
    };
    if let (Some(n), Some(p)) = (&u.username, &u.password) {
        if !n.is_empty() {
            out.basic = Some((n.clone(), p.clone()));
        }
    }
    if let Some(e) = &u.exec {
        let mut e = e.clone();
        // 相對路徑的 command（含路徑分隔字元者）以 kubeconfig 所在資料夾為準；裸指令名交給 PATH。
        if e.command.contains('/') || e.command.contains('\\') {
            e.command = rel(dir, &e.command).to_string_lossy().into_owned();
        }
        out.exec = Some(e);
        out.exec_dir = Some(dir.to_path_buf());
    }
    if let Some(p) = &u.auth_provider {
        let tok = p.config.get("id-token").or_else(|| p.config.get("access-token")).filter(|s| !s.is_empty());
        match tok {
            Some(t) if out.token.is_none() => out.token = Some(t.clone()),
            Some(_) => {}
            None => {
                return Err(AppError::Connect(tf!(
                    "不支援 auth-provider「{name}」（kubectl 1.26 起已移除）；請改用 exec plugin（例如 gke-gcloud-auth-plugin、kubelogin）",
                    name = p.name
                )))
            }
        }
    }
    Ok(out)
}

// ---- ConnectionConfig → ClusterSpec ----

/// 連線設定的來源模式。
pub fn is_manual(cfg: &ConnectionConfig) -> bool {
    opt(cfg, "k8s_source") == Some("manual")
}

/// 解析連線設定成 ClusterSpec（kubeconfig 模式會讀檔）。
pub fn spec_from_config(cfg: &ConnectionConfig) -> AppResult<ClusterSpec> {
    if is_manual(cfg) {
        return manual_spec(cfg);
    }
    let paths = paths_from(opt(cfg, "k8s_kubeconfig"));
    let (kc, _) = load(&paths)?;
    kc.resolve(opt(cfg, "k8s_context"))
}

fn manual_spec(cfg: &ConnectionConfig) -> AppResult<ClusterSpec> {
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err(AppError::Connect(t!("請填入 API server 網址（例如 https://10.0.0.1:6443）").into()));
    }
    let server = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{host}")
    };
    let server = if cfg.port != 0 { with_port(&server, cfg.port) } else { server };
    let pem = |k: &str, what: &str| -> AppResult<Option<Vec<u8>>> {
        match opt(cfg, k) {
            Some(v) => Ok(Some(read_pem(v, what)?)),
            None => Ok(None),
        }
    };
    let user = UserAuth {
        token: Some(cfg.password.trim().to_string()).filter(|s| !s.is_empty()),
        client_cert_pem: pem("k8s_tls_cert", &t!("用戶端憑證"))?,
        client_key_pem: pem("k8s_tls_key", &t!("用戶端私鑰"))?,
        ..Default::default()
    };
    Ok(ClusterSpec {
        label: server.clone(),
        server,
        ca_pem: pem("k8s_tls_ca", &t!("CA 憑證"))?,
        insecure: opt_bool(cfg, "k8s_tls_insecure"),
        tls_server_name: None,
        proxy_url: None,
        namespace: None,
        user,
    })
}

/// 把網址的埠換成 `port`（`https://h[:p]/x` → `https://h:port/x`）。
fn with_port(url: &str, port: u16) -> String {
    let t = crate::db::http_tls::parse_target(url, port, true, (80, 443));
    t.base_url()
}

/// 顯示 / 設定用：連線設定裡的 namespace 限制清單（`k8s_namespaces`，逗號或空白分隔）。
pub fn namespace_filter(cfg: &ConnectionConfig) -> Vec<String> {
    opt(cfg, "k8s_namespaces")
        .map(|v| {
            v.split([',', ' ', '\n', ';'])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-cluster
  cluster:
    server: https://127.0.0.1:6443
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCmFiYwotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
- name: eks
  cluster:
    server: https://ABC.gr7.us-east-1.eks.amazonaws.com
    insecure-skip-tls-verify: true
contexts:
- name: dev
  context: {cluster: dev-cluster, user: admin, namespace: team-a}
- name: prod
  context: {cluster: eks, user: aws}
users:
- name: admin
  user:
    token: abc.def
- name: aws
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, prod]
      env:
      - name: AWS_PROFILE
        value: prod
"#;

    #[test]
    fn parses_and_resolves_current_context() {
        let kc = parse(SAMPLE).unwrap();
        let s = kc.resolve(None).unwrap();
        assert_eq!(s.server, "https://127.0.0.1:6443");
        assert_eq!(s.namespace.as_deref(), Some("team-a"));
        assert_eq!(s.user.token.as_deref(), Some("abc.def"));
        assert!(String::from_utf8(s.ca_pem.unwrap()).unwrap().contains("BEGIN CERTIFICATE"));
        assert_eq!(s.label, "dev");
    }

    #[test]
    fn resolves_exec_context() {
        let kc = parse(SAMPLE).unwrap();
        let s = kc.resolve(Some("prod")).unwrap();
        assert!(s.insecure);
        let e = s.user.exec.unwrap();
        assert_eq!(e.command, "aws");
        assert_eq!(e.args[0], "eks");
        assert_eq!(e.env, vec![ExecEnv { name: "AWS_PROFILE".into(), value: "prod".into() }]);
    }

    #[test]
    fn context_infos_summarize_auth() {
        let kc = parse(SAMPLE).unwrap();
        let infos = kc.context_infos();
        assert_eq!(infos.len(), 2);
        assert!(infos[0].current && infos[0].auth == "token" && infos[0].namespace == "team-a");
        assert_eq!(infos[1].auth, "exec:aws");
        assert_eq!(infos[1].server, "https://ABC.gr7.us-east-1.eks.amazonaws.com");
    }

    #[test]
    fn missing_context_is_an_error() {
        let kc = parse(SAMPLE).unwrap();
        assert!(kc.resolve(Some("nope")).is_err());
    }

    #[test]
    fn merges_files_first_wins() {
        let dir = std::env::temp_dir().join(format!("dbkit-kc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::write(&a, SAMPLE).unwrap();
        std::fs::write(
            &b,
            "current-context: other\nclusters:\n- name: dev-cluster\n  cluster: {server: https://shadowed}\n- name: c2\n  cluster: {server: https://c2, certificate-authority: ca.pem}\ncontexts:\n- name: other\n  context: {cluster: c2, user: u2}\nusers:\n- name: u2\n  user: {client-certificate: sub/c.pem, client-key: sub/k.pem}\n",
        )
        .unwrap();
        std::fs::write(dir.join("ca.pem"), "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/c.pem"), "CERT").unwrap();
        std::fs::write(dir.join("sub/k.pem"), "KEY").unwrap();
        let (kc, read) = load(&[a.clone(), dir.join("missing"), b.clone()]).unwrap();
        assert_eq!(read, vec![a, b]);
        assert_eq!(kc.current_context, "dev");
        assert_eq!(kc.resolve(Some("dev")).unwrap().server, "https://127.0.0.1:6443");
        let o = kc.resolve(Some("other")).unwrap();
        assert!(o.ca_pem.is_some());
        assert_eq!(o.user.client_cert_pem.as_deref(), Some(&b"CERT"[..]));
        assert_eq!(o.user.client_key_pem.as_deref(), Some(&b"KEY"[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auth_provider_without_token_is_rejected() {
        let kc = parse(
            "current-context: g\nclusters: [{name: c, cluster: {server: https://x}}]\ncontexts: [{name: g, context: {cluster: c, user: u}}]\nusers: [{name: u, user: {auth-provider: {name: gcp}}}]\n",
        )
        .unwrap();
        assert!(kc.resolve(None).is_err());
    }

    #[test]
    fn manual_spec_forms() {
        let mut c = crate::db::docker::config::tests::cfg("10.0.0.1:6443");
        c.kind = crate::db::DbKind::Kubernetes;
        c.options.insert("k8s_source".into(), "manual".into());
        c.password = " tok ".into();
        let s = spec_from_config(&c).unwrap();
        assert_eq!(s.server, "https://10.0.0.1:6443");
        assert_eq!(s.user.token.as_deref(), Some("tok"));
        c.port = 16443;
        c.host = "https://api.example.com".into();
        assert_eq!(spec_from_config(&c).unwrap().server, "https://api.example.com:16443");
    }

    #[test]
    fn namespace_filter_splits() {
        let mut c = crate::db::docker::config::tests::cfg("");
        c.options.insert("k8s_namespaces".into(), "a, b\nc".into());
        assert_eq!(namespace_filter(&c), vec!["a", "b", "c"]);
    }
}
