//! ACL 管理（rdkafka 高階 API 未提供，走 rdkafka-sys FFI）。
//!
//! 安全性：所有 C 物件以 RAII guard 保證釋放；DescribeAcls / DeleteAcls 回傳的 binding
//! 由 event 擁有，於 `rd_kafka_event_destroy` 前**先複製所有字串**。NULL 字串（cluster /
//! 萬用）映射為空字串。全部呼叫於 `spawn_blocking` 內執行。

#![allow(non_upper_case_globals)]

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

use rdkafka::bindings as rd;
use rdkafka::consumer::Consumer;

use super::dto::KafkaAclBinding;
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

/// ACL 操作種類。
#[derive(Clone, Copy)]
enum Op {
    Create,
    Describe,
    Delete,
}

impl KafkaDriver {
    /// 列出符合 filter 的 ACL（filter 各欄空 / "any" = 萬用）。
    pub async fn acls_list(&self, filter: KafkaAclBinding) -> AppResult<Vec<KafkaAclBinding>> {
        self.run_acl(Op::Describe, vec![filter]).await
    }
    /// 建立 ACL。
    pub async fn acls_create(&self, bindings: Vec<KafkaAclBinding>) -> AppResult<Vec<KafkaAclBinding>> {
        self.run_acl(Op::Create, bindings).await
    }
    /// 刪除符合 filter 的 ACL。
    pub async fn acls_delete(&self, filter: KafkaAclBinding) -> AppResult<Vec<KafkaAclBinding>> {
        self.run_acl(Op::Delete, vec![filter]).await
    }

    async fn run_acl(&self, op: Op, bindings: Vec<KafkaAclBinding>) -> AppResult<Vec<KafkaAclBinding>> {
        let meta = self.meta.clone();
        tokio::task::spawn_blocking(move || {
            let rk = meta.client().native_ptr();
            unsafe { run_acl_blocking(rk, op, &bindings) }
        })
        .await
        .map_err(query_err)?
    }
}

// ---- RAII guards ----

struct Queue(*mut rd::rd_kafka_queue_t);
impl Drop for Queue {
    fn drop(&mut self) {
        unsafe { rd::rd_kafka_queue_destroy(self.0) }
    }
}
struct AdminOpts(*mut rd::rd_kafka_AdminOptions_t);
impl Drop for AdminOpts {
    fn drop(&mut self) {
        unsafe { rd::rd_kafka_AdminOptions_destroy(self.0) }
    }
}
struct Event(*mut rd::rd_kafka_event_t);
impl Drop for Event {
    fn drop(&mut self) {
        unsafe { rd::rd_kafka_event_destroy(self.0) }
    }
}
/// 我方擁有的 AclBinding（create/filter 用），Drop 時銷毀。
struct OwnedBinding(*mut rd::rd_kafka_AclBinding_t);
impl Drop for OwnedBinding {
    fn drop(&mut self) {
        unsafe { rd::rd_kafka_AclBinding_destroy(self.0) }
    }
}

unsafe fn run_acl_blocking(
    rk: *mut rd::rd_kafka_t,
    op: Op,
    inputs: &[KafkaAclBinding],
) -> AppResult<Vec<KafkaAclBinding>> {
    let admin_op = match op {
        Op::Create => rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_CREATEACLS,
        Op::Describe => rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DESCRIBEACLS,
        Op::Delete => rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DELETEACLS,
    };
    let opts = AdminOpts(rd::rd_kafka_AdminOptions_new(rk, admin_op));
    if opts.0.is_null() {
        return Err(AppError::Query("AdminOptions_new 失敗".into()));
    }
    let mut errbuf = [0i8; 512];
    rd::rd_kafka_AdminOptions_set_request_timeout(opts.0, 15_000, errbuf.as_mut_ptr(), errbuf.len());

    let queue = Queue(rd::rd_kafka_queue_new(rk));

    // 建 binding（保留 CString 存活至呼叫結束）。
    let mut cstrings: Vec<CString> = Vec::new();
    let mut owned: Vec<OwnedBinding> = Vec::new();
    let is_filter = matches!(op, Op::Describe | Op::Delete);
    for b in inputs {
        let ptr = build_binding(b, is_filter, &mut cstrings, &mut errbuf)?;
        owned.push(OwnedBinding(ptr));
    }
    let mut raw: Vec<*mut rd::rd_kafka_AclBinding_t> = owned.iter().map(|o| o.0).collect();

    // 呼叫對應 API。
    match op {
        Op::Create => rd::rd_kafka_CreateAcls(rk, raw.as_mut_ptr(), raw.len(), opts.0, queue.0),
        Op::Describe => rd::rd_kafka_DescribeAcls(rk, raw[0], opts.0, queue.0),
        Op::Delete => rd::rd_kafka_DeleteAcls(rk, raw.as_mut_ptr(), raw.len(), opts.0, queue.0),
    }

    // 等結果事件。
    let ev = Event(rd::rd_kafka_queue_poll(queue.0, 20_000));
    if ev.0.is_null() {
        return Err(AppError::Query("ACL 操作逾時".into()));
    }
    let err = rd::rd_kafka_event_error(ev.0);
    if err as u32 != 0 {
        let msg = cstr_to_string(rd::rd_kafka_event_error_string(ev.0));
        // 授權器未啟用 → SECURITY_DISABLED。
        return Err(AppError::Query(map_acl_error(err as i32, &msg)));
    }

    // 解析結果（describe / delete 回 binding；create 只回逐項錯誤）。
    match op {
        Op::Create => {
            let result = rd::rd_kafka_event_CreateAcls_result(ev.0);
            let mut cnt = 0usize;
            let arr = rd::rd_kafka_CreateAcls_result_acls(result, &mut cnt);
            for i in 0..cnt {
                let e = rd::rd_kafka_acl_result_error(*arr.add(i));
                if !e.is_null() && rd::rd_kafka_error_code(e) as u32 != 0 {
                    let m = cstr_to_string(rd::rd_kafka_error_string(e));
                    return Err(AppError::Query(format!("建立 ACL 失敗：{m}")));
                }
            }
            Ok(inputs.to_vec()) // 成功回傳輸入
        }
        Op::Describe => {
            let result = rd::rd_kafka_event_DescribeAcls_result(ev.0);
            let mut cnt = 0usize;
            let arr = rd::rd_kafka_DescribeAcls_result_acls(result, &mut cnt);
            let mut out = Vec::with_capacity(cnt);
            for i in 0..cnt {
                out.push(binding_to_dto(*arr.add(i)));
            }
            Ok(out)
        }
        Op::Delete => {
            let result = rd::rd_kafka_event_DeleteAcls_result(ev.0);
            let mut rcnt = 0usize;
            let responses = rd::rd_kafka_DeleteAcls_result_responses(result, &mut rcnt);
            let mut out = Vec::new();
            for i in 0..rcnt {
                let resp = *responses.add(i);
                let e = rd::rd_kafka_DeleteAcls_result_response_error(resp);
                if !e.is_null() && rd::rd_kafka_error_code(e) as u32 != 0 {
                    let m = cstr_to_string(rd::rd_kafka_error_string(e));
                    return Err(AppError::Query(format!("刪除 ACL 失敗：{m}")));
                }
                let mut mcnt = 0usize;
                let matching = rd::rd_kafka_DeleteAcls_result_response_matching_acls(resp, &mut mcnt);
                for j in 0..mcnt {
                    out.push(binding_to_dto(*matching.add(j)));
                }
            }
            Ok(out)
        }
    }
    // guards（queue / opts / ev / owned bindings / cstrings）於此 drop。
}

/// 建立一個 AclBinding / Filter（filter 允許 name/principal/host 為 NULL 表萬用）。
unsafe fn build_binding(
    b: &KafkaAclBinding,
    is_filter: bool,
    cstrings: &mut Vec<CString>,
    errbuf: &mut [i8; 512],
) -> AppResult<*mut rd::rd_kafka_AclBinding_t> {
    let restype = to_restype(&b.resource_type);
    let pattern = to_pattern(&b.pattern_type);
    let op = to_operation(&b.operation);
    let perm = to_permission(&b.permission);

    // filter 時空字串 → NULL（萬用）；create 時空字串 → 空 C 字串。
    let name = str_ptr(&b.name, is_filter, cstrings);
    let principal = str_ptr(&b.principal, is_filter, cstrings);
    let host = str_ptr(&b.host, is_filter, cstrings);

    let ptr = if is_filter {
        rd::rd_kafka_AclBindingFilter_new(restype, name, pattern, principal, host, op, perm, errbuf.as_mut_ptr(), errbuf.len())
    } else {
        rd::rd_kafka_AclBinding_new(restype, name, pattern, principal, host, op, perm, errbuf.as_mut_ptr(), errbuf.len())
    };
    if ptr.is_null() {
        return Err(AppError::Query(format!(
            "AclBinding 建立失敗：{}",
            cstr_to_string(errbuf.as_ptr())
        )));
    }
    Ok(ptr)
}

/// 空字串 + filter → NULL；否則配 CString 回其指標。
unsafe fn str_ptr(s: &str, is_filter: bool, cstrings: &mut Vec<CString>) -> *const c_char {
    if s.is_empty() && is_filter {
        return ptr::null();
    }
    let cs = CString::new(s).unwrap_or_default();
    let p = cs.as_ptr();
    cstrings.push(cs);
    p
}

/// binding（event 擁有）→ DTO（複製所有字串）。
unsafe fn binding_to_dto(acl: *const rd::rd_kafka_AclBinding_t) -> KafkaAclBinding {
    KafkaAclBinding {
        resource_type: restype_name(rd::rd_kafka_AclBinding_restype(acl)),
        name: cstr_to_string(rd::rd_kafka_AclBinding_name(acl)),
        pattern_type: pattern_name(rd::rd_kafka_AclBinding_resource_pattern_type(acl)),
        principal: cstr_to_string(rd::rd_kafka_AclBinding_principal(acl)),
        host: cstr_to_string(rd::rd_kafka_AclBinding_host(acl)),
        operation: operation_name(rd::rd_kafka_AclBinding_operation(acl)),
        permission: permission_name(rd::rd_kafka_AclBinding_permission_type(acl)),
    }
}

unsafe fn cstr_to_string(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

fn map_acl_error(code: i32, msg: &str) -> String {
    // RD_KAFKA_RESP_ERR_SECURITY_DISABLED = -139（librdkafka 內部碼）；用訊息判斷更穩。
    if msg.contains("SECURITY_DISABLED") || code == -139 {
        return "叢集未啟用授權器（authorizer），無法管理 ACL".to_string();
    }
    format!("ACL 操作失敗：{msg}")
}

// ---- 字串 ↔ C enum 映射 ----

fn to_restype(s: &str) -> rd::rd_kafka_ResourceType_t {
    use rd::rd_kafka_ResourceType_t::*;
    match s {
        "topic" => RD_KAFKA_RESOURCE_TOPIC,
        "group" => RD_KAFKA_RESOURCE_GROUP,
        "cluster" => RD_KAFKA_RESOURCE_BROKER,
        "transactional_id" => RD_KAFKA_RESOURCE_TRANSACTIONAL_ID,
        _ => RD_KAFKA_RESOURCE_ANY,
    }
}
fn restype_name(t: rd::rd_kafka_ResourceType_t) -> String {
    use rd::rd_kafka_ResourceType_t::*;
    match t {
        RD_KAFKA_RESOURCE_TOPIC => "topic",
        RD_KAFKA_RESOURCE_GROUP => "group",
        RD_KAFKA_RESOURCE_BROKER => "cluster",
        RD_KAFKA_RESOURCE_TRANSACTIONAL_ID => "transactional_id",
        _ => "any",
    }
    .to_string()
}
fn to_pattern(s: &str) -> rd::rd_kafka_ResourcePatternType_t {
    use rd::rd_kafka_ResourcePatternType_t::*;
    match s {
        "literal" => RD_KAFKA_RESOURCE_PATTERN_LITERAL,
        "prefixed" => RD_KAFKA_RESOURCE_PATTERN_PREFIXED,
        _ => RD_KAFKA_RESOURCE_PATTERN_ANY,
    }
}
fn pattern_name(t: rd::rd_kafka_ResourcePatternType_t) -> String {
    use rd::rd_kafka_ResourcePatternType_t::*;
    match t {
        RD_KAFKA_RESOURCE_PATTERN_LITERAL => "literal",
        RD_KAFKA_RESOURCE_PATTERN_PREFIXED => "prefixed",
        _ => "any",
    }
    .to_string()
}
fn to_operation(s: &str) -> rd::rd_kafka_AclOperation_t {
    use rd::rd_kafka_AclOperation_t::*;
    match s {
        "all" => RD_KAFKA_ACL_OPERATION_ALL,
        "read" => RD_KAFKA_ACL_OPERATION_READ,
        "write" => RD_KAFKA_ACL_OPERATION_WRITE,
        "create" => RD_KAFKA_ACL_OPERATION_CREATE,
        "delete" => RD_KAFKA_ACL_OPERATION_DELETE,
        "alter" => RD_KAFKA_ACL_OPERATION_ALTER,
        "describe" => RD_KAFKA_ACL_OPERATION_DESCRIBE,
        "cluster_action" => RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION,
        "describe_configs" => RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS,
        "alter_configs" => RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS,
        "idempotent_write" => RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE,
        _ => RD_KAFKA_ACL_OPERATION_ANY,
    }
}
fn operation_name(t: rd::rd_kafka_AclOperation_t) -> String {
    use rd::rd_kafka_AclOperation_t::*;
    match t {
        RD_KAFKA_ACL_OPERATION_ALL => "all",
        RD_KAFKA_ACL_OPERATION_READ => "read",
        RD_KAFKA_ACL_OPERATION_WRITE => "write",
        RD_KAFKA_ACL_OPERATION_CREATE => "create",
        RD_KAFKA_ACL_OPERATION_DELETE => "delete",
        RD_KAFKA_ACL_OPERATION_ALTER => "alter",
        RD_KAFKA_ACL_OPERATION_DESCRIBE => "describe",
        RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION => "cluster_action",
        RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS => "describe_configs",
        RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS => "alter_configs",
        RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE => "idempotent_write",
        _ => "any",
    }
    .to_string()
}
fn to_permission(s: &str) -> rd::rd_kafka_AclPermissionType_t {
    use rd::rd_kafka_AclPermissionType_t::*;
    match s {
        "allow" => RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW,
        "deny" => RD_KAFKA_ACL_PERMISSION_TYPE_DENY,
        _ => RD_KAFKA_ACL_PERMISSION_TYPE_ANY,
    }
}
fn permission_name(t: rd::rd_kafka_AclPermissionType_t) -> String {
    use rd::rd_kafka_AclPermissionType_t::*;
    match t {
        RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW => "allow",
        RD_KAFKA_ACL_PERMISSION_TYPE_DENY => "deny",
        _ => "any",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restype_roundtrip() {
        for s in ["topic", "group", "cluster", "transactional_id", "any"] {
            assert_eq!(restype_name(to_restype(s)), s);
        }
    }
    #[test]
    fn operation_roundtrip() {
        for s in ["all", "read", "write", "create", "delete", "alter", "describe", "cluster_action", "describe_configs", "alter_configs", "idempotent_write", "any"] {
            assert_eq!(operation_name(to_operation(s)), s);
        }
    }
    #[test]
    fn permission_and_pattern_roundtrip() {
        for s in ["allow", "deny", "any"] {
            assert_eq!(permission_name(to_permission(s)), s);
        }
        for s in ["literal", "prefixed", "any"] {
            assert_eq!(pattern_name(to_pattern(s)), s);
        }
    }
}
