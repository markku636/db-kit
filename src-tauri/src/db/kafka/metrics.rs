//! 健康風險掃描（一次性）。以單次 metadata + 批次 describe_configs + 群組 lag 掃描，
//! 找出資料遺失 / 可用性風險：RF=1、離線分區、URP、under-min-ISR、高 Lag 群組。

use std::time::Duration;

use rdkafka::admin::{AdminOptions, ResourceSpecifier};
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};

use super::dto::{KafkaHealthItem, KafkaHealthReport};
use super::{query_err, KafkaDriver};
use crate::error::AppResult;

/// 群組 lag 觸及此值即列為風險（掃描用固定門檻）。
const GROUP_LAG_THRESHOLD: i64 = 10_000;

impl KafkaDriver {
    /// 一次性健康掃描。回傳風險項清單 + 主題 / 分區總數。
    pub async fn health_scan(&self) -> AppResult<KafkaHealthReport> {
        let meta = self.meta.clone();
        let base = self.base.clone();
        let admin_min_isr = self.min_isr_map().await;

        tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(None, Duration::from_secs(10))
                .map_err(query_err)?;
            let min_isr = admin_min_isr;
            let mut items: Vec<KafkaHealthItem> = Vec::new();
            let mut topics_total = 0u32;
            let mut partitions_total = 0u32;

            for t in md.topics() {
                if super::is_internal_topic(t.name()) {
                    continue;
                }
                topics_total += 1;
                let rf = t.partitions().first().map(|p| p.replicas().len()).unwrap_or(0);
                if rf == 1 {
                    items.push(KafkaHealthItem {
                        severity: "medium".into(),
                        kind: "rf1".into(),
                        target: t.name().to_string(),
                        detail: "複本因子為 1，broker 故障即遺失資料".into(),
                        value: 1,
                    });
                }
                let want_isr = min_isr.get(t.name()).copied().unwrap_or(1);
                let mut offline = 0i64;
                let mut urp = 0i64;
                let mut under_min = 0i64;
                for p in t.partitions() {
                    partitions_total += 1;
                    if p.leader() == -1 {
                        offline += 1;
                    }
                    let isr = p.isr().len();
                    if isr < p.replicas().len() {
                        urp += 1;
                    }
                    if (isr as i32) < want_isr {
                        under_min += 1;
                    }
                }
                if offline > 0 {
                    items.push(KafkaHealthItem {
                        severity: "high".into(),
                        kind: "offline".into(),
                        target: t.name().to_string(),
                        detail: format!("{offline} 個分區無 leader（離線）"),
                        value: offline,
                    });
                }
                if urp > 0 {
                    items.push(KafkaHealthItem {
                        severity: "medium".into(),
                        kind: "urp".into(),
                        target: t.name().to_string(),
                        detail: format!("{urp} 個分區未同步複寫（URP）"),
                        value: urp,
                    });
                }
                if under_min > 0 {
                    items.push(KafkaHealthItem {
                        severity: "high".into(),
                        kind: "under_min_isr".into(),
                        target: t.name().to_string(),
                        detail: format!("{under_min} 個分區 ISR < min.insync.replicas({want_isr})，可能拒絕寫入"),
                        value: under_min,
                    });
                }
            }

            // 群組 lag：對每個非空群組計算總 lag，超門檻列為風險。
            if let Ok(gl) = meta.fetch_group_list(None, Duration::from_secs(15)) {
                for g in gl.groups() {
                    let state = g.state();
                    if state == "Empty" || state == "Dead" {
                        continue;
                    }
                    if let Some(lag) = group_total_lag(&base, meta.as_ref(), g.name()) {
                        if lag >= GROUP_LAG_THRESHOLD {
                            items.push(KafkaHealthItem {
                                severity: "medium".into(),
                                kind: "group_lag".into(),
                                target: g.name().to_string(),
                                detail: format!("消費者群組總 lag {lag}"),
                                value: lag,
                            });
                        }
                    }
                }
            }

            // 依 severity 排序（high → medium → info）。
            let rank = |s: &str| match s {
                "high" => 0,
                "medium" => 1,
                _ => 2,
            };
            items.sort_by_key(|i| rank(&i.severity));

            Ok(KafkaHealthReport {
                scanned_at: 0, // 由前端 / 指令層戳時間
                items,
                topics_total,
                partitions_total,
            })
        })
        .await
        .map_err(query_err)?
    }

    /// 批次 describe_configs 取各主題 min.insync.replicas（失敗回空 map，退回預設 1）。
    async fn min_isr_map(&self) -> std::collections::HashMap<String, i32> {
        let mut out = std::collections::HashMap::new();
        let md = match self.meta.fetch_metadata(None, Duration::from_secs(10)) {
            Ok(m) => m,
            Err(_) => return out,
        };
        let names: Vec<String> = md
            .topics()
            .iter()
            .filter(|t| !super::is_internal_topic(t.name()))
            .map(|t| t.name().to_string())
            .collect();
        if names.is_empty() {
            return out;
        }
        let specs: Vec<ResourceSpecifier> =
            names.iter().map(|n| ResourceSpecifier::Topic(n)).collect();
        let opts = AdminOptions::new().request_timeout(Some(Duration::from_secs(15)));
        if let Ok(results) = self.admin.describe_configs(&specs, &opts).await {
            for r in results.into_iter().flatten() {
                let topic = match &r.specifier {
                    rdkafka::admin::OwnedResourceSpecifier::Topic(n) => n.clone(),
                    _ => continue,
                };
                if let Some(entry) = r.entries.iter().find(|e| e.name == "min.insync.replicas") {
                    if let Some(v) = entry.value.as_ref().and_then(|v| v.parse::<i32>().ok()) {
                        out.insert(topic, v);
                    }
                }
            }
        }
        out
    }
}

/// 某群組所有已提交分區的總 lag（無提交回 0；失敗回 None）。
fn group_total_lag(
    base: &rdkafka::ClientConfig,
    meta: &BaseConsumer,
    group: &str,
) -> Option<i64> {
    let gl = meta.fetch_group_list(Some(group), Duration::from_secs(10)).ok()?;
    let g = gl.groups().iter().find(|g| g.name() == group)?;
    // 聚合成員指派的 TP。
    let mut tpl = TopicPartitionList::new();
    for m in g.members() {
        if let Some(assignment) = m.assignment() {
            for (topic, part) in super::admin::parse_assignment_pub(assignment) {
                tpl.add_partition(&topic, part);
            }
        }
    }
    if tpl.count() == 0 {
        return Some(0);
    }
    let mut cc = base.clone();
    cc.set("group.id", group);
    cc.set("enable.auto.commit", "false");
    let consumer: BaseConsumer = cc.create().ok()?;
    let committed = consumer
        .committed_offsets(tpl, Duration::from_secs(15))
        .ok()?;
    let mut total = 0i64;
    for e in committed.elements() {
        let current = match e.offset() {
            Offset::Offset(o) => o,
            _ => continue,
        };
        if let Ok((_low, high)) =
            consumer.fetch_watermarks(e.topic(), e.partition(), Duration::from_secs(10))
        {
            total += (high - current).max(0);
        }
    }
    Some(total)
}
