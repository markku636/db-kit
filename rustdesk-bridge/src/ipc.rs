// 跟 db-kit 之間的訊息：`[u32 長度（LE，不含這 4 bytes）][u8 型別][內容]`（見 README.md 的表格）。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::session::Frame;

pub const IN_JSON: u8 = 1;
pub const OUT_JSON: u8 = 1;
pub const OUT_VIDEO: u8 = 2;
/// 單則上限（db-kit 送來的都是小指令；防呆）。
const MAX_IN: usize = 1024 * 1024;

#[derive(Debug)]
pub enum HostMsg {
    Json(serde_json::Value),
    /// 看不懂的型別（新版 db-kit 送了舊版 bridge 不認得的東西）：略過。
    Other,
}

pub async fn read_raw<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n == 0 || n > 256 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad message length"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

pub async fn read_msg<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<HostMsg>> {
    let Some(buf) = read_raw(r).await? else { return Ok(None) };
    if buf.len() > MAX_IN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }
    Ok(Some(match buf[0] {
        IN_JSON => serde_json::from_slice(&buf[1..]).map(HostMsg::Json).unwrap_or(HostMsg::Other),
        _ => HostMsg::Other,
    }))
}

async fn write_msg<W: AsyncWrite + Unpin>(w: &mut W, ty: u8, parts: &[&[u8]]) -> io::Result<()> {
    let body: usize = 1 + parts.iter().map(|p| p.len()).sum::<usize>();
    let mut buf = Vec::with_capacity(4 + body);
    buf.extend_from_slice(&(body as u32).to_le_bytes());
    buf.push(ty);
    for p in parts {
        buf.extend_from_slice(p);
    }
    w.write_all(&buf).await?;
    w.flush().await
}

pub async fn write_json<W: AsyncWrite + Unpin>(w: &mut W, v: &serde_json::Value) -> io::Result<()> {
    let s = serde_json::to_vec(v).map_err(io::Error::other)?;
    write_msg(w, OUT_JSON, &[&s]).await
}

/// 影像：`[u8 codec][u8 key][u8 display][u8 保留][i64 pts LE]` + 資料。
pub async fn write_video<W: AsyncWrite + Unpin>(w: &mut W, f: &Frame) -> io::Result<()> {
    let head = [f.codec as u8, u8::from(f.key), f.display, 0];
    write_msg(w, OUT_VIDEO, &[&head, &f.pts.to_le_bytes(), &f.data]).await
}

/// 測試用：扮演 db-kit 送 JSON 指令。
#[cfg(test)]
pub async fn write_host_json<W: AsyncWrite + Unpin>(w: &mut W, v: &serde_json::Value) -> io::Result<()> {
    let s = serde_json::to_vec(v).map_err(io::Error::other)?;
    write_msg(w, IN_JSON, &[&s]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn json_roundtrip_and_eof() {
        let mut buf = Vec::new();
        write_host_json(&mut buf, &serde_json::json!({ "t": "refresh" })).await.unwrap();
        let mut r = &buf[..];
        match read_msg(&mut r).await.unwrap() {
            Some(HostMsg::Json(v)) => assert_eq!(v["t"], "refresh"),
            x => panic!("{x:?}"),
        }
        assert!(read_msg(&mut r).await.unwrap().is_none(), "EOF = 結束");
    }

    #[tokio::test]
    async fn unknown_type_is_other_not_error() {
        let mut buf = Vec::new();
        write_msg(&mut buf, 99, &[b"x"]).await.unwrap();
        let mut r = &buf[..];
        assert!(matches!(read_msg(&mut r).await.unwrap(), Some(HostMsg::Other)));
    }
}
