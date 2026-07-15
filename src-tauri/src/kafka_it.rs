//! Kafka 後端整合測試（對 live broker）。
//!
//! 預設略過（CI 無 broker）；設 `DBKIT_KAFKA_IT=1` 且本機有 Kafka on localhost:9092 才實跑。
//! 可用 `DBKIT_KAFKA_BROKER` 覆寫 bootstrap。
//!
//! 執行：
//!   $env:DBKIT_KAFKA_IT="1"; cargo test --features kafka kafka_it -- --nocapture

#![cfg(all(test, feature = "kafka"))]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::db::kafka::dto::{
    KafkaConsumeQuery, KafkaCreateTopicSpec, KafkaHeader, KafkaOffsetReset, KafkaProduceRequest,
    KafkaResetTarget, KafkaStart,
};
use crate::db::kafka::KafkaDriver;
use crate::db::{ConnectionConfig, DatabaseDriver, DbKind};

fn broker() -> String {
    std::env::var("DBKIT_KAFKA_BROKER").unwrap_or_else(|_| "localhost:9092".to_string())
}

fn cfg() -> ConnectionConfig {
    let hostport = broker();
    let (host, port) = hostport
        .rsplit_once(':')
        .map(|(h, p)| (h.to_string(), p.parse::<u16>().unwrap_or(9092)))
        .unwrap_or((hostport.clone(), 9092));
    ConnectionConfig {
        id: "kafka-it".into(),
        name: "kafka-it".into(),
        kind: DbKind::Kafka,
        host,
        port,
        username: String::new(),
        password: String::new(),
        database: None,
        max_connections: 5,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_username: String::new(),
        ssh_auth_method: Default::default(),
        ssh_password: String::new(),
        ssh_private_key_path: String::new(),
        ssh_passphrase: String::new(),
        options: Default::default(),
        otp_secret: String::new(),
    }
}

fn uniq() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kafka_end_to_end() {
    if std::env::var("DBKIT_KAFKA_IT").is_err() {
        eprintln!("[kafka_it] skipped (set DBKIT_KAFKA_IT=1 with a broker on {})", broker());
        return;
    }

    let d = KafkaDriver::connect(&cfg()).await.expect("connect");
    d.ping().await.expect("ping");
    eprintln!("[kafka_it] connect + ping OK");

    // 叢集資訊（含健康摘要 / 控制器 / broker 設定）
    let ci = d.cluster_info().await.expect("cluster_info");
    assert!(ci.broker_count >= 1, "broker_count >= 1");
    assert!(ci.controller_id >= 0, "controller_id resolved");
    assert!(ci.cluster_id.is_some(), "cluster_id resolved");
    // 單 broker 測試環境不應有 URP / 離線分區
    assert_eq!(ci.under_replicated, 0, "no URP on single-broker env");
    assert_eq!(ci.offline_partitions, 0, "no offline partitions");
    assert!(!ci.librdkafka_version.is_empty(), "librdkafka version");
    let bc = d
        .broker_config(ci.brokers[0].id)
        .await
        .expect("broker_config");
    assert!(!bc.is_empty(), "broker config entries non-empty");
    eprintln!(
        "[kafka_it] cluster: {} broker(s), controller={}, topics={}, partitions={}, broker cfg {} entries",
        ci.broker_count, ci.controller_id, ci.topic_count, ci.partition_count, bc.len()
    );

    let id = uniq();
    let topic = format!("dbkit-it-{id}");
    let group = format!("dbkit-it-grp-{id}");

    // 建立主題（2 分區）
    d.create_topic(&KafkaCreateTopicSpec {
        name: topic.clone(),
        partitions: 2,
        replication: 1,
        config: vec![KafkaHeader { key: "retention.ms".into(), value: "600000".into() }],
    })
    .await
    .expect("create_topic");
    eprintln!("[kafka_it] created topic {topic} (2 partitions)");

    // 主題清單含新主題（metadata 最終一致 → poll 至出現）
    let mut appeared = false;
    for _ in 0..20 {
        let topics = d.list_topics().await.expect("list_topics");
        if topics.iter().any(|t| t.name == topic) {
            appeared = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(appeared, "topic {topic} should appear in list_topics");

    // 分區資訊（poll 至 2 分區且 leader 選出；剛建立時可能短暫 NotLeaderForPartition）
    let mut parts = Vec::new();
    for _ in 0..30 {
        match d.topic_partitions(&topic).await {
            Ok(p) if p.len() == 2 && p.iter().all(|x| x.leader >= 0) => {
                parts = p;
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
    assert_eq!(parts.len(), 2, "topic has 2 partitions with leaders elected");

    // 主題設定（describe configs）— 至少能取回
    let conf = d.topic_config(&topic).await.expect("topic_config");
    assert!(!conf.is_empty(), "topic_config non-empty");
    eprintln!("[kafka_it] topic_partitions=2, topic_config={} entries", conf.len());

    // 設定編輯（merged-full-set）：新增第二個覆寫不可弄丟建題時的 retention.ms 覆寫
    d.set_topic_config(&topic, "max.message.bytes", Some("2097152"))
        .await
        .expect("set_topic_config");
    let conf = d.topic_config(&topic).await.expect("topic_config after set");
    let src = |name: &str| {
        conf.iter()
            .find(|c| c.name == name)
            .map(|c| c.source.clone())
            .unwrap_or_default()
    };
    assert_eq!(src("max.message.bytes"), "DynamicTopic", "new override applied");
    assert_eq!(src("retention.ms"), "DynamicTopic", "existing override survives merge");
    // 還原 retention.ms：該鍵回預設，但 max.message.bytes 覆寫仍在
    d.set_topic_config(&topic, "retention.ms", None)
        .await
        .expect("revert retention.ms");
    let conf = d.topic_config(&topic).await.expect("topic_config after revert");
    let src2 = |name: &str| {
        conf.iter()
            .find(|c| c.name == name)
            .map(|c| c.source.clone())
            .unwrap_or_default()
    };
    assert_ne!(src2("retention.ms"), "DynamicTopic", "reverted key back to default");
    assert_eq!(src2("max.message.bytes"), "DynamicTopic", "other override untouched");
    eprintln!("[kafka_it] set_topic_config merge + revert OK");

    // 發佈 6 則（JSON value + header）
    for i in 0..6 {
        let r = d
            .produce(&KafkaProduceRequest {
                topic: topic.clone(),
                partition: None,
                key: Some(format!("k{i}")),
                value: Some(format!("{{\"n\":{i}}}")),
                headers: vec![KafkaHeader { key: "src".into(), value: "it".into() }],
            })
            .await
            .expect("produce");
        assert!(r.offset >= 0, "produce returns offset");
    }
    eprintln!("[kafka_it] produced 6 messages");

    // 有界消費（從頭）— 應收到 6 則，且 JSON value 被判為 json
    let msgs = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 100, filter: None, key_deser: None, value_deser: None, scan: None, js_filter: None },
            None,
            None,
        )
        .await
        .expect("consume_page")
        .messages;
    assert!(msgs.len() >= 6, "consumed >= 6, got {}", msgs.len());
    assert!(msgs.iter().any(|m| m.value_encoding == "json"), "json encoding detected");
    assert!(msgs.iter().any(|m| m.headers.iter().any(|h| h.key == "src")), "headers preserved");
    eprintln!("[kafka_it] consume_page(Beginning) got {} msgs, json+headers OK", msgs.len());

    // 反序列化覆寫：value_deser="hex" → 一律 binary；"string" → 一律 string
    let hexed = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 10, filter: None, key_deser: None, value_deser: Some("hex".into()), scan: None, js_filter: None },
            None,
            None,
        )
        .await
        .expect("consume hex deser")
        .messages;
    assert!(!hexed.is_empty() && hexed.iter().all(|m| m.value_encoding == "binary"), "hex deser forces binary");
    let stringy = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 10, filter: None, key_deser: None, value_deser: Some("string".into()), scan: None, js_filter: None },
            None,
            None,
        )
        .await
        .expect("consume string deser")
        .messages;
    assert!(stringy.iter().all(|m| m.value_encoding == "string"), "string deser forces string");
    eprintln!("[kafka_it] deser override (hex/string) OK");

    // 篩選消費（filter=n":3 → 命中 1 則）
    let filtered = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 100, filter: Some("\"n\":3".into()), key_deser: None, value_deser: None, scan: None, js_filter: None },
            None,
            None,
        )
        .await
        .expect("consume filtered")
        .messages;
    assert_eq!(filtered.len(), 1, "filter matched exactly 1, got {}", filtered.len());
    eprintln!("[kafka_it] consume_page(filter) matched {}", filtered.len());

    // 搜尋更多（scan）：limit=2 + filter 命中僅 1 筆 + max_scan → matched==1、reached_end==true、scanned>2
    let scanned = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery {
                partition: None,
                start: KafkaStart::Beginning,
                limit: 2,
                filter: Some("\"n\":3".into()),
                key_deser: None,
                value_deser: None,
                scan: Some(crate::db::kafka::dto::KafkaScanOptions { max_scan: 1000, max_wait_ms: Some(15000) }),
                js_filter: None,
            },
            None,
            None,
        )
        .await
        .expect("consume scan");
    assert_eq!(scanned.matched, 1, "scan matched 1");
    assert!(scanned.reached_end, "scan reached end");
    assert!(scanned.scanned >= 6, "scan scanned all 6, got {}", scanned.scanned);
    eprintln!("[kafka_it] scan (search-more) matched={} scanned={} end={}", scanned.matched, scanned.scanned, scanned.reached_end);

    // JS 篩選（kafka-js feature）：json.n > 3 → 命中 2（n=4,5）；壞運算式 → Err
    #[cfg(feature = "kafka-js")]
    {
        let js = d
            .consume_page(
                &topic,
                &KafkaConsumeQuery {
                    partition: None, start: KafkaStart::Beginning, limit: 100,
                    filter: None, key_deser: None, value_deser: None, scan: None,
                    js_filter: Some("json && json.n > 3".into()),
                },
                None,
                None,
            )
            .await
            .expect("consume js_filter");
        assert_eq!(js.matched, 2, "js json.n>3 matched 2, got {}", js.matched);
        let bad = d
            .consume_page(
                &topic,
                &KafkaConsumeQuery {
                    partition: None, start: KafkaStart::Beginning, limit: 10,
                    filter: None, key_deser: None, value_deser: None, scan: None,
                    js_filter: Some("this is (( not valid".into()),
                },
                None,
                None,
            )
            .await;
        assert!(bad.is_err(), "invalid js_filter compile error surfaced");
        eprintln!("[kafka_it] js_filter matched={} + compile-error OK", js.matched);
    }

    // live-tail：BaseConsumer assign@End，發佈後 poll 到；drop 快速返回
    let consumer = d.build_tail_consumer(&topic, None, KafkaStart::End).await.expect("build_tail_consumer");
    tokio::time::sleep(Duration::from_millis(800)).await; // 等 assign 生效
    d.produce(&KafkaProduceRequest {
        topic: topic.clone(),
        partition: None,
        key: Some("tail".into()),
        value: Some("tail-value".into()),
        headers: vec![],
    })
    .await
    .expect("produce for tail");
    let mut got_tail = false;
    let tstart = std::time::Instant::now();
    while tstart.elapsed() < Duration::from_secs(15) {
        if let Some(Ok(_)) = consumer.poll(Duration::from_millis(250)) {
            got_tail = true;
            break;
        }
    }
    assert!(got_tail, "live-tail should poll the produced msg");
    eprintln!("[kafka_it] live-tail poll OK");
    drop(consumer);
    eprintln!("[kafka_it] dropped tail consumer");

    // 位移重設：預覽（Beginning → target == low）→ 套用（建立 Empty 群組的 committed offset）
    let preview = d
        .preview_reset(&KafkaOffsetReset {
            group: group.clone(),
            topic: topic.clone(),
            target: KafkaResetTarget::Beginning,
            partitions: None,
        })
        .await
        .expect("preview_reset beginning");
    assert_eq!(preview.len(), 2, "preview covers 2 partitions");
    assert!(
        preview.iter().all(|r| r.target == Some(r.low)),
        "beginning preview targets == low"
    );
    assert!(
        preview.iter().all(|r| r.current == -1),
        "no committed offsets before first reset"
    );
    let rr = tokio::time::timeout(
        Duration::from_secs(20),
        d.reset_offsets(&KafkaOffsetReset {
            group: group.clone(),
            topic: topic.clone(),
            target: KafkaResetTarget::Beginning,
            partitions: None,
        }),
    )
    .await;
    match rr {
        Ok(Ok(plan)) => {
            assert_eq!(plan.len(), 2, "applied plan covers 2 partitions");
            eprintln!("[kafka_it] reset_offsets(Beginning) OK");
        }
        Ok(Err(e)) => panic!("reset_offsets error: {e:?}"),
        Err(_) => panic!("reset_offsets timed out (20s)"),
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Shift：現值 low + by（clamp 下限 low）；先重設到 End 再平移 -2 驗證
    let rr = tokio::time::timeout(
        Duration::from_secs(20),
        d.reset_offsets(&KafkaOffsetReset {
            group: group.clone(),
            topic: topic.clone(),
            target: KafkaResetTarget::End,
            partitions: None,
        }),
    )
    .await;
    assert!(matches!(rr, Ok(Ok(_))), "reset to End: {rr:?}");
    let shifted = d
        .preview_reset(&KafkaOffsetReset {
            group: group.clone(),
            topic: topic.clone(),
            target: KafkaResetTarget::Shift { by: -2 },
            partitions: None,
        })
        .await
        .expect("preview shift");
    assert!(
        shifted
            .iter()
            .all(|r| r.target == Some((r.current - 2).clamp(r.low, r.high))),
        "shift -2 targets clamp(current-2): {shifted:?}"
    );
    eprintln!("[kafka_it] preview_reset(Shift -2) OK");

    let groups = d.list_groups().await.expect("list_groups");
    assert!(groups.iter().any(|g| g.group_id == group), "list_groups contains {group}");
    // describe 不應報錯（Empty 群組無 active member → offsets 可能為空，屬預期）
    let detail = d.describe_group(&group).await.expect("describe_group");
    assert_eq!(detail.group_id, group);
    eprintln!("[kafka_it] reset/preview + list_groups + describe_group OK (state={})", detail.state);

    // 清空（DeleteRecords）：先單分區、再全主題；清空後從頭消費應為 0 筆
    let rs = d
        .delete_records(&topic, Some(&[0]), None)
        .await
        .expect("delete_records p0");
    assert_eq!(rs.len(), 1, "one partition result");
    assert!(rs[0].error.is_none(), "p0 empty ok: {:?}", rs[0].error);
    let rs = d
        .delete_records(&topic, None, None)
        .await
        .expect("delete_records all");
    assert_eq!(rs.len(), 2, "two partition results");
    assert!(rs.iter().all(|r| r.error.is_none()), "all partitions emptied");
    let mut drained = false;
    for _ in 0..20 {
        let after = d
            .consume_page(
                &topic,
                &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 100, filter: None, key_deser: None, value_deser: None, scan: None, js_filter: None },
                None,
                None,
            )
            .await
            .expect("consume after empty")
            .messages;
        if after.is_empty() {
            drained = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(drained, "topic drained after delete_records");
    eprintln!("[kafka_it] delete_records (partition + all) OK");

    // 刪除消費者群組（reset 產生的 Empty 群組）→ poll 至消失
    d.delete_group(&group).await.expect("delete_group");
    let mut gone = false;
    for _ in 0..20 {
        let gs = d.list_groups().await.expect("list_groups after delete");
        if !gs.iter().any(|g| g.group_id == group) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(gone, "group {group} deleted");
    eprintln!("[kafka_it] delete_group OK");

    // 加分割區：2 → 3（放在所有分區敏感斷言之後、清理之前）
    d.add_partitions(&topic, 3).await.expect("add_partitions");
    let mut grown = false;
    for _ in 0..20 {
        if let Ok(p) = d.topic_partitions(&topic).await {
            if p.len() == 3 && p.iter().all(|x| x.leader >= 0) {
                grown = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(grown, "partitions grew to 3 with leaders elected");
    // 不可縮減 / 等於現數 → 應報錯
    assert!(d.add_partitions(&topic, 3).await.is_err(), "add_partitions(<=current) rejected");
    eprintln!("[kafka_it] add_partitions 2→3 OK");

    // 清理
    d.delete_topic(&topic).await.expect("delete_topic");
    d.close().await;
    eprintln!("[kafka_it] delete_topic + close OK — ALL PASSED");
}
