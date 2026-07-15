//! Metadata / Admin 操作。P2：主題清單、叢集資訊、分區。P4/P5 續補群組 / 建刪主題 / 設定。
//!
//! 全部 metadata / watermark 查詢是阻塞式 C 呼叫，一律走 `spawn_blocking`。

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use rdkafka::admin::{
    AdminOptions, AlterConfig, NewTopic, ResourceSpecifier, TopicReplication,
};
use rdkafka::consumer::{BaseConsumer, CommitMode, Consumer};
use rdkafka::groups::{GroupInfo, GroupMemberInfo};
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};
use rdkafka::ClientConfig;

/// 安全取群組成員：規避 rdkafka 0.36 對「空群組（member_cnt=0、members 指標為 null）」
/// 呼叫 `members()` 時 `slice::from_raw_parts(null, 0)` 的 UB —— 在 debug build 會 abort。
/// Empty / Dead 為確定零成員的終端狀態，直接回空切片，不觸碰 null 指標。
fn safe_members(g: &GroupInfo) -> &[GroupMemberInfo] {
    match g.state() {
        "Empty" | "Dead" => &[],
        _ => g.members(),
    }
}

use super::dto::{
    KafkaBroker, KafkaClusterInfo, KafkaConfigEntry, KafkaConsumerGroup, KafkaCreateTopicSpec,
    KafkaGroupDetail, KafkaGroupMember, KafkaGroupOffset, KafkaHeader, KafkaOffsetReset,
    KafkaPartitionInfo, KafkaStart, KafkaTopic,
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

    /// 叢集資訊（brokers）。
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
            Ok(KafkaClusterInfo {
                bootstrap,
                broker_count: brokers.len() as u32,
                brokers,
                orig_broker_id: md.orig_broker_id(),
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

    /// 重設群組位移（群組須為 Empty，無活躍成員）。
    pub async fn reset_offsets(&self, reset: &KafkaOffsetReset) -> AppResult<()> {
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

    /// 變更主題設定（AlterConfigs 為整體取代語意；呼叫端須帶完整設定）。
    pub async fn alter_topic_config(&self, topic: &str, configs: &[KafkaHeader]) -> AppResult<()> {
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(15)));
        let mut ac = AlterConfig::new(ResourceSpecifier::Topic(topic));
        for h in configs {
            ac = ac.set(&h.key, &h.value);
        }
        let res = self
            .admin
            .alter_configs(&[ac], &opts)
            .await
            .map_err(query_err)?;
        for r in res {
            if let Err((_, code)) = r {
                return Err(AppError::Query(format!("設定變更失敗：{code}")));
            }
        }
        Ok(())
    }

    /// 讀取主題設定（describe configs）。
    pub async fn topic_config(&self, topic: &str) -> AppResult<Vec<KafkaConfigEntry>> {
        let opts = AdminOptions::new().request_timeout(Some(Duration::from_secs(15)));
        let res = self
            .admin
            .describe_configs(&[ResourceSpecifier::Topic(topic)], &opts)
            .await
            .map_err(query_err)?;
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

fn reset_offsets_blocking(
    base: &ClientConfig,
    meta: &BaseConsumer,
    reset: &KafkaOffsetReset,
) -> AppResult<()> {
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

    // subscribe 讓 consumer 成為群組唯一成員（群組本為 Empty）→ commit 有 coordinator 不會久掛
    //（rdkafka 0.36 AdminClient 無 alter offsets；assign-only 的裸 commit 會無限等待 coordinator）。
    consumer
        .subscribe(&[reset.topic.as_str()])
        .map_err(query_err)?;
    let start = Instant::now();
    let mut assigned: Vec<i32> = Vec::new();
    while start.elapsed() < Duration::from_secs(20) {
        let _ = consumer.poll(Duration::from_millis(200));
        if let Ok(a) = consumer.assignment() {
            let ids: Vec<i32> = a.elements().iter().map(|e| e.partition()).collect();
            if !ids.is_empty() {
                assigned = ids;
                break;
            }
        }
    }
    if assigned.is_empty() {
        return Err(AppError::Query(t!("重設逾時：無法取得群組分區指派").into()));
    }

    // 目標分區（指定或全部指派）。
    let part_ids: Vec<i32> = match &reset.partitions {
        Some(p) if !p.is_empty() => p.clone(),
        _ => assigned,
    };

    // timestamp 目標先解析。
    let ts_offsets = if let KafkaStart::Timestamp { ts } = &reset.target {
        let mut q = TopicPartitionList::new();
        for &pid in &part_ids {
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

    let mut tpl = TopicPartitionList::new();
    for pid in part_ids {
        let (low, high) = consumer
            .fetch_watermarks(&reset.topic, pid, Duration::from_secs(10))
            .map_err(query_err)?;
        let off = match &reset.target {
            KafkaStart::Beginning => low,
            KafkaStart::End => high,
            KafkaStart::Offset { offset } => (*offset).clamp(low, high),
            KafkaStart::Timestamp { .. } => {
                ts_offsets.get(&pid).copied().unwrap_or(high).clamp(low, high)
            }
        };
        tpl.add_partition_offset(&reset.topic, pid, Offset::Offset(off))
            .map_err(query_err)?;
    }

    consumer.commit(&tpl, CommitMode::Sync).map_err(query_err)?;
    consumer.unsubscribe();
    Ok(())
}
