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
    KafkaStart,
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

    // 叢集資訊
    let ci = d.cluster_info().await.expect("cluster_info");
    assert!(ci.broker_count >= 1, "broker_count >= 1");
    eprintln!("[kafka_it] cluster: {} broker(s), bootstrap={}", ci.broker_count, ci.bootstrap);

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
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 100, filter: None },
        )
        .await
        .expect("consume_page");
    assert!(msgs.len() >= 6, "consumed >= 6, got {}", msgs.len());
    assert!(msgs.iter().any(|m| m.value_encoding == "json"), "json encoding detected");
    assert!(msgs.iter().any(|m| m.headers.iter().any(|h| h.key == "src")), "headers preserved");
    eprintln!("[kafka_it] consume_page(Beginning) got {} msgs, json+headers OK", msgs.len());

    // 篩選消費（filter=n":3 → 命中 1 則）
    let filtered = d
        .consume_page(
            &topic,
            &KafkaConsumeQuery { partition: None, start: KafkaStart::Beginning, limit: 100, filter: Some("\"n\":3".into()) },
        )
        .await
        .expect("consume filtered");
    assert_eq!(filtered.len(), 1, "filter matched exactly 1, got {}", filtered.len());
    eprintln!("[kafka_it] consume_page(filter) matched {}", filtered.len());

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

    // 消費者群組：reset 建立一個 Empty 群組的 committed offset（加逾時保險）
    let rr = tokio::time::timeout(
        Duration::from_secs(20),
        d.reset_offsets(&KafkaOffsetReset {
            group: group.clone(),
            topic: topic.clone(),
            target: KafkaStart::Beginning,
            partitions: None,
        }),
    )
    .await;
    match rr {
        Ok(Ok(())) => eprintln!("[kafka_it] reset_offsets OK"),
        Ok(Err(e)) => panic!("reset_offsets error: {e:?}"),
        Err(_) => panic!("reset_offsets timed out (30s)"),
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let groups = d.list_groups().await.expect("list_groups");
    assert!(groups.iter().any(|g| g.group_id == group), "list_groups contains {group}");
    // describe 不應報錯（Empty 群組無 active member → offsets 可能為空，屬預期）
    let detail = d.describe_group(&group).await.expect("describe_group");
    assert_eq!(detail.group_id, group);
    eprintln!("[kafka_it] reset_offsets + list_groups + describe_group OK (state={})", detail.state);

    // 清理
    d.delete_topic(&topic).await.expect("delete_topic");
    d.close().await;
    eprintln!("[kafka_it] delete_topic + close OK — ALL PASSED");
}
