//! 對真實 registry 的整合測試（`#[ignore]`）。
//!
//! - `registry_local_end_to_end`：`DBKIT_REGISTRY_HOST`（如 `localhost:15000`，需 `REGISTRY_STORAGE_DELETE_ENABLED=true`）
//!   且已推入 `DBKIT_REGISTRY_REPO`:`DBKIT_REGISTRY_TAG`（預設 `it/alpine:1.0`）。測試最後會刪掉該 tag 的 manifest。
//! - `registry_docker_hub_anonymous`：`DBKIT_REGISTRY_HUB=1`，匿名走 Docker Hub 的 Bearer token 流程（只讀）。
#![cfg(test)]

use super::api::RegistryApi;
use super::RegistryDriver;
use crate::db::docker::config::tests::cfg;
use crate::db::{DatabaseDriver, DbKind};

#[tokio::test]
#[ignore]
async fn registry_local_end_to_end() {
    let Ok(host) = std::env::var("DBKIT_REGISTRY_HOST") else { return };
    let repo = std::env::var("DBKIT_REGISTRY_REPO").unwrap_or_else(|_| "it/alpine".into());
    let tag = std::env::var("DBKIT_REGISTRY_TAG").unwrap_or_else(|_| "1.0".into());
    let mut c = cfg(&host);
    c.kind = DbKind::Registry;

    let drv = RegistryDriver::connect(&c).await.expect("connect");
    let info = drv.api.probe().await.expect("probe");
    assert!(info.catalog && info.base_url.starts_with("http://"), "{info:?}");
    assert!(drv.list_databases().await.unwrap().contains(&repo));
    let tags = drv.list_tables(&repo).await.unwrap();
    assert!(tags.iter().any(|t| t.name == tag && t.kind == "tag"));

    let m = drv.api.manifest(&repo, &tag).await.expect("manifest");
    assert!(m.digest.starts_with("sha256:"), "{m:?}");
    let image = if m.is_index {
        // 本機 push 的多平台映像：取第一個平台再看。
        drv.api.manifest(&repo, &m.platforms[0].digest).await.expect("child manifest")
    } else {
        m.clone()
    };
    assert!(!image.layers.is_empty() && image.size > 0);
    let conf = image.config.expect("config blob");
    assert_eq!(conf.os, "linux");

    drv.api.delete(&repo, &tag).await.expect("delete by tag");
    let err = drv.api.manifest(&repo, &tag).await.unwrap_err().to_string();
    assert!(err.contains("404") || err.contains("MANIFEST_UNKNOWN"), "{err}");
}

#[tokio::test]
#[ignore]
async fn registry_docker_hub_anonymous() {
    if std::env::var("DBKIT_REGISTRY_HUB").as_deref() != Ok("1") {
        return;
    }
    let mut c = cfg("https://registry-1.docker.io");
    c.kind = DbKind::Registry;
    c.options.insert("registry_repos".into(), "library/alpine".into());
    let drv = RegistryDriver::connect(&c).await.expect("connect (anonymous bearer)");
    assert_eq!(drv.list_databases().await.unwrap(), vec!["library/alpine".to_string()]);
    let tags = drv.list_tables("library/alpine").await.expect("tags via bearer token");
    assert!(tags.iter().any(|t| t.name == "latest"));

    let api: &RegistryApi = &drv.api;
    let idx = api.manifest("library/alpine", "latest").await.expect("index manifest");
    assert!(idx.is_index && idx.platforms.iter().any(|p| p.arch == "amd64"));
    let amd = idx.platforms.iter().find(|p| p.arch == "amd64" && p.os == "linux").unwrap();
    let img = api.manifest("library/alpine", &amd.digest).await.expect("platform manifest");
    assert!(img.config.is_some(), "config blob behind a redirect should load");
    // Docker Hub 不開放 _catalog。
    assert!(!api.probe().await.unwrap().catalog);
}
