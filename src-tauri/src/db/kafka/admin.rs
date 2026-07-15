//! Metadata / Admin 操作。P2：主題清單、叢集資訊、分區。P4/P5 續補群組 / 建刪主題 / 設定。
//!
//! 全部 metadata / watermark 查詢是阻塞式 C 呼叫，一律走 `spawn_blocking`。

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use rdkafka::admin::{
    AdminOptions, AlterConfig, NewPartitions, NewTopic, ResourceSpecifier, TopicReplication,
};
use rdkafka::consumer::{BaseConsumer, CommitMode, Consumer};
use rdkafka::groups::{GroupInfo, GroupMemberInfo};
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};
use rdkafka::ClientConfig;

/// 安全取群組成員：rdkafka 0.39 起上游已對「空群組（member_cnt=0、members 指標為 null）」
/// 的 `members()` 加 null guard，此函式保留作語意文件 + 防禦（Empty / Dead 為確定零成員的
/// 終端狀態，直接回空切片）。
fn safe_members(g: &GroupInfo) -> &[GroupMemberInfo] {
    match g.state() {
        "Empty" | "Dead" => &[],
        _ => g.members(),
    }
}

use super::dto::{
    KafkaBroker, KafkaClusterInfo, KafkaConfigEntry, KafkaConsumerGroup, KafkaCreateTopicSpec,
    KafkaDeleteRecordsResult, KafkaGroupDetail, KafkaGroupMember, KafkaGroupOffset,
    KafkaOffsetPlanRow, KafkaOffsetReset, KafkaPartitionInfo, KafkaResetTarget, KafkaTopic,
};
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

impl KafkaDriver {
    /// 主題清單（含分區數 / 複本數 / 是否內部）。
    pub async fn list_topics(&self) -> AppResult<Vec<KafkaTopic>> {
        let meta = self.meta.clone();
        let show_internal = self.show_internal;
        tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(None, Duration::from_secs(10))
                .map_err(query_err)?;
            let mut out: Vec<KafkaTopic> = md
                .topics()
                .iter()
                .filter(|t| show_internal || !super::is_internal_topic(t.name()))
                .map(|t| {
                    let parts = t.partitions();
                    let replication = parts.first().map(|p| p.replicas().len()).unwrap_or(0) as u16;
                    KafkaTopic {
                        name: t.name().to_string(),
                        partitions: parts.len() as u32,
                        replication,
                        internal: super::is_internal_topic(t.name()),
                    }
                })
                .collect();
            out.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(out)
        })
        .await
        .map_err(query_err)?
    }

    /// 叢集資訊（brokers + 主題 / 分區統計 + URP / offline 健康摘要）。
    /// 單次 fetch_metadata 內全部算完，不打 per-partition watermark（那是取樣器的事）。
    pub async fn cluster_info(&self) -> AppResult<KafkaClusterInfo> {
        let meta = self.meta.clone();
        let bootstrap = self.bootstrap.clone();
        tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(None, Duration::from_secs(10))
                .map_err(query_err)?;
            let brokers: Vec<KafkaBroker> = md
                .brokers()
                .iter()
                .map(|b| KafkaBroker {
                    id: b.id(),
                    host: b.host().to_string(),
                    port: b.port(),
                })
                .collect();
            let (mut topic_count, mut internal_topic_count) = (0u32, 0u32);
            let (mut partition_count, mut under_replicated, mut offline_partitions) =
                (0u32, 0u32, 0u32);
            for t in md.topics() {
                if super::is_internal_topic(t.name()) {
                    internal_topic_count += 1;
                } else {
                    topic_count += 1;
                }
                for p in t.partitions() {
                    partition_count += 1;
                    if p.leader() == -1 {
                        offline_partitions += 1;
                    }
                    if p.isr().len() < p.replicas().len() {
                        under_replicated += 1;
                    }
                }
            }
            // controller id 無高階包裝，走 re-export 的 C binding（回傳 id 本身，-1 未知）。
            let controller_id = unsafe {
                rdkafka::bindings::rd_kafka_controllerid(meta.client().native_ptr(), 10_000)
            };
            let cluster_id = meta.client().fetch_cluster_id(Duration::from_secs(10));
            Ok(KafkaClusterInfo {
                bootstrap,
                broker_count: brokers.len() as u32,
                brokers,
                orig_broker_id: md.orig_broker_id(),
                cluster_id,
                controller_id,
                topic_count,
                internal_topic_count,
                partition_count,
                under_replicated,
                offline_partitions,
                librdkafka_version: rdkafka::util::get_rdkafka_version().1,
            })
        })
        .await
        .map_err(query_err)?
    }

    /// 某主題各分區資訊（leader / replicas / ISR / low / high）。
    pub async fn topic_partitions(&self, topic: &str) -> AppResult<Vec<KafkaPartitionInfo>> {
        let meta = self.meta.clone();
        let topic = topic.to_string();
        tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(Some(&topic), Duration::from_secs(10))
                .map_err(query_err)?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic)
                .ok_or_else(|| AppError::Query(format!("找不到主題 {topic}")))?;
            let mut out = Vec::with_capacity(t.partitions().len());
            for p in t.partitions() {
                let (low, high) = meta
                    .fetch_watermarks(&topic, p.id(), Duration::from_secs(10))
                    .map_err(query_err)?;
                out.push(KafkaPartitionInfo {
                    partition: p.id(),
                    leader: p.leader(),
                    replicas: p.replicas().to_vec(),
                    isr: p.isr().to_vec(),
                    low,
                    high,
                });
            }
            out.sort_by_key(|p| p.partition);
            Ok(out)
        })
        .await
        .map_err(query_err)?
    }

    /// 消費者群組清單。
    pub async fn list_groups(&self) -> AppResult<Vec<KafkaConsumerGroup>> {
        let meta = self.meta.clone();
        tokio::task::spawn_blocking(move || {
            let gl = meta
                .fetch_group_list(None, Duration::from_secs(15))
                .map_err(query_err)?;
            let mut out: Vec<KafkaConsumerGroup> = gl
                .groups()
                .iter()
                .map(|g| KafkaConsumerGroup {
                    group_id: g.name().to_string(),
                    state: g.state().to_string(),
                    protocol: g.protocol().to_string(),
                    members: safe_members(g).len() as u32,
                })
                .collect();
            out.sort_by(|a, b| a.group_id.cmp(&b.group_id));
            Ok(out)
        })
        .await
        .map_err(query_err)?
    }

    /// 群組詳細：成員 + 每分區 current / log-end / **lag**。
    pub async fn describe_group(&self, group: &str) -> AppResult<KafkaGroupDetail> {
        let base = self.base.clone();
        let meta = self.meta.clone();
        let group = group.to_string();
        tokio::task::spawn_blocking(move || describe_group_blocking(&base, meta.as_ref(), &group))
            .await
            .map_err(query_err)?
    }

    /// 預覽位移重設：純解析每分區的 current / target / 水位，不檢查群組狀態、不 commit。
    pub async fn preview_reset(
        &self,
        reset: &KafkaOffsetReset,
    ) -> AppResult<Vec<KafkaOffsetPlanRow>> {
        let base = self.base.clone();
        let meta = self.meta.clone();
        let reset = reset.clone();
        tokio::task::spawn_blocking(move || {
            let mut cc = base.clone();
            cc.set("group.id", &reset.group);
            cc.set("enable.auto.commit", "false");
            let consumer: BaseConsumer = cc.create().map_err(query_err)?;
            resolve_reset_plan(&consumer, meta.as_ref(), &reset)
        })
        .await
        .map_err(query_err)?
    }

    /// 重設群組位移（群組須為 Empty，無活躍成員）。回傳實際套用的計畫。
    pub async fn reset_offsets(
        &self,
        reset: &KafkaOffsetReset,
    ) -> AppResult<Vec<KafkaOffsetPlanRow>> {
        let base = self.base.clone();
        let meta = self.meta.clone();
        let reset = reset.clone();
        tokio::task::spawn_blocking(move || reset_offsets_blocking(&base, meta.as_ref(), &reset))
            .await
            .map_err(query_err)?
    }

    /// 建立主題。
    pub async fn create_topic(&self, spec: &KafkaCreateTopicSpec) -> AppResult<()> {
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let mut nt = NewTopic::new(
            &spec.name,
            spec.partitions,
            TopicReplication::Fixed(spec.replication),
        );
        for h in &spec.config {
            nt = nt.set(&h.key, &h.value);
        }
        let res = self
            .admin
            .create_topics(&[nt], &opts)
            .await
            .map_err(query_err)?;
        check_topic_results(res)
    }

    /// 刪除主題。
    pub async fn delete_topic(&self, topic: &str) -> AppResult<()> {
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .delete_topics(&[topic], &opts)
            .await
            .map_err(query_err)?;
        check_topic_results(res)
    }

    /// 設定（value = Some）或還原預設（value = None）單一主題設定鍵。
    ///
    /// AlterConfigs 為整組取代語意：先 describe 取 `source == DynamicTopic` 的既有覆寫為
    /// 基底，套用本次變更後整組送回。**絕不可**把 Default / Broker 層的值一併送回——那會被
    /// 固化成主題層覆寫。若基底含讀不到值的敏感項，整組覆寫會默默清掉它，直接拒絕編輯。
    /// 兩個 client 同時編輯存在 read-modify-write race；單機桌面工具可接受。
    pub async fn set_topic_config(
        &self,
        topic: &str,
        key: &str,
        value: Option<&str>,
    ) -> AppResult<()> {
        use rdkafka::admin::ConfigSource;
        let ropts = AdminOptions::new().request_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .describe_configs(&[ResourceSpecifier::Topic(topic)], &ropts)
            .await
            .map_err(query_err)?;
        let mut base: Vec<(String, String)> = Vec::new();
        for r in res {
            let cr = r.map_err(|e| AppError::Query(format!("讀取設定失敗：{e}")))?;
            for entry in cr.entries {
                if !matches!(entry.source, ConfigSource::DynamicTopic) {
                    continue;
                }
                if entry.is_sensitive {
                    return Err(AppError::Query(
                        t!("主題含無法讀取的敏感設定，整組覆寫會遺失該值，已拒絕編輯").into(),
                    ));
                }
                base.push((entry.name, entry.value.unwrap_or_default()));
            }
        }
        base.retain(|(k, _)| k != key);
        if let Some(v) = value {
            base.push((key.to_string(), v.to_string()));
        }
        let mut ac = AlterConfig::new(ResourceSpecifier::Topic(topic));
        for (k, v) in &base {
            ac = ac.set(k, v);
        }
        let wopts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .alter_configs(&[ac], &wopts)
            .await
            .map_err(query_err)?;
        for r in res {
            if let Err((_, code)) = r {
                return Err(AppError::Query(format!("設定變更失敗：{code}")));
            }
        }
        Ok(())
    }

    /// 增加主題分區數（Kafka 只能增不能減）。`new_total` 為新「總數」而非增量。
    pub async fn add_partitions(&self, topic: &str, new_total: usize) -> AppResult<()> {
        let meta = self.meta.clone();
        let topic_owned = topic.to_string();
        let current = tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(Some(&topic_owned), Duration::from_secs(10))
                .map_err(query_err)?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic_owned)
                .ok_or_else(|| AppError::Query(format!("找不到主題 {topic_owned}")))?;
            Ok::<usize, AppError>(t.partitions().len())
        })
        .await
        .map_err(query_err)??;
        if new_total <= current {
            return Err(AppError::Query(tf!(
                "新分區數必須大於目前的 {n}",
                n = current
            )));
        }
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let np = NewPartitions::new(topic, new_total);
        let res = self
            .admin
            .create_partitions(&[np], &opts)
            .await
            .map_err(query_err)?;
        check_topic_results(res)
    }

    /// 刪除消費者群組（須 Empty；已提交位移一併刪除）。
    pub async fn delete_group(&self, group: &str) -> AppResult<()> {
        let meta = self.meta.clone();
        let group_owned = group.to_string();
        let has_members = tokio::task::spawn_blocking(move || {
            let gl = meta
                .fetch_group_list(Some(&group_owned), Duration::from_secs(15))
                .map_err(query_err)?;
            Ok::<bool, AppError>(
                gl.groups()
                    .iter()
                    .find(|g| g.name() == group_owned)
                    .map(|g| !safe_members(g).is_empty())
                    .unwrap_or(false),
            )
        })
        .await
        .map_err(query_err)??;
        if has_members {
            return Err(AppError::Query(
                t!("群組仍有活躍成員，無法刪除（請先停掉消費者）").into(),
            ));
        }
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .delete_groups(&[group], &opts)
            .await
            .map_err(query_err)?;
        for r in res {
            if let Err((name, code)) = r {
                return Err(AppError::Query(format!("{name}: {code}")));
            }
        }
        Ok(())
    }

    /// 刪除主題訊息（DeleteRecords）：清掉 `offset < before` 的訊息。
    /// `before = None` → `Offset::End`（由 broker 解析為當下 high watermark，全清、無 race）；
    /// `partitions = None` → 全部分區。內部主題一律拒絕。
    /// 單一分區失敗不整體 Err——逐分區回報（cleanup.policy=compact 會被 broker 以
    /// POLICY_VIOLATION 拒絕，錯誤原樣呈現）。
    pub async fn delete_records(
        &self,
        topic: &str,
        partitions: Option<&[i32]>,
        before: Option<i64>,
    ) -> AppResult<Vec<KafkaDeleteRecordsResult>> {
        if super::is_internal_topic(topic) {
            return Err(AppError::Query(t!("內部主題不可清空").into()));
        }
        let meta = self.meta.clone();
        let topic_owned = topic.to_string();
        let sel: Option<Vec<i32>> = partitions.map(|p| p.to_vec());
        let pids = tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(Some(&topic_owned), Duration::from_secs(10))
                .map_err(query_err)?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic_owned)
                .ok_or_else(|| AppError::Query(format!("找不到主題 {topic_owned}")))?;
            let mut ids: Vec<i32> = t.partitions().iter().map(|p| p.id()).collect();
            if let Some(sel) = sel {
                ids.retain(|i| sel.contains(i));
            }
            Ok::<Vec<i32>, AppError>(ids)
        })
        .await
        .map_err(query_err)??;
        if pids.is_empty() {
            return Err(AppError::Query(t!("沒有符合的分區").into()));
        }
        let mut tpl = TopicPartitionList::new();
        for pid in &pids {
            tpl.add_partition_offset(
                topic,
                *pid,
                before.map(Offset::Offset).unwrap_or(Offset::End),
            )
            .map_err(query_err)?;
        }
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .delete_records(&tpl, &opts)
            .await
            .map_err(query_err)?;
        let mut out: Vec<KafkaDeleteRecordsResult> = res
            .elements()
            .iter()
            .map(|e| {
                let err = e.error().err().map(|c| c.to_string());
                KafkaDeleteRecordsResult {
                    partition: e.partition(),
                    low_watermark: match e.offset() {
                        Offset::Offset(o) => o,
                        _ => -1,
                    },
                    error: err,
                }
            })
            .collect();
        out.sort_by_key(|r| r.partition);
        Ok(out)
    }

    /// 讀取主題設定（describe configs）。
    pub async fn topic_config(&self, topic: &str) -> AppResult<Vec<KafkaConfigEntry>> {
        let opts = AdminOptions::new().request_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .describe_configs(&[ResourceSpecifier::Topic(topic)], &opts)
            .await
            .map_err(query_err)?;
        config_entries(res)
    }

    /// 讀取 broker 設定（describe configs，ResourceSpecifier::Broker）。
    pub async fn broker_config(&self, broker_id: i32) -> AppResult<Vec<KafkaConfigEntry>> {
        let opts = AdminOptions::new().request_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .describe_configs(&[ResourceSpecifier::Broker(broker_id)], &opts)
            .await
            .map_err(query_err)?;
        config_entries(res)
    }
}

/// describe_configs 結果 → 設定項清單（topic_config / broker_config 共用）。
fn config_entries(
    res: Vec<rdkafka::admin::ConfigResourceResult>,
) -> AppResult<Vec<KafkaConfigEntry>> {
    let mut out = Vec::new();
    for r in res {
        let cr = r.map_err(|e| AppError::Query(format!("讀取設定失敗：{e}")))?;
        for entry in cr.entries {
            out.push(KafkaConfigEntry {
                name: entry.name,
                value: entry.value.unwrap_or_default(),
                source: format!("{:?}", entry.source),
                is_default: entry.is_default,
                is_sensitive: entry.is_sensitive,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 檢查 create/delete topics 的逐主題結果，任一失敗即回錯。
fn check_topic_results(results: Vec<rdkafka::admin::TopicResult>) -> AppResult<()> {
    for r in results {
        if let Err((name, code)) = r {
            return Err(AppError::Query(format!("{name}: {code}")));
        }
    }
    Ok(())
}

/// 解析 consumer 協定的 MemberAssignment bytes → 指派的 (topic, partition) 清單。
/// 格式：version:i16, topics:[{name:string(i16 len), partitions:[i32](i32 count)}], userdata:bytes。
fn parse_assignment(bytes: &[u8]) -> Vec<(String, i32)> {
    fn rd_i16(b: &[u8], p: &mut usize) -> Option<i16> {
        if *p + 2 > b.len() {
            return None;
        }
        let v = i16::from_be_bytes([b[*p], b[*p + 1]]);
        *p += 2;
        Some(v)
    }
    fn rd_i32(b: &[u8], p: &mut usize) -> Option<i32> {
        if *p + 4 > b.len() {
            return None;
        }
        let v = i32::from_be_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]);
        *p += 4;
        Some(v)
    }
    let mut out = Vec::new();
    let mut p = 0usize;
    let _version = rd_i16(bytes, &mut p);
    let topic_count = match rd_i32(bytes, &mut p) {
        Some(c) if c >= 0 => c,
        _ => return out,
    };
    for _ in 0..topic_count {
        let name_len = match rd_i16(bytes, &mut p) {
            Some(l) if l >= 0 => l as usize,
            _ => return out,
        };
        if p + name_len > bytes.len() {
            return out;
        }
        let name = String::from_utf8_lossy(&bytes[p..p + name_len]).to_string();
        p += name_len;
        let part_count = match rd_i32(bytes, &mut p) {
            Some(c) if c >= 0 => c,
            _ => return out,
        };
        for _ in 0..part_count {
            match rd_i32(bytes, &mut p) {
                Some(part) => out.push((name.clone(), part)),
                None => return out,
            }
        }
    }
    out
}

fn describe_group_blocking(
    base: &ClientConfig,
    meta: &BaseConsumer,
    group: &str,
) -> AppResult<KafkaGroupDetail> {
    let gl = meta
        .fetch_group_list(Some(group), Duration::from_secs(15))
        .map_err(query_err)?;
    let g = gl
        .groups()
        .iter()
        .find(|g| g.name() == group)
        .ok_or_else(|| AppError::Query(format!("找不到群組 {group}")))?;
    let state = g.state().to_string();

    // 聚合所有成員的指派 TP。
    let mut tp_set: BTreeSet<(String, i32)> = BTreeSet::new();
    let gm = safe_members(g);
    let mut members = Vec::with_capacity(gm.len());
    for m in gm {
        let assigned = m.assignment().map(parse_assignment).unwrap_or_default();
        for (t, part) in &assigned {
            tp_set.insert((t.clone(), *part));
        }
        members.push(KafkaGroupMember {
            member_id: m.id().to_string(),
            client_id: m.client_id().to_string(),
            host: m.client_host().to_string(),
            assignments: assigned.iter().map(|(t, part)| format!("{t}:{part}")).collect(),
        });
    }

    // 以 group.id 建臨時 consumer 取 committed offset，配 watermark 算 lag。
    let mut offsets = Vec::new();
    if !tp_set.is_empty() {
        let mut cc = base.clone();
        cc.set("group.id", group);
        cc.set("enable.auto.commit", "false");
        let consumer: BaseConsumer = cc.create().map_err(query_err)?;
        let mut tpl = TopicPartitionList::new();
        for (t, part) in &tp_set {
            tpl.add_partition(t, *part);
        }
        let committed = consumer
            .committed_offsets(tpl, Duration::from_secs(15))
            .map_err(query_err)?;
        for elem in committed.elements() {
            let topic = elem.topic().to_string();
            let partition = elem.partition();
            let current = match elem.offset() {
                Offset::Offset(o) => o,
                _ => -1,
            };
            let (_low, high) = consumer
                .fetch_watermarks(&topic, partition, Duration::from_secs(10))
                .map_err(query_err)?;
            let lag = if current >= 0 { (high - current).max(0) } else { 0 };
            offsets.push(KafkaGroupOffset {
                topic,
                partition,
                current,
                log_end: high,
                lag,
            });
        }
        offsets.sort_by(|a, b| a.topic.cmp(&b.topic).then(a.partition.cmp(&b.partition)));
    }

    Ok(KafkaGroupDetail {
        group_id: group.to_string(),
        state,
        members,
        offsets,
    })
}

/// 解析重設計畫：分區來源 = 主題 metadata（交集 `reset.partitions`）；current 走
/// committed_offsets（OffsetFetch 不需 join group）；目標依模式解析並 clamp 至 [low, high]。
/// Shift 遇無已提交位移（current = -1）之分區 → target = None（略過）。
fn resolve_reset_plan(
    consumer: &BaseConsumer,
    meta: &BaseConsumer,
    reset: &KafkaOffsetReset,
) -> AppResult<Vec<KafkaOffsetPlanRow>> {
    let md = meta
        .fetch_metadata(Some(&reset.topic), Duration::from_secs(10))
        .map_err(query_err)?;
    let topic_md = md
        .topics()
        .iter()
        .find(|t| t.name() == reset.topic)
        .ok_or_else(|| AppError::Query(format!("找不到主題 {}", reset.topic)))?;
    let mut pids: Vec<i32> = topic_md.partitions().iter().map(|p| p.id()).collect();
    if let Some(sel) = &reset.partitions {
        if !sel.is_empty() {
            pids.retain(|p| sel.contains(p));
        }
    }
    if pids.is_empty() {
        return Err(AppError::Query(t!("沒有符合的分區").into()));
    }
    pids.sort_unstable();

    let mut tpl = TopicPartitionList::new();
    for &pid in &pids {
        tpl.add_partition(&reset.topic, pid);
    }
    let committed = consumer
        .committed_offsets(tpl, Duration::from_secs(15))
        .map_err(query_err)?;
    let current: std::collections::HashMap<i32, i64> = committed
        .elements()
        .iter()
        .map(|e| {
            (
                e.partition(),
                match e.offset() {
                    Offset::Offset(o) => o,
                    _ => -1,
                },
            )
        })
        .collect();

    // timestamp 目標先解析。
    let ts_offsets = if let KafkaResetTarget::Timestamp { ts } = &reset.target {
        let mut q = TopicPartitionList::new();
        for &pid in &pids {
            q.add_partition_offset(&reset.topic, pid, Offset::Offset(*ts))
                .map_err(query_err)?;
        }
        let resolved = consumer
            .offsets_for_times(q, Duration::from_secs(10))
            .map_err(query_err)?;
        resolved
            .elements()
            .iter()
            .filter_map(|e| match e.offset() {
                Offset::Offset(o) => Some((e.partition(), o)),
                _ => None,
            })
            .collect::<std::collections::HashMap<i32, i64>>()
    } else {
        std::collections::HashMap::new()
    };

    let mut rows = Vec::with_capacity(pids.len());
    for &pid in &pids {
        let (low, high) = consumer
            .fetch_watermarks(&reset.topic, pid, Duration::from_secs(10))
            .map_err(query_err)?;
        let cur = current.get(&pid).copied().unwrap_or(-1);
        let target = match &reset.target {
            KafkaResetTarget::Beginning => Some(low),
            KafkaResetTarget::End => Some(high),
            KafkaResetTarget::Offset { offset } => Some((*offset).clamp(low, high)),
            KafkaResetTarget::Timestamp { .. } => {
                // 時間戳晚於最後一筆 → offsets_for_times 查無 → 回 high（追到最新）。
                Some(ts_offsets.get(&pid).copied().unwrap_or(high).clamp(low, high))
            }
            KafkaResetTarget::Shift { by } => {
                if cur < 0 {
                    None
                } else {
                    Some((cur + by).clamp(low, high))
                }
            }
        };
        rows.push(KafkaOffsetPlanRow {
            partition: pid,
            current: cur,
            target,
            low,
            high,
        });
    }
    Ok(rows)
}

fn reset_offsets_blocking(
    base: &ClientConfig,
    meta: &BaseConsumer,
    reset: &KafkaOffsetReset,
) -> AppResult<Vec<KafkaOffsetPlanRow>> {
    // 群組須為 Empty（無活躍成員）。
    let gl = meta
        .fetch_group_list(Some(&reset.group), Duration::from_secs(15))
        .map_err(query_err)?;
    if let Some(g) = gl.groups().iter().find(|g| g.name() == reset.group) {
        if !safe_members(g).is_empty() {
            return Err(AppError::Query(
                t!("群組仍有活躍成員，無法重設位移（請先停掉消費者）").into(),
            ));
        }
    }

    let mut cc = base.clone();
    cc.set("group.id", &reset.group);
    cc.set("enable.auto.commit", "false");
    cc.set("auto.offset.reset", "earliest");
    let consumer: BaseConsumer = cc.create().map_err(query_err)?;

    // 先解析計畫（committed / watermark / 目標），再 join group commit。
    let plan = resolve_reset_plan(&consumer, meta, reset)?;

    // subscribe 讓 consumer 成為群組唯一成員（群組本為 Empty）→ commit 有 coordinator 不會久掛
    //（rdkafka AdminClient 無 alter offsets；assign-only 的裸 commit 會無限等待 coordinator）。
    consumer
        .subscribe(&[reset.topic.as_str()])
        .map_err(query_err)?;
    let start = Instant::now();
    let mut joined = false;
    while start.elapsed() < Duration::from_secs(20) {
        let _ = consumer.poll(Duration::from_millis(200));
        if let Ok(a) = consumer.assignment() {
            if !a.elements().is_empty() {
                joined = true;
                break;
            }
        }
    }
    if !joined {
        return Err(AppError::Query(t!("重設逾時：無法取得群組分區指派").into()));
    }

    let mut tpl = TopicPartitionList::new();
    for row in plan.iter().filter(|r| r.target.is_some()) {
        tpl.add_partition_offset(
            &reset.topic,
            row.partition,
            Offset::Offset(row.target.unwrap_or(0)),
        )
        .map_err(query_err)?;
    }
    if tpl.count() == 0 {
        consumer.unsubscribe();
        return Err(AppError::Query(t!("沒有可套用的分區（皆無已提交位移）").into()));
    }

    consumer.commit(&tpl, CommitMode::Sync).map_err(query_err)?;
    consumer.unsubscribe();
    Ok(plan)
}
