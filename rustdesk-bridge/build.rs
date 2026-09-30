// 從 protos/message.proto 產生 Rust 型別（純 Rust 的 protobuf parser，不需要 protoc）。
// 設定同 RustDesk 的 libs/base/build.rs。
fn main() {
    let out_dir = format!("{}/protos", std::env::var("OUT_DIR").unwrap());
    std::fs::create_dir_all(&out_dir).unwrap();
    protobuf_codegen::Codegen::new()
        .pure()
        .out_dir(out_dir)
        .inputs(["protos/message.proto"])
        .include("protos")
        .customize(protobuf_codegen::Customize::default().tokio_bytes(true))
        .run()
        .expect("Codegen failed.");
    println!("cargo:rerun-if-changed=protos/message.proto");
}
