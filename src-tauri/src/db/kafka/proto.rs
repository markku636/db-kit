//! Protobuf 動態解碼（Confluent wire format）。
//!
//! Confluent protobuf 值：magic `0x00` + schema id(i32 BE) + **message-indexes**（zigzag varint
//! 陣列）+ protobuf payload。message-indexes 定位 .proto 檔內第幾個訊息（巢狀時多層）。
//! 用 protox 由 SR 的 .proto 文字（含 references 遞迴取回）編出 DescriptorPool，再以
//! prost-reflect 的 DynamicMessage 動態解出 → serde_json。

use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor};
use protox::file::{ChainFileResolver, File, FileResolver, GoogleFileResolver};

use crate::error::{AppError, AppResult};

/// 以記憶體中的 (name → .proto 文字) 檔案集編出 DescriptorPool（root 為進入點檔名）。
/// 需含所有 import 依賴（呼叫端已遞迴取回 references）。google well-known 由內建 resolver 供應。
pub fn compile_pool(files: &[(String, String)], root: &str) -> AppResult<DescriptorPool> {
    struct MapResolver(Vec<(String, String)>);
    impl FileResolver for MapResolver {
        fn open_file(&self, name: &str) -> Result<File, protox::Error> {
            match self.0.iter().find(|(n, _)| n == name) {
                Some((n, src)) => File::from_source(n, src),
                None => Err(protox::Error::file_not_found(name)),
            }
        }
    }
    let mut chain = ChainFileResolver::new();
    chain.add(MapResolver(files.to_vec()));
    chain.add(GoogleFileResolver::new());

    let mut compiler = protox::Compiler::with_file_resolver(chain);
    compiler
        .open_file(root)
        .map_err(|e| AppError::Query(format!("編譯 .proto 失敗：{e}")))?;
    Ok(compiler.descriptor_pool())
}

/// 讀 Confluent message-indexes（zigzag varint 陣列）。回傳 (indexes, 消耗的位元組數)。
/// 特例：單一 `0x00` byte 代表 `[0]`（最常見的第一個訊息）。
pub fn read_message_indexes(bytes: &[u8]) -> Option<(Vec<i64>, usize)> {
    let mut pos = 0usize;
    let count = read_zigzag(bytes, &mut pos)?;
    if count == 0 {
        // count=0 → 陣列為 [0]（Confluent 慣例：第一個訊息的捷徑）。
        return Some((vec![0], pos));
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(read_zigzag(bytes, &mut pos)?);
    }
    Some((out, pos))
}

/// 讀一個 zigzag-encoded varint（protobuf sint 編碼）。
fn read_zigzag(bytes: &[u8], pos: &mut usize) -> Option<i64> {
    let raw = read_varint(bytes, pos)?;
    // zigzag decode。
    Some(((raw >> 1) as i64) ^ -((raw & 1) as i64))
}

/// 讀一個 base-128 varint（無 zigzag）。
fn read_varint(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *bytes.get(*pos)?;
        *pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    Some(result)
}

/// 依 message-indexes 於 root 檔中定位訊息描述子（indexes[0]=第幾個 top-level，其後為巢狀）。
pub fn resolve_message(
    pool: &DescriptorPool,
    root_file: &str,
    indexes: &[i64],
) -> Option<MessageDescriptor> {
    let file = pool.files().find(|f| f.name() == root_file)?;
    let mut idx_iter = indexes.iter();
    let first = *idx_iter.next()? as usize;
    let mut msg = file.messages().nth(first)?;
    for &i in idx_iter {
        let child = msg.child_messages().nth(i as usize)?;
        msg = child;
    }
    Some(msg)
}

/// 動態解 protobuf payload → pretty JSON。
pub fn decode_dynamic(desc: MessageDescriptor, payload: &[u8]) -> AppResult<String> {
    let dm = DynamicMessage::decode(desc, payload)
        .map_err(|e| AppError::Query(format!("protobuf 解碼失敗：{e}")))?;
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::pretty(&mut buf);
    let opts = prost_reflect::SerializeOptions::new();
    dm.serialize_with_options(&mut ser, &opts)
        .map_err(|e| AppError::Query(format!("protobuf → JSON 失敗：{e}")))?;
    String::from_utf8(buf).map_err(|e| AppError::Query(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_single_zero_shortcut() {
        // 單一 0x00 → [0]。
        let (idx, consumed) = read_message_indexes(&[0x00]).unwrap();
        assert_eq!(idx, vec![0]);
        assert_eq!(consumed, 1);
    }

    #[test]
    fn zigzag_explicit_count() {
        // count=1（zigzag(1)=2 → byte 0x02），index=1（zigzag(1)=2 → 0x02）→ [1]。
        let (idx, consumed) = read_message_indexes(&[0x02, 0x02]).unwrap();
        assert_eq!(idx, vec![1]);
        assert_eq!(consumed, 2);
    }

    #[test]
    fn zigzag_two_indexes() {
        // count=2 (0x04), [1,0] → zigzag: 1→0x02, 0→0x00。
        let (idx, consumed) = read_message_indexes(&[0x04, 0x02, 0x00]).unwrap();
        assert_eq!(idx, vec![1, 0]);
        assert_eq!(consumed, 3);
    }

    #[test]
    fn compile_and_decode_roundtrip() {
        // 內嵌 .proto，編譯 → 取訊息 → 以手工 protobuf bytes 解碼。
        let proto = r#"
            syntax = "proto3";
            message Person { string name = 1; int32 age = 2; }
        "#;
        let pool = compile_pool(&[("schema.proto".into(), proto.into())], "schema.proto").unwrap();
        let desc = resolve_message(&pool, "schema.proto", &[0]).expect("resolve Person");
        assert_eq!(desc.name(), "Person");
        // Person{ name="amy"(field1,len-delim), age=7(field2,varint) }
        // field1: tag=0x0a, len=3, "amy"; field2: tag=0x10, 0x07
        let payload = [0x0a, 0x03, b'a', b'm', b'y', 0x10, 0x07];
        let json = decode_dynamic(desc, &payload).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["name"], "amy");
        assert_eq!(v["age"], 7);
    }
}
