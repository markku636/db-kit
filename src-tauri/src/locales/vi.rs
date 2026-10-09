//! Tiếng Trung phồn thể (nguyên bản) → bảng đối chiếu tiếng Việt.
//!
//! - Key là **câu tiếng Trung phồn thể gốc** truyền cho `t!` / `tf!` (kèm cả placeholder `{name}`).
//! - Key chưa thu thập sẽ được `i18n::lookup` chuyển về **tiếng Anh** (ngôn ngữ dự phòng), không lòi
//!   tiếng Trung ra, nên bảng dịch một phần vẫn dùng được.
//! - Ưu tiên thu thập những câu người dùng thật sự nhìn thấy (lỗi, kết xuất CLI). Thêm câu mới chỉ cần
//!   thêm một dòng, không phải duy trì thứ tự sắp xếp.
#![allow(clippy::match_same_arms)]

/// Tra bảng: có thì trả về tiếng Việt, không thì `None` (`i18n::lookup` sẽ lần lượt thử tiếng Anh rồi nguyên bản).
pub fn lookup(zh: &str) -> Option<&'static str> {
    Some(match zh {
        // ---- error.rs: lớp bọc ngoài của AppError ----
        "找不到連線：{detail}" => "Không tìm thấy kết nối: {detail}",
        "連線失敗：{detail}" => "Kết nối thất bại: {detail}",
        "查詢失敗：{detail}" => "Truy vấn thất bại: {detail}",
        "不支援的資料庫種類：{detail}" => "Loại cơ sở dữ liệu không được hỗ trợ: {detail}",
        "連線池已耗盡或關閉" => "Connection pool đã cạn hoặc đã đóng",
        "儲存錯誤：{detail}" => "Lỗi lưu trữ: {detail}",
        "SSH 通道錯誤：{detail}" => "Lỗi đường hầm SSH: {detail}",
        "查詢逾時（{ms} ms）；伺服器端查詢可能仍在執行，可從行程清單手動終止" => {
            "Truy vấn quá hạn sau {ms} ms; truy vấn phía máy chủ có thể vẫn đang chạy, có thể kết thúc thủ công từ danh sách tiến trình"
        }

        // ---- store.rs: cấu hình / keychain ----
        "無法取得使用者設定目錄" => "Không xác định được thư mục cấu hình của người dùng",
        "無法取得設定目錄：{e}" => "Không xác định được thư mục cấu hình: {e}",
        "建立設定目錄失敗：{e}" => "Tạo thư mục cấu hình thất bại: {e}",
        "讀取連線設定失敗：{e}" => "Đọc cấu hình kết nối thất bại: {e}",
        "序列化連線設定失敗：{e}" => "Tuần tự hóa cấu hình kết nối thất bại: {e}",
        "寫入連線設定失敗：{e}" => "Ghi cấu hình kết nối thất bại: {e}",
        "更新連線設定失敗：{e}" => "Cập nhật cấu hình kết nối thất bại: {e}",
        "解析 {file} 失敗：{e}" => "Phân tích {file} thất bại: {e}",
        "讀取 {file} 失敗：{e}" => "Đọc {file} thất bại: {e}",
        "序列化 {file} 失敗：{e}" => "Tuần tự hóa {file} thất bại: {e}",
        "寫入 {file} 失敗：{e}" => "Ghi {file} thất bại: {e}",
        "更新 {file} 失敗：{e}" => "Cập nhật {file} thất bại: {e}",
        "keychain 開啟失敗：{e}" => "Mở keychain thất bại: {e}",
        "keychain 寫入失敗：{e}" => "Ghi vào keychain thất bại: {e}",

        // ---- commands/mod.rs ----
        "salt 產生失敗：{e}" => "Tạo salt thất bại: {e}",
        "密碼雜湊失敗：{e}" => "Băm mật khẩu thất bại: {e}",
        "密碼不可為空" => "Mật khẩu không được để trống",
        "目前密碼不正確" => "Mật khẩu hiện tại không đúng",

        // Khóa khởi động: sinh trắc học. Dòng đầu tiên hiện trên hộp thoại xác thực của hệ điều hành.
        "驗證以解鎖 DB Kit" => "Xác thực để mở khóa DB Kit",
        "此裝置無法使用生物辨識" => "Thiết bị này không dùng được sinh trắc học",
        "驗證未通過，尚未啟用生物辨識解鎖" => "Xác thực không thành công, chưa bật mở khóa sinh trắc học",
        "驗證未通過；若已設定啟動密碼，可改以密碼關閉" => {
            "Xác thực không thành công; nếu đã đặt mật khẩu khởi động, có thể dùng mật khẩu để tắt tính năng này"
        }
        "請提供 passphrase" => "Cần cung cấp passphrase",
        "序列化失敗：{e}" => "Tuần tự hóa thất bại: {e}",
        "寫入失敗：{e}" => "Ghi thất bại: {e}",
        "讀取失敗：{e}" => "Đọc thất bại: {e}",
        "解密成功但內容格式不符（檔案可能來自不同版本）" => {
            "Giải mã thành công nhưng nội dung sai định dạng (tệp có thể thuộc phiên bản khác)"
        }
        "檔案過大（上限 8 MiB）" => "Tệp quá lớn (giới hạn 8 MiB)",
        "檔案過大（約 {mb} MB），CSV 匯入上限 100 MB；請先分割檔案" => {
            "Tệp quá lớn (khoảng {mb} MB), giới hạn nhập CSV là 100 MB; hãy chia nhỏ tệp trước"
        }
        "檔案非 UTF-8 編碼；請在試算表以「另存新檔 → CSV UTF-8」重新匯出後再試" => {
            "Tệp không dùng mã hóa UTF-8; hãy xuất lại từ bảng tính bằng \"Lưu thành → CSV UTF-8\" rồi thử lại"
        }
        "讀取檔案失敗：{e}" => "Đọc tệp thất bại: {e}",
        "檔案過大（約 {mb} MB），Excel 匯入上限 100 MB" => {
            "Tệp quá lớn (khoảng {mb} MB), giới hạn nhập Excel là 100 MB"
        }
        "此筆為失敗紀錄，無法還原" => "Mục này là bản sao lưu thất bại, không thể khôi phục",

        // ---- db/conn_url/: phân tích chuỗi kết nối ----
        "無法解析連線字串" => "Không phân tích được chuỗi kết nối",
        "不支援的連線字串格式：{scheme}" => "Định dạng chuỗi kết nối không được hỗ trợ: {scheme}",

        // ---- Kết xuất khi chạy CLI ----
        "連線成功" => "Kết nối thành công",
        "(鍵不存在)" => "(khóa không tồn tại)",
        "(空結果)" => "(kết quả rỗng)",
        "({n} 列)" => "({n} dòng)",
        "(無欄位；{n} 列受影響)" => "(không có cột; {n} dòng bị ảnh hưởng)",
        "已匯出 {rows} 列到 {path}（{bytes} bytes，{format} 格式）" => {
            "Đã xuất {rows} dòng ra {path} ({bytes} bytes, định dạng {format})"
        }
        "已備份：{path}（{bytes} bytes，方式 {method}）" => {
            "Đã sao lưu: {path} ({bytes} bytes, phương thức {method})"
        }
        "請提供 --passphrase" => "Cần cung cấp --passphrase",
        "json 序列化失敗：{e}" => "Tuần tự hóa JSON thất bại: {e}",
        "CLI 為唯讀模式，僅允許查詢語句（偵測到 `{kw}`）" => {
            "CLI đang ở chế độ chỉ đọc, chỉ cho phép câu lệnh truy vấn (phát hiện `{kw}`)"
        }

        // ---- cli/args.rs: phần help của clap (đổi theo --lang) ----
        "介面語言（zh-TW | zh-CN | en | ja | ko | vi；亦可用環境變數 DBKIT_LANG）" => {
            "Ngôn ngữ giao diện (zh-TW | zh-CN | en | ja | ko | vi; cũng có thể dùng biến môi trường DBKIT_LANG)"
        }

        // ---- compare/ + cli/compare.rs + cli/args.rs (so sánh cấu trúc / dữ liệu) ----
        "此資料庫種類不支援結構比對" => "Loại cơ sở dữ liệu này không hỗ trợ so sánh cấu trúc",
        "無法取得 {name} 的定義：{err}" => "Không lấy được định nghĩa của {name}: {err}",
        "無法列出程序 / 函式：{err}" => "Không liệt kê được thủ tục / hàm: {err}",
        "欄位：{err}" => "cột: {err}",
        "索引：{err}" => "chỉ mục: {err}",
        "外鍵：{err}" => "khóa ngoại: {err}",
        "DDL：{err}" => "DDL: {err}",
        "找不到視圖定義" => "Không tìm thấy định nghĩa khung nhìn",
        "來源與目標資料庫種類不同，無法產生同步 DDL" => {
            "Nguồn và đích thuộc hai loại cơ sở dữ liệu khác nhau, không thể sinh DDL đồng bộ"
        }
        "資料表 {name}：來源無 DDL，無法產生 CREATE TABLE" => {
            "Bảng {name}: nguồn không có DDL nên không thể sinh CREATE TABLE"
        }
        "Oracle DDL 含儲存子句（TABLESPACE 等），目標環境可能需調整" => {
            "DDL của Oracle chứa mệnh đề lưu trữ (TABLESPACE, v.v.), có thể phải chỉnh cho môi trường đích"
        }
        "資料表 {name}：{err}" => "Bảng {name}: {err}",
        "資料表 {name}：目標多出（未含 DROP）" => "Bảng {name}: chỉ có ở đích (không kèm DROP)",
        "{table}：主鍵變更請手動處理" => "{table}: thay đổi khóa chính phải xử lý thủ công",
        "SQLite 無 DEFAULT 的 NOT NULL 欄無法新增，已改為允許 NULL" => {
            "SQLite không thêm được cột NOT NULL mà thiếu DEFAULT, đã đổi thành cho phép NULL"
        }
        "{obj}：identity / generated 屬性變更（{src} → {dst}）請手動處理" => {
            "{obj}: thay đổi thuộc tính identity / generated ({src} → {dst}) phải xử lý thủ công"
        }
        "{obj}：SQLite 無法修改欄位型別 / NULL / 預設值（需重建資料表）" => {
            "{obj}: SQLite không sửa được kiểu / NULL / giá trị mặc định của cột (phải dựng lại bảng)"
        }
        "{obj}：SQL Server 預設值為具名約束，請手動處理" => {
            "{obj}: giá trị mặc định trong SQL Server là ràng buộc có tên, hãy xử lý thủ công"
        }
        "{obj}：identity 屬性變更請手動處理" => "{obj}: thay đổi thuộc tính identity phải xử lý thủ công",
        "{obj}：此引擎不支援欄位變更" => "{obj}: engine này không hỗ trợ thay đổi cột",
        "{obj}：目標多出的欄位（未含 DROP）" => "{obj}: cột chỉ có ở đích (không kèm DROP)",
        "需 SQLite 3.35+" => "Cần SQLite 3.35+",
        "若此唯一索引由 UNIQUE 約束建立，請改用 DROP CONSTRAINT" => {
            "Nếu chỉ mục duy nhất này đến từ ràng buộc UNIQUE, hãy dùng DROP CONSTRAINT"
        }
        "{table}.{fk}：SQLite 無法新增外鍵（需重建資料表）" => {
            "{table}.{fk}: SQLite không thêm được khóa ngoại (phải dựng lại bảng)"
        }
        "{table}.{fk}：SQLite 無法刪除外鍵（需重建資料表）" => {
            "{table}.{fk}: SQLite không xóa được khóa ngoại (phải dựng lại bảng)"
        }
        "視圖 {name}：目標多出（未含 DROP）" => "Khung nhìn {name}: chỉ có ở đích (không kèm DROP)",
        "視圖 {name}：來源無定義" => "Khung nhìn {name}: nguồn không có định nghĩa",
        "視圖本體引用的表未限定資料庫，請在目標資料庫的連線環境下執行" => {
            "Các bảng được tham chiếu trong thân khung nhìn không kèm tên cơ sở dữ liệu, hãy chạy khi đang kết nối tới CSDL đích"
        }
        "{rtype} {name}：目標多出（未含 DROP）" => "{rtype} {name}: chỉ có ở đích (không kèm DROP)",
        "{name}：來源無定義" => "{name}: nguồn không có định nghĩa",
        "定義沿用來源（{src}），若內含 schema 限定名請改為 {dst}" => {
            "Định nghĩa lấy từ nguồn ({src}); nếu bên trong có tên kèm schema hãy đổi thành {dst}"
        }
        "請在目標資料庫的連線環境下執行" => "Hãy chạy khi đang kết nối tới cơ sở dữ liệu đích",
        "快照路徑無效" => "Đường dẫn ảnh chụp không hợp lệ",
        "目錄不存在：{dir}" => "Thư mục không tồn tại: {dir}",
        "讀取快照失敗：{err}" => "Đọc ảnh chụp thất bại: {err}",
        "快照格式錯誤：{err}" => "Định dạng ảnh chụp không hợp lệ: {err}",
        "快照版本 {v} 高於本程式支援的 {max}，請更新 db-kit" => {
            "Ảnh chụp phiên bản {v} mới hơn mức {max} mà chương trình hỗ trợ, hãy cập nhật db-kit"
        }
        "請以 -d 指定要擷取的資料庫 / schema" => "Hãy dùng -d để chỉ định cơ sở dữ liệu / schema cần lấy",
        "擷取結構中… {done}/{total}" => "Đang lấy cấu trúc… {done}/{total}",
        "已存快照：{path}（{tables} 表 / {views} 視圖 / {routines} 程序，{bytes} bytes）" => {
            "Đã lưu ảnh chụp: {path} ({tables} bảng / {views} khung nhìn / {routines} thủ tục, {bytes} bytes)"
        }
        "種類" => "loại",
        "標籤" => "nhãn",
        "擷取時間" => "thời điểm chụp",
        "資料表數" => "số bảng",
        "視圖數" => "số khung nhìn",
        "程序 / 函式 / 觸發器數" => "số thủ tục / hàm / trigger",
        "快照版本" => "phiên bản ảnh chụp",
        "產生程式版本" => "phiên bản ứng dụng",
        "{role}未指定資料庫 / schema" => "Chưa chỉ định cơ sở dữ liệu / schema cho {role}",
        "擷取{role}結構中… {done}/{total}" => "Đang lấy cấu trúc {role}… {done}/{total}",
        "來源" => "nguồn",
        "目標" => "đích",
        "目標為快照檔，無法套用同步 SQL" => "Đích là tệp ảnh chụp, không thể áp dụng SQL đồng bộ",
        "結構一致，無需同步。" => "Cấu trúc giống nhau, không cần đồng bộ.",
        "在目標「{db}」執行 {n} 句同步 DDL（{d} 句為高破壞）" => {
            "Chạy {n} câu lệnh DDL đồng bộ trên đích \"{db}\" ({d} câu mang tính phá hủy cao)"
        }
        "套用中… {i}/{n}" => "Đang áp dụng… {i}/{n}",
        "第 {i} 句失敗（{obj}）：{err}\n{sql}" => "Câu lệnh thứ {i} thất bại ({obj}): {err}",
        "已套用 {n} 句同步 DDL" => "Đã áp dụng {n} câu lệnh DDL đồng bộ",
        "{n} 句（{d} 句高破壞，{s} 項未能自動產生）" => {
            "{n} câu lệnh ({d} câu phá hủy cao, {s} mục không thể tạo tự động)"
        }
        "結構一致，無差異。" => "Cấu trúc giống nhau, không có khác biệt.",
        "發現 {n} 項結構差異" => "Tìm thấy {n} khác biệt về cấu trúc",
        "結構快照（擷取整庫結構為 JSON 檔，供日後比對）" => {
            "Ảnh chụp cấu trúc (lưu cấu trúc cả cơ sở dữ liệu ra tệp JSON để so sánh về sau)"
        }
        "比對來源與目標（結構 / 資料列），可輸出或套用同步 SQL" => {
            "So sánh nguồn và đích (cấu trúc / dòng dữ liệu), có thể in ra hoặc áp dụng SQL đồng bộ"
        }
        "擷取目前連線 / 資料庫的結構為 JSON 快照檔" => {
            "Lưu cấu trúc của kết nối / cơ sở dữ liệu hiện tại thành tệp ảnh chụp JSON"
        }
        "輸出檔路徑（.json）" => "Đường dẫn tệp đầu ra (.json)",
        "不含建表 DDL（檔案較小；無法比對 charset / engine 等 DDL 層差異）" => {
            "Không kèm DDL tạo bảng (tệp nhỏ hơn; không so sánh được khác biệt mức DDL như charset / engine)"
        }
        "不含預存程序 / 函式 / 觸發器" => "Không kèm thủ tục lưu trữ / hàm / trigger",
        "顯示快照檔摘要（種類 / 資料庫 / 表數 / 擷取時間）" => {
            "Hiện tóm tắt tệp ảnh chụp (loại / cơ sở dữ liệu / số bảng / thời điểm chụp)"
        }
        "結構比對：表 / 欄位 / 索引 / 外鍵 / 視圖 / 程序；可輸出同步 DDL" => {
            "So sánh cấu trúc: bảng / cột / chỉ mục / khóa ngoại / khung nhìn / thủ tục; có thể in DDL đồng bộ"
        }
        "目標：已存連線名稱 / id、連線字串，或 .json 快照檔路徑" => {
            "Đích: tên / id kết nối đã lưu, chuỗi kết nối, hoặc đường dẫn tệp ảnh chụp .json"
        }
        "來源（省略 = 全域連線旗標 --conn / --url）；同樣接受連線或快照檔" => {
            "Nguồn (bỏ qua = cờ kết nối toàn cục --conn / --url); cũng nhận kết nối hoặc tệp ảnh chụp"
        }
        "來源資料庫 / schema（預設沿用 -d）" => "Cơ sở dữ liệu / schema nguồn (mặc định dùng -d)",
        "目標資料庫 / schema（預設同來源）" => "Cơ sở dữ liệu / schema đích (mặc định giống nguồn)",
        "名稱比對忽略大小寫" => "So khớp tên không phân biệt hoa thường",
        "忽略欄位註解差異" => "Bỏ qua khác biệt về chú thích cột",
        "忽略欄位預設值差異" => "Bỏ qua khác biệt về giá trị mặc định của cột",
        "不比對預存程序 / 函式 / 觸發器" => "Bỏ qua thủ tục lưu trữ / hàm / trigger",
        "輸出同步 SQL（使目標與來源一致）而非差異表" => {
            "In SQL đồng bộ (làm cho đích giống nguồn) thay vì bảng khác biệt"
        }
        "同步 SQL 含 DROP 語句（刪除目標多出的表 / 欄 / 視圖）" => {
            "SQL đồng bộ kèm câu lệnh DROP (xóa bảng / cột / khung nhìn chỉ có ở đích)"
        }
        "同步 SQL 含程序 / 函式 / 觸發器" => "SQL đồng bộ kèm thủ tục / hàm / trigger",
        "直接在目標執行同步 SQL。需 --yes；含高破壞語句時另需 --force" => {
            "Chạy thẳng SQL đồng bộ trên đích. Cần --yes; nếu có câu lệnh phá hủy cao thì cần thêm --force"
        }
        "有差異時以非零結束碼結束（腳本 / CI 用）" => "Thoát với mã khác 0 khi có khác biệt (dùng cho script / CI)",
        "目標缺少對應主鍵欄位 {col}" => "Đích thiếu cột khóa chính tương ứng {col}",
        "來源與目標沒有同名欄位可比對" => "Nguồn và đích không có cột trùng tên để so sánh",
        "寫入暫存檔失敗：{err}" => "Ghi tệp tạm thất bại: {err}",
        "建立暫存檔失敗：{err}" => "Tạo tệp tạm thất bại: {err}",
        "讀取暫存檔失敗：{err}" => "Đọc tệp tạm thất bại: {err}",
        "此資料庫種類不支援資料比對" => "Loại cơ sở dữ liệu này không hỗ trợ so sánh dữ liệu",
        "來源資料表沒有主鍵，無法以主鍵比對" => "Bảng nguồn không có khóa chính nên không so sánh theo khóa được",
        "來源與目標是同一張表" => "Nguồn và đích là cùng một bảng",
        "目標連線標記為正式環境，未允許套用同步" => {
            "Kết nối đích được đánh dấu là môi trường production, không cho phép áp dụng đồng bộ"
        }
        "含二進位欄位，以原字串比對（跨引擎可能不可比）" => {
            "Cột nhị phân được so sánh dưới dạng chuỗi thô (có thể không so được giữa các engine)"
        }
        "兩側主鍵排序與比較器不一致，已改用雜湊比對" => {
            "Thứ tự khóa chính hai bên không khớp với bộ so sánh, đã chuyển sang so sánh bằng băm"
        }
        "無主鍵" => "không có khóa chính",
        "預檢相同（筆數 / 主鍵範圍一致）" => "tiền kiểm giống nhau (số dòng / phạm vi khóa trùng)",
        "預檢有差異（僅預檢）" => "tiền kiểm có khác biệt (chỉ tiền kiểm)",
        "預檢失敗：{err}" => "tiền kiểm thất bại: {err}",
        "請以 -d 指定來源資料庫 / schema" => "Hãy dùng -d để chỉ định cơ sở dữ liệu / schema nguồn",
        "資料比對的目標必須是連線，不能是快照檔" => {
            "Đích của phép so sánh dữ liệu phải là một kết nối, không thể là tệp ảnh chụp"
        }
        "比對中… {table} {i}/{n} · 來源 {s} 列 / 目標 {d} 列 · +{ins} ~{upd} -{del}" => {
            "Đang so sánh… {table} {i}/{n} · nguồn {s} dòng / đích {d} dòng · +{ins} ~{upd} -{del}"
        }
        "資料一致，無需同步。" => "Dữ liệu giống nhau, không cần đồng bộ.",
        "套用同步到目標「{db}」：{i} INSERT / {u} UPDATE / {d} DELETE（{t} 表）" => {
            "Áp dụng đồng bộ lên đích \"{db}\": {i} INSERT / {u} UPDATE / {d} DELETE ({t} bảng)"
        }
        "{n} 句同步 SQL 失敗" => "{n} câu lệnh SQL đồng bộ thất bại",
        "+{ins} ~{upd} -{del}" => "+{ins} ~{upd} -{del}",
        "套用同步到目標「{dst}」：{i} INSERT / {u} UPDATE / {d} DELETE" => {
            "Áp dụng đồng bộ lên đích \"{dst}\": {i} INSERT / {u} UPDATE / {d} DELETE"
        }
        "同步 SQL 超過文字上限，請改用 --apply 或縮小範圍" => {
            "SQL đồng bộ vượt quá giới hạn văn bản, hãy dùng --apply hoặc thu hẹp phạm vi"
        }
        "新增（目標缺）" => "thêm (đích thiếu)",
        "更新（值不同）" => "cập nhật (giá trị khác)",
        "刪除（目標多出）" => "xóa (chỉ có ở đích)",
        "相同" => "giống nhau",
        "來源列數" => "số dòng nguồn",
        "目標列數" => "số dòng đích",
        "策略" => "chiến lược",
        "耗時（ms）" => "thời gian (ms)",
        "截斷原因" => "lý do cắt ngắn",
        "DELETE 已停用" => "DELETE đã bị tắt",
        "比對被截斷，為安全不輸出 DELETE" => "So sánh bị cắt ngắn, DELETE không được xuất ra cho an toàn",
        "主鍵" => "khóa chính",
        "來源獨有欄位（忽略）" => "cột chỉ có ở nguồn (bỏ qua)",
        "目標獨有欄位（不受影響）" => "cột chỉ có ở đích (không bị ảnh hưởng)",
        "已套用" => "đã áp dụng",
        "失敗" => "thất bại",
        "已套用 {a}，失敗 {f}" => "đã áp dụng {a}, thất bại {f}",
        "僅來源有：{list}" => "Chỉ có ở nguồn: {list}",
        "僅目標有：{list}" => "Chỉ có ở đích: {list}",
        "合計 +{ins} ~{upd} -{del}" => "Tổng +{ins} ~{upd} -{del}",
        "已取消" => "Đã hủy",
        "資料列比對：以主鍵逐列比對兩表（或整庫），可輸出 / 套用同步 SQL" => {
            "So sánh dòng dữ liệu: so từng dòng hai bảng (hoặc cả cơ sở dữ liệu) theo khóa chính, có thể in / áp dụng SQL đồng bộ"
        }
        "來源表名（與 --all 互斥）" => "Tên bảng nguồn (không dùng chung với --all)",
        "目標：已存連線名稱 / id 或連線字串（省略 = 與來源同一連線）" => {
            "Đích: tên / id kết nối đã lưu hoặc chuỗi kết nối (bỏ qua = cùng kết nối với nguồn)"
        }
        "目標表名（預設同來源）" => "Tên bảng đích (mặc định giống nguồn)",
        "比對整庫（來源 ∩ 目標的資料表；略過視圖與無主鍵表）" => {
            "So sánh cả cơ sở dữ liệu (các bảng có ở cả nguồn và đích; bỏ qua khung nhìn và bảng không có khóa chính)"
        }
        "先以 COUNT / MIN / MAX 預檢，看起來相同的表直接略過（僅 --all）" => {
            "Tiền kiểm bằng COUNT / MIN / MAX trước rồi bỏ qua các bảng trông giống nhau (chỉ với --all)"
        }
        "只做預檢，不逐列比對（僅 --all）" => "Chỉ tiền kiểm, không so từng dòng (chỉ với --all)",
        "將同步 SQL 輸出到 stdout（不執行）" => "In SQL đồng bộ ra stdout (không chạy)",
        "在目標直接執行同步 SQL。需 --yes；含 --include-deletes 時另需 --force" => {
            "Chạy thẳng SQL đồng bộ trên đích. Cần --yes; khi có --include-deletes thì cần thêm --force"
        }
        "同步 SQL 含 DELETE（刪除目標多出的列）" => "SQL đồng bộ kèm DELETE (xóa các dòng chỉ có ở đích)",
        "每側最多掃描列數（0 = 不限）" => "Số dòng quét tối đa mỗi bên (0 = không giới hạn)",
        "每類差異保留的樣本列數" => "Số dòng mẫu giữ lại cho mỗi loại khác biệt",
        "忽略的欄位（可重複）" => "Cột cần bỏ qua (có thể lặp lại)",
        "忽略字串尾端空白" => "Bỏ qua khoảng trắng ở cuối chuỗi",
        "比對策略：auto（排序合併，失敗自動退雜湊）| merge | hash" => {
            "Chiến lược so sánh: auto (sort-merge, thất bại thì tự chuyển sang băm) | merge | hash"
        }
        "套用時任一批失敗即中止（預設：該批改逐句重放，隔離壞列後繼續）" => {
            "Dừng khi có lô nào thất bại lúc áp dụng (mặc định: chạy lại lô đó từng câu một, cô lập dòng lỗi rồi tiếp tục)"
        }
        "允許對標記為正式環境（prod）的目標連線套用" => {
            "Cho phép áp dụng lên kết nối đích được đánh dấu là môi trường production (prod)"
        }

        // ---- ssh/（tunnel / 終端機 / SFTP / 認證）+ commands/ssh.rs ----
        "找不到設定目錄" => "Không tìm thấy thư mục cấu hình",
        "SQLite 不支援 SSH Tunnel" => "SQLite không hỗ trợ đường hầm SSH",
        "未填寫 SSH 主機" => "Chưa nhập máy chủ SSH",
        "SSH 連線逾時" => "Kết nối SSH đã hết thời gian chờ",
        "SSH 連線失敗：{e}" => "Kết nối SSH thất bại: {e}",
        "SSH 認證逾時" => "Xác thực SSH đã hết thời gian chờ",
        "SSH 認證失敗：{e}" => "Xác thực SSH thất bại: {e}",
        "讀取 SSH 私鑰失敗：{e}" => "Không đọc được khóa riêng SSH: {e}",
        "本地監聽失敗：{e}" => "Lắng nghe cục bộ thất bại: {e}",
        "取得本地埠失敗：{e}" => "Không lấy được cổng cục bộ: {e}",
        "SSH 認證失敗：{detail}" => "Xác thực SSH thất bại: {detail}",
        "SSH 主機金鑰驗證失敗：{detail}" => "Xác minh khóa máy chủ SSH thất bại: {detail}",
        "使用者已取消 SSH 連線" => "Người dùng đã hủy kết nối SSH",
        "SFTP 錯誤：{detail}" => "Lỗi SFTP: {detail}",
        "此連線未啟用 SSH" => "Kết nối này chưa bật SSH",
        "未填寫 SSH 使用者名稱" => "Chưa nhập tên người dùng SSH",
        "找不到 SSH 主機：{id}" => "Không tìm thấy máy chủ SSH: {id}",
        "SSH 連線不存在或已關閉" => "Kết nối SSH không tồn tại hoặc đã đóng",
        "終端機不存在或已關閉" => "Terminal không tồn tại hoặc đã đóng",
        "SFTP 工作階段不存在或已關閉" => "Phiên SFTP không tồn tại hoặc đã đóng",
        "同時開啟的 SSH 連線已達上限（{n}）" => "Đã đạt giới hạn số kết nối SSH đồng thời ({n})",
        "同時開啟的終端機已達上限（{n}）" => "Đã đạt giới hạn số terminal đồng thời ({n})",
        "找不到待回答的 SSH 提示（可能已逾時）" => "Không tìm thấy lời nhắc SSH đang chờ trả lời (có thể đã hết thời gian chờ)",
        "無法讀取 known_hosts，為防中間人而拒絕連線：{e}" => "Không đọc được known_hosts, đã từ chối kết nối để phòng tấn công xen giữa: {e}",
        "無法保存 host key 指紋：{e}" => "Không lưu được dấu vân tay khóa máy chủ: {e}",
        "{host} 的主機金鑰與已記錄的指紋不符，已拒絕連線（可能遭中間人攻擊）" => "Khóa máy chủ của {host} không khớp với dấu vân tay đã lưu, đã từ chối kết nối (có thể bị tấn công xen giữa)",
        "未信任 {host} 的主機金鑰" => "Khóa máy chủ của {host} chưa được tin cậy",
        "ssh-agent" => "ssh-agent",
        "公鑰" => "khóa công khai",
        "密碼" => "Mật khẩu",
        "鍵盤互動" => "tương tác bàn phím",
        "沒有可用的認證方式" => "Không có phương thức xác thực nào khả dụng",
        "沒有可用的認證方式（{detail}）" => "Không có phương thức xác thực nào khả dụng ({detail})",
        "伺服器接受了 {methods} 但要求進一步認證" => "Máy chủ đã chấp nhận {methods} nhưng yêu cầu xác thực thêm",
        "伺服器拒絕了 {methods} 認證（帳號 / 密碼 / 金鑰不正確）" => "Máy chủ đã từ chối xác thực {methods} (tên người dùng / mật khẩu / khóa không đúng)",
        "找不到 ssh-agent" => "Không tìm thấy ssh-agent",
        "ssh-agent 讀取金鑰清單失敗：{e}" => "Không lấy được danh sách khóa từ ssh-agent: {e}",
        "ssh-agent 沒有任何金鑰" => "ssh-agent không có khóa nào",
        "私鑰 {path} 受密語保護" => "Khóa riêng {path} được bảo vệ bằng cụm mật khẩu",
        "私鑰密語" => "Cụm mật khẩu khóa riêng",
        "請輸入 {label} 的密碼" => "Nhập mật khẩu cho {label}",
        "伺服器要求互動輸入，但目前模式無法詢問使用者" => "Máy chủ yêu cầu nhập tương tác nhưng chế độ hiện tại không thể hỏi người dùng",
        "等待 OpenSSH agent named pipe 逾時" => "Hết thời gian chờ named pipe của OpenSSH agent",
        "OpenSSH agent：{a}；Pageant：{b}" => "OpenSSH agent: {a}; Pageant: {b}",
        "開啟 SSH 通道失敗：{e}" => "Mở kênh SSH thất bại: {e}",
        "要求 PTY 失敗：{e}" => "Yêu cầu PTY thất bại: {e}",
        "伺服器拒絕配置 PTY" => "Máy chủ từ chối cấp PTY",
        "要求 shell 失敗：{e}" => "Yêu cầu shell thất bại: {e}",
        "伺服器拒絕開啟 shell" => "Máy chủ từ chối mở shell",
        "送出啟動指令失敗：{e}" => "Gửi lệnh khởi động thất bại: {e}",
        "寫入終端機失敗：{e}" => "Ghi vào terminal thất bại: {e}",
        "調整終端機大小失敗：{e}" => "Thay đổi kích thước terminal thất bại: {e}",
        "SSH 通道已被伺服器關閉" => "Kênh SSH đã bị máy chủ đóng",
        "等待伺服器回覆逾時" => "Hết thời gian chờ máy chủ phản hồi",
        "無效的 base64 輸入" => "Dữ liệu base64 không hợp lệ",
        "要求 sftp 子系統失敗：{e}" => "Yêu cầu hệ thống con sftp thất bại: {e}",
        "拒絕刪除根目錄或目前目錄" => "Từ chối xóa thư mục gốc hoặc thư mục hiện tại",
        "資料夾內的項目超過 {max} 個，請改用終端機（例如 tar）處理" => "Thư mục có hơn {max} mục; hãy dùng terminal (ví dụ tar)",
        "遠端已有同名檔案，無法建立資料夾：{path}" => "Máy từ xa có tệp cùng tên nên không thể tạo thư mục: {path}",
        "遠端已有同名項目：{path}" => "Máy từ xa đã có mục cùng tên: {path}",
        "本機已有同名資料夾：{path}" => "Đã có thư mục cục bộ cùng tên: {path}",
        "寫入記錄檔 {path} 失敗：{e}" => "Ghi tệp nhật ký {path} thất bại: {e}",
        "跳板機設定形成迴圈（A 經 B、B 又經 A），請檢查主機設定" => "Cấu hình máy trung gian tạo thành vòng lặp (A qua B, B lại qua A); hãy kiểm tra cấu hình máy chủ",
        "跳板機超過 {n} 層（可能設定成互相跳轉）" => "Vượt quá {n} tầng máy trung gian (có thể chúng trỏ lẫn nhau)",
        "找不到設定的跳板機（可能已刪除），請到主機設定重新選擇" => "Không tìm thấy máy trung gian đã cấu hình (có thể đã bị xóa); hãy chọn lại trong cấu hình máy chủ",
        "跳板機無法轉送到 {host}:{port}（跳板機可能不允許 TCP 轉送，或連不到目標）：{e}" => "Máy trung gian không chuyển tiếp được tới {host}:{port} (có thể không cho phép chuyển tiếp TCP hoặc không tới được đích): {e}",
        "經跳板機連線逾時" => "Kết nối qua máy trung gian bị quá thời gian",
        "多層跳板機（{via}）：只接最後一台，前面幾層請到那台主機的設定裡設跳板機" => "Máy trung gian nhiều tầng ({via}): chỉ liên kết máy cuối cùng; các tầng trước hãy đặt trong cấu hình của máy đó",
        "有 ProxyJump（{via}）：跳板機目前還不支援，匯入後直連可能連不上" => "Có ProxyJump ({via}): chưa hỗ trợ máy trung gian, kết nối trực tiếp có thể thất bại",
        "有 ProxyCommand：目前還不支援，匯入後直連可能連不上" => "Có ProxyCommand: chưa hỗ trợ, kết nối trực tiếp có thể thất bại",
        "有連接埠轉送設定：目前還不支援，不會一起匯入" => "Có cấu hình chuyển tiếp cổng: chưa hỗ trợ, sẽ không được nhập",
        "沒有設定 User，先用本機帳號 {user}" => "Chưa đặt User, tạm dùng tài khoản máy {user}",
        "Port 設定看不懂，先用 22" => "Không đọc được Port, tạm dùng 22",
        "設定了 {n} 把私鑰，先用第一把" => "Có {n} khóa riêng được cấu hình, dùng khóa đầu tiên",
        "讀不到 {path}：{e}" => "Không đọc được {path}: {e}",
        "工作階段沒有存使用者名稱，匯入後請補上" => "Phiên không lưu tên người dùng, hãy bổ sung sau khi nhập",
        "用的是原軟體金鑰庫裡的金鑰「{key}」：請先在原本的軟體把它匯出成 OpenSSH 格式，再匯入 db-kit 的金鑰庫（同名的金鑰匯入時會自動對上）" => "Dùng khóa \"{key}\" trong kho khóa của phần mềm gốc: hãy xuất nó sang định dạng OpenSSH từ phần mềm đó rồi nhập vào kho khóa của db-kit (khóa cùng tên sẽ tự khớp)",
        "找不到預設的 .xsh 工作階段資料夾，請手動選擇" => "Không tìm thấy thư mục phiên .xsh mặc định, hãy chọn thủ công",
        "不是資料夾：{path}" => "Không phải thư mục: {path}",
        "讀不到憑證 {path}：{e}" => "Không đọc được chứng chỉ {path}: {e}",
        "{detail}；另外略過：{skipped}" => "{detail}; bỏ qua: {skipped}",
        "密語不正確，請再輸入一次（{path}）" => "Sai cụm mật khẩu, vui lòng nhập lại ({path})",
        "PEM 標示為加密，卻沒有 DEK-Info" => "PEM được đánh dấu mã hóa nhưng không có DEK-Info",
        "不支援的 PEM 加密方式：{name}（可支援 DES-EDE3-CBC、DES-CBC、AES-128/192/256-CBC）" => "Kiểu mã hóa PEM không được hỗ trợ: {name} (hỗ trợ: DES-EDE3-CBC, DES-CBC, AES-128/192/256-CBC)",
        "PEM 的 DEK-Info IV 格式錯誤" => "IV trong DEK-Info của PEM không hợp lệ",
        "DSA（ssh-dss）金鑰：OpenSSH 7.0 起預設停用、9.8 起移除，多數伺服器已不接受。請改用 ed25519 或 RSA 3072 以上的金鑰。" => "Khóa DSA (ssh-dss): bị tắt mặc định từ OpenSSH 7.0 và bị gỡ ở 9.8, hầu hết máy chủ không còn chấp nhận. Hãy dùng khóa ed25519 hoặc RSA từ 3072 trở lên.",
        "SSH.COM（SECSH）格式的私鑰：請先轉成 OpenSSH 格式，例如 ssh-keygen -i -f <檔案> > id_key，或用 PuTTYgen 的 Import 再 Export OpenSSH key。" => "Khóa riêng định dạng SSH.COM (SECSH): hãy chuyển sang định dạng OpenSSH trước, ví dụ ssh-keygen -i -f <tệp> > id_key, hoặc PuTTYgen Import rồi Export OpenSSH key.",
        "這是公鑰，不是私鑰。請選對應的私鑰檔（通常是同名、沒有 .pub 的那個）。" => "Đây là khóa công khai, không phải khóa riêng. Hãy chọn tệp khóa riêng tương ứng (thường cùng tên nhưng không có .pub).",
        "這是 OpenSSH 憑證（-cert.pub），不是私鑰。請選對應的私鑰；憑證放在私鑰旁邊（<私鑰>-cert.pub）或在主機設定指定，連線時會一起使用。" => "Đây là chứng chỉ OpenSSH (-cert.pub), không phải khóa riêng. Hãy chọn khóa riêng tương ứng; đặt chứng chỉ cạnh khóa (<khóa>-cert.pub) hoặc chỉ định trong cấu hình máy chủ để dùng khi kết nối.",
        "這是 X.509（SSL / TLS）憑證，不是 SSH 金鑰。SSH 要用的是私鑰檔（例如 id_ed25519、.ppk、.pem）。" => "Đây là chứng chỉ X.509 (SSL / TLS), không phải khóa SSH. SSH cần tệp khóa riêng (ví dụ id_ed25519, .ppk, .pem).",
        "看起來是 PKCS#12（.pfx / .p12）憑證包或加密的二進位私鑰。請先轉出 PEM 私鑰，例如 openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem。" => "Có vẻ là gói chứng chỉ PKCS#12 (.pfx / .p12) hoặc khóa nhị phân đã mã hóa. Hãy xuất khóa riêng PEM trước, ví dụ openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem.",
        "認不得的金鑰格式。支援 OpenSSH、PuTTY PPK、PKCS#8、PEM（PKCS#1 RSA / SEC1 EC，含 OpenSSL 加密）與 DER；Xshell / SecureCRT 的金鑰請先在該軟體裡匯出成 OpenSSH 格式。" => "Không nhận ra định dạng khóa. Hỗ trợ: OpenSSH, PuTTY PPK, PKCS#8, PEM (PKCS#1 RSA / SEC1 EC, kể cả mã hóa OpenSSL) và DER; khóa của Xshell / SecureCRT hãy xuất sang định dạng OpenSSH trước.",
        "這把私鑰受密語保護，請輸入密語" => "Khóa riêng này được bảo vệ bằng cụm mật khẩu, vui lòng nhập cụm mật khẩu",
        "密語不正確（或不支援這種加密方式）：{e}" => "Sai cụm mật khẩu (hoặc kiểu mã hóa không được hỗ trợ): {e}",
        "無法解析私鑰：{e}" => "Không phân tích được khóa riêng: {e}",
        "解密後的內容不正確" => "Nội dung sau khi giải mã không hợp lệ",
        "憑證格式錯誤：{e}" => "Chứng chỉ không hợp lệ: {e}",
        "無效的金鑰 id：{id}" => "ID khóa không hợp lệ: {id}",
        "金鑰庫裡找不到這把金鑰（可能已刪除）：{id}" => "Không tìm thấy khóa trong kho khóa (có thể đã bị xóa): {id}",
        "加密私鑰失敗：{e}" => "Mã hóa khóa riêng thất bại: {e}",
        "轉成 OpenSSH 格式失敗：{e}" => "Chuyển sang định dạng OpenSSH thất bại: {e}",
        "產生金鑰失敗：{e}" => "Tạo khóa thất bại: {e}",
        "名稱不能是空的" => "Tên không được để trống",
        "讀不到公鑰" => "Không đọc được khóa công khai",
        "這張憑證簽的不是這把金鑰" => "Chứng chỉ này không được cấp cho khóa này",
        "本機已有同名項目：{path}" => "Đã có mục cùng tên trên máy: {path}",
        "略過 {n} 個同名項目" => "Đã bỏ qua {n} mục trùng tên",
        "略過 {n} 個連結或特殊檔案" => "Đã bỏ qua {n} liên kết hoặc tệp đặc biệt",
        "略過 {a} 個同名項目、{b} 個連結或特殊檔案" => "Đã bỏ qua {a} mục trùng tên và {b} liên kết hoặc tệp đặc biệt",
        "內容太大，無法在編輯器存檔（上限 {max} MiB）" => "Nội dung quá lớn, không thể lưu từ trình soạn thảo (tối đa {max} MiB)",
        "伺服器回傳可疑的檔名，已中止刪除：{name}" => "Máy chủ trả về tên tệp đáng ngờ, đã dừng xóa: {name}",
        "本機檔案已存在：{path}" => "Tệp cục bộ đã tồn tại: {path}",
        "遠端檔案已存在：{path}" => "Tệp từ xa đã tồn tại: {path}",
        "無效的檔名：{name}" => "Tên tệp không hợp lệ: {name}",
        "找不到檔案或目錄" => "Không tìm thấy tệp hoặc thư mục",
        "權限不足" => "Không đủ quyền",
        "伺服器不支援此操作" => "Máy chủ không hỗ trợ thao tác này",
        "SFTP 連線已中斷" => "Kết nối SFTP đã bị ngắt",
        "已到檔案結尾" => "Đã đến cuối tệp",
        "SFTP 協定錯誤" => "Lỗi giao thức SFTP",
        "操作失敗（伺服器未說明原因；常見為檔案已存在或目錄非空）" => "Thao tác thất bại (máy chủ không nêu lý do; thường do tệp đã tồn tại hoặc thư mục không trống)",
        "SFTP 操作逾時" => "Thao tác SFTP đã hết thời gian chờ",
        "SFTP I/O 錯誤：{e}" => "Lỗi I/O SFTP: {e}",
        "SFTP 錯誤：{e}" => "Lỗi SFTP: {e}",
        "本機檔案錯誤：{e}" => "Lỗi tệp cục bộ: {e}",

        // ---- filecmp/ + commands/filecmp.rs：檔案 / 資料夾 / 二進位比對 ----
        "比對錯誤：{detail}" => "Lỗi so sánh: {detail}",
        "已取消比對" => "Đã hủy so sánh",
        "無效的相對路徑：{rel}" => "Đường dẫn tương đối không hợp lệ: {rel}",
        "{path}：{e}" => "{path}: {e}",
        "已有同名檔案，無法建立資料夾：{path}" => "Đã có tệp cùng tên nên không thể tạo thư mục: {path}",
        "不能刪除比對的根資料夾" => "Không thể xóa thư mục gốc của phép so sánh",
        "項目超過 {max} 個，請改選範圍較小的資料夾或加上排除規則" => "Có hơn {max} mục. Hãy chọn thư mục nhỏ hơn hoặc thêm quy tắc loại trừ",
        "這是資料夾，不是檔案：{path}" => "Đây là thư mục, không phải tệp: {path}",
        "檔案在開啟之後已被修改：{path}" => "Tệp đã bị sửa sau khi mở: {path}",
        "來源已不存在：{path}" => "Nguồn không còn tồn tại: {path}",

        "{n} 個檔案無法保留修改時間（FTP），重新比較時可能仍顯示時間不同" => "{n} tệp không giữ được thời gian sửa đổi (FTP); so sánh lại có thể vẫn hiển thị khác thời gian",
        "{n} 段不同，共 {bytes} 個位元組（{a} / {b} bytes）" => "{n} đoạn khác nhau, tổng {bytes} byte ({a} / {b} bytes)",
        "{n} 項失敗" => "{n} mục thất bại",
        "一邊是資料夾、一邊是檔案，無法比對" => "Một bên là thư mục, một bên là tệp nên không thể so sánh",
        "內容相同" => "Nội dung giống nhau",
        "兩個檔差異太大，無法逐行比對，請改用 --mode binary" => "Hai tệp khác nhau quá nhiều để so sánh từng dòng; hãy dùng --mode binary",
        "兩邊不同" => "Hai bên khác nhau",
        "兩邊已經一致，沒有需要處理的項目。" => "Hai bên đã đồng bộ, không có gì cần xử lý.",
        "兩邊是資料夾，請改用資料夾比對" => "Cả hai bên là thư mục; hãy dùng so sánh thư mục",
        "同步 {left} ↔ {right}：複製 {c} 項、刪除 {d} 項" => "đồng bộ {left} ↔ {right}: sao chép {c} mục, xóa {d} mục",
        "同步的兩邊都要是資料夾" => "Cả hai bên của đồng bộ phải là thư mục",
        "失敗：{path}：{msg}" => "Thất bại: {path}: {msg}",
        "完成：複製 {c} 項、刪除 {d} 項" => "Xong: đã sao chép {c} mục, xóa {d} mục",
        "寫入比對工作階段失敗：{e}" => "Ghi các phép so sánh đã lưu thất bại: {e}",
        "找不到已存的比對：{name}" => "Không tìm thấy phép so sánh đã lưu: {name}",
        "找不到：{path}" => "Không tìm thấy: {path}",
        "檔案太大，無法逐行比對，請改用 --mode binary" => "Tệp quá lớn để so sánh từng dòng; hãy dùng --mode binary",
        "比對工作階段檔案格式錯誤（{path}）：{e}" => "Tệp các phép so sánh đã lưu bị sai định dạng ({path}): {e}",
        "衝突（不處理）：{path}" => "Xung đột (bỏ qua): {path}",
        "請用 --rule 指定同步規則（mirror-lr / mirror-rl / update-lr / update-rl / update-both）" => "Hãy chọn quy tắc đồng bộ bằng --rule (mirror-lr / mirror-rl / update-lr / update-rl / update-both)",
        "請給左右兩邊的路徑，或用 --session 指定已存的比對" => "Hãy cho đường dẫn hai bên, hoặc chọn phép so sánh đã lưu bằng --session",
        "警告：{side} 讀不到 {path}：{msg}" => "Cảnh báo: không đọc được {path} ở bên {side}: {msg}",
        "警告：無法比對內容 {path}：{msg}" => "Cảnh báo: không so sánh được nội dung {path}: {msg}",
        "讀取比對工作階段失敗：{e}" => "Đọc các phép so sánh đã lưu thất bại: {e}",
        "資料夾比對的兩邊都要是資料夾" => "Cả hai bên của so sánh thư mục phải là thư mục",

        // ---- rd/ + commands/rd.rs + error.rs：遠端桌面（RDP / VNC / RustDesk）----
        "遠端桌面錯誤：{detail}" => "Lỗi máy tính từ xa: {detail}",
        "遠端桌面認證失敗：{detail}" => "Xác thực máy tính từ xa thất bại: {detail}",
        "使用者已取消遠端桌面連線" => "Người dùng đã hủy kết nối máy tính từ xa",
        "找不到遠端桌面主機：{id}" => "Không tìm thấy máy tính từ xa: {id}",
        "未填寫遠端主機" => "Chưa nhập máy chủ từ xa",
        "無法讀取檔案：{e}" => "Không đọc được tệp: {e}",
        "檔案太大，不像是 .rdp 連線檔" => "Tệp quá lớn, có vẻ không phải tệp .rdp",
        "這個版本尚未內建 RustDesk 連線" => "Phiên bản này chưa tích hợp kết nối RustDesk",
        "這個版本未內建 RDP" => "Phiên bản này không tích hợp RDP",
        "這個版本未內建 VNC" => "Phiên bản này không tích hợp VNC",
        "RDP 連線執行緒意外結束" => "Luồng kết nối RDP kết thúc bất ngờ",
        "認證失敗次數過多" => "Xác thực thất bại quá nhiều lần",
        "無法讀取剪貼簿：{e}" => "Không thể đọc bảng tạm: {e}",
        "無法寫入剪貼簿：{e}" => "Không thể ghi vào bảng tạm: {e}",
        "無法讀取資料夾 {path}：{e}" => "Không đọc được thư mục {path}: {e}",
        "RustDesk 傳檔連線已中斷：{e}" => "Kết nối truyền tệp RustDesk đã bị ngắt: {e}",
        "對方的 RustDesk 沒有回應（資料夾可能不存在或沒有權限）" => "RustDesk bên kia không phản hồi (thư mục có thể không tồn tại hoặc không có quyền)",
        "對方的 RustDesk 沒有回應（傳輸停住了）" => "RustDesk bên kia ngừng phản hồi (quá trình truyền bị treo)",
        "RustDesk 只能在同一個資料夾裡改名，不能搬到別的資料夾" => "RustDesk chỉ đổi tên được trong cùng thư mục, không chuyển sang thư mục khác",
        "新的名稱不能是空的" => "Tên mới không được để trống",
        "內容太大，無法直接存檔" => "Nội dung quá lớn, không lưu trực tiếp được",
        "遠端已有同名的資料夾：{path}" => "Bên kia đã có thư mục cùng tên: {path}",
        "RustDesk 傳檔不能改權限" => "Truyền tệp RustDesk không đổi được quyền",
        "只有 RustDesk 連線能傳檔" => "Chỉ kết nối RustDesk mới truyền tệp được",
        "只有 RustDesk 連線能輸入作業系統密碼" => "Chỉ kết nối RustDesk mới nhập được mật khẩu hệ điều hành",
        "這台主機沒有存作業系統密碼" => "Máy này chưa lưu mật khẩu hệ điều hành",
        "找不到可以存放錄影的資料夾" => "Không tìm thấy thư mục để lưu bản ghi",
        "無法建立錄影資料夾：{e}" => "Không thể tạo thư mục bản ghi: {e}",
        "無法建立錄影檔：{e}" => "Không thể tạo tệp bản ghi: {e}",
        "錄影已經結束" => "Bản ghi đã kết thúc",
        "寫入錄影檔失敗：{e}" => "Không ghi được tệp bản ghi: {e}",
        "不是錄影資料夾裡的檔案" => "Không phải tệp trong thư mục bản ghi",
        "找不到可以存放截圖的資料夾" => "Không tìm thấy thư mục để lưu ảnh chụp màn hình",
        "無法建立截圖資料夾：{e}" => "Không thể tạo thư mục ảnh chụp màn hình: {e}",
        "截圖存檔失敗：{e}" => "Không thể lưu ảnh chụp màn hình: {e}",
        "找不到 RustDesk 連線元件（dbk-rustdesk-bridge），請重新安裝 db-kit" => "Không tìm thấy thành phần kết nối RustDesk (dbk-rustdesk-bridge). Vui lòng cài lại db-kit",
        "無法啟動 RustDesk 連線元件：{e}" => "Không thể khởi động thành phần kết nối RustDesk: {e}",
        "RustDesk 連線元件沒有回應：{e}" => "Thành phần kết nối RustDesk không phản hồi: {e}",
        "RustDesk 連線元件意外結束" => "Thành phần kết nối RustDesk đã thoát bất ngờ",
        "RustDesk 連線逾時（對方沒有回應，或沒有在畫面上按接受）" => "Kết nối RustDesk quá thời gian (máy bên kia không phản hồi, hoặc chưa ai bấm Chấp nhận trên màn hình của họ)",
        "RustDesk 密碼錯誤" => "Mật khẩu RustDesk không đúng",
        "對方要求輸入密碼" => "Máy bên kia yêu cầu mật khẩu",
        "對方拒絕了連線：{m}" => "Máy bên kia đã từ chối kết nối: {m}",
        "對方一直沒有回應登入：沒有人在對方畫面上按「接受」。請輸入對方的 RustDesk 密碼" => "Máy bên kia không phản hồi đăng nhập: không ai nhấn “Chấp nhận” trên màn hình bên đó. Hãy nhập mật khẩu RustDesk của máy bên kia",
        "對方的 RustDesk 開啟了雙重驗證（2FA），需要輸入驗證碼" => "RustDesk của máy bên kia đã bật xác thực hai lớp (2FA): cần nhập mã xác minh",
        "雙重驗證碼錯誤" => "Mã xác thực hai lớp không đúng",
        "密碼或驗證碼錯誤次數太多，對方暫時拒絕登入：請一分鐘後再試" => "Nhập sai mật khẩu hoặc mã xác minh quá nhiều lần, máy bên kia tạm thời từ chối đăng nhập. Hãy thử lại sau một phút",
        "密碼或驗證碼錯誤次數太多，對方的 RustDesk 已封鎖這台電腦的登入：請對方重新啟動 RustDesk 後再試" => "Nhập sai mật khẩu hoặc mã xác minh quá nhiều lần, RustDesk của máy bên kia đã chặn đăng nhập từ máy tính này. Hãy nhờ họ khởi động lại RustDesk rồi thử lại",
        "驗證碼錯誤：請輸入驗證器 App 上目前顯示的那組（每 30 秒會換一組）" => "Mã xác minh không đúng: hãy nhập mã ứng dụng xác thực đang hiển thị (mã đổi sau mỗi 30 giây)",
        "對方一直沒有在畫面上按「接受」（對方的 RustDesk 設定為只能按接受、不能用密碼登入）" => "Không ai nhấn “Chấp nhận” trên màn hình máy bên kia (RustDesk bên đó chỉ cho phép chấp nhận trên màn hình, không đăng nhập bằng mật khẩu)",
        "對方的 RustDesk 設定為只能在畫面上按「接受」，不能用密碼登入：已請對方按接受，按了就會連上。" => "RustDesk của máy bên kia chỉ cho phép chấp nhận kết nối trên màn hình, không đăng nhập bằng mật khẩu. Đã yêu cầu họ nhấn “Chấp nhận”; khi họ nhấn là kết nối.",
        "對方的 RustDesk 開啟了雙重驗證（2FA）：請輸入對方綁定的驗證器 App（如 Google Authenticator）上顯示的 6 位數驗證碼。" => "RustDesk của máy bên kia đã bật xác thực hai lớp (2FA): hãy nhập mã 6 chữ số hiển thị trong ứng dụng xác thực (ví dụ Google Authenticator) mà họ đã liên kết.",
        "更新失敗：{detail}" => "Cập nhật thất bại: {detail}",
        "這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔" => "Kiểu cài đặt này không hỗ trợ tự động cập nhật; hãy tải bộ cài từ GitHub",
        "版本號格式不對：{v}" => "Số phiên bản không đúng định dạng: {v}",
        "查不到 v{v} 的 Release：{e}" => "Không tìm thấy bản phát hành v{v}: {e}",
        "{tag} 沒有這台電腦用的安裝檔" => "{tag} không có bộ cài cho máy tính này",
        "安裝檔的下載網址不對：{u}" => "URL tải bộ cài không đúng: {u}",
        "GitHub 沒有提供安裝檔的 SHA-256，無法確認檔案完整，已取消更新" => "GitHub không cung cấp SHA-256 của bộ cài nên không thể kiểm tra tính toàn vẹn; đã hủy cập nhật",
        "下載的安裝檔 SHA-256 對不上，可能下載不完整或被竄改，已取消更新" => "SHA-256 của bộ cài đã tải không khớp (tải chưa đủ hoặc bị sửa đổi); đã hủy cập nhật",
        "下載安裝檔失敗：{e}" => "Tải bộ cài thất bại: {e}",
        "無法啟動安裝程式：{e}" => "Không thể khởi động bộ cài: {e}",
        "沒有權限寫入 {dir}，請到 GitHub 下載新版 AppImage 自行替換" => "Không có quyền ghi vào {dir}; hãy tải AppImage mới từ GitHub và tự thay thế",
        "替換 AppImage 失敗：{e}" => "Không thể thay thế AppImage: {e}",
        "找不到 pkexec，無法取得系統管理員權限安裝更新，請到 GitHub 下載安裝檔" => "Không tìm thấy pkexec nên không thể cài bản cập nhật bằng quyền quản trị; hãy tải bộ cài từ GitHub",
        "已取消安裝：沒有輸入系統管理員密碼" => "Đã hủy cài đặt: chưa nhập mật khẩu quản trị",
        "沒有取得系統管理員權限，無法安裝更新" => "Không lấy được quyền quản trị nên không thể cài bản cập nhật",
        "{program} 安裝失敗（結束代碼 {code}）" => "{program} cài bản cập nhật thất bại (mã thoát {code})",
        "{program} 安裝中途被中斷" => "{program} bị gián đoạn khi đang cài bản cập nhật",
        "已請對方在畫面上按「接受」，對方按了就會連上；也可以直接輸入對方的 RustDesk 密碼。" => "Đã yêu cầu máy bên kia nhấn “Chấp nhận” trên màn hình; khi họ nhấn là kết nối. Bạn cũng có thể nhập mật khẩu RustDesk của máy bên kia.",
        "找不到這個 RustDesk ID：請確認 ID 沒有打錯，而且這裡的 ID 伺服器跟對方 RustDesk 設定的是同一台" => "Không tìm thấy ID RustDesk: hãy kiểm tra lại ID, và chắc chắn máy chủ ID ở đây trùng với máy chủ đã đặt trong RustDesk bên kia",
        "對方不在線上：對方電腦沒開 RustDesk，或它連不到 ID 伺服器" => "Máy bên kia đang ngoại tuyến: RustDesk chưa chạy trên máy đó, hoặc máy đó không kết nối được tới máy chủ ID",
        "ID 伺服器拒絕連線：Key 不符。請在連線設定填入 ID 伺服器的公鑰（跟對方 RustDesk 設定的 Key 相同）" => "Máy chủ ID từ chối kết nối: Key không khớp. Hãy nhập khóa công khai của máy chủ ID trong cài đặt kết nối (giống Key đã đặt trong RustDesk bên kia)",
        "ID 伺服器拒絕連線：這個 Key 的使用量已達上限" => "Máy chủ ID từ chối kết nối: Key này đã đạt giới hạn sử dụng",
        "連不到 ID 伺服器：{m}" => "Không kết nối được tới máy chủ ID: {m}",
        "ID 伺服器沒有回應（對方可能剛離線，稍後再試）" => "Máy chủ ID không phản hồi (có thể máy bên kia vừa ngoại tuyến; hãy thử lại sau)",
        "連不到中繼伺服器：{m}" => "Không kết nối được tới máy chủ chuyển tiếp: {m}",
        "中繼伺服器拒絕連線：{m}" => "Máy chủ chuyển tiếp từ chối kết nối: {m}",
        "經中繼伺服器連線失敗：{m}" => "Kết nối qua máy chủ chuyển tiếp thất bại: {m}",
        "用 RustDesk ID 連線不能經 SSH 主機轉接：請改填對方電腦的 IP 位址（Direct IP），或取消「經 SSH 主機連線」" => "Kết nối bằng ID RustDesk không thể đi qua máy chủ SSH: hãy nhập địa chỉ IP của máy bên kia (Direct IP), hoặc bỏ chọn “Kết nối qua máy chủ SSH”",
        "VNC 握手逾時" => "Bắt tay VNC quá thời gian chờ",
        "VNC 伺服器無法建立 TLS 連線" => "Máy chủ VNC không thiết lập được kết nối TLS",
        "伺服器的 VeNCrypt 沒有支援的子型別（{list}）；可以在主機設定把認證方式改成「VNC 密碼」" => "VeNCrypt của máy chủ không có kiểu con nào được hỗ trợ ({list}); có thể đổi phương thức xác thực thành “mật khẩu VNC” trong cài đặt máy",
        "無法切換全螢幕：{e}" => "Không chuyển được chế độ toàn màn hình: {e}",
        "遠端桌面連線已關閉" => "Kết nối máy tính từ xa đã đóng",
        "同時開啟的遠端桌面連線已達上限（{n}）" => "Đã đạt giới hạn số kết nối máy tính từ xa mở cùng lúc ({n})",
        "遠端桌面連線不存在或已關閉" => "Kết nối máy tính từ xa không tồn tại hoặc đã đóng",
        "找不到待回答的遠端桌面提示（可能已逾時）" => "Không tìm thấy lời nhắc máy tính từ xa đang chờ trả lời (có thể đã quá thời gian chờ)",
        "無法連線到 {host}:{port}：{e}" => "Không kết nối được tới {host}:{port}: {e}",
        "連線 {host}:{port} 逾時（{s} 秒）" => "Kết nối tới {host}:{port} quá thời gian chờ ({s} giây)",
        "SSH 主機無法轉接到 {host}:{port}：{e}" => "Máy chủ SSH không chuyển tiếp được tới {host}:{port}: {e}",
        "伺服器要求網路層級驗證（NLA），請在連線設定開啟 NLA" => "Máy chủ yêu cầu Xác thực cấp mạng (NLA); hãy bật NLA trong thiết lập kết nối",
        "伺服器不接受目前的安全層設定：{detail}" => "Máy chủ không chấp nhận thiết lập lớp bảo mật hiện tại: {detail}",
        "TLS 握手失敗：{e}" => "Bắt tay TLS thất bại: {e}",
        "無法讀取已信任的遠端桌面憑證清單：{e}" => "Không đọc được danh sách chứng chỉ máy tính từ xa đã tin cậy: {e}",
        "無法記住憑證：{e}" => "Không ghi nhớ được chứng chỉ: {e}",
        "讀不到伺服器憑證的公鑰" => "Không đọc được khóa công khai trong chứng chỉ máy chủ",
        "連線中斷：{e}" => "Mất kết nối: {e}",
        "RDP 協定錯誤：{e}" => "Lỗi giao thức RDP: {e}",
        "重新啟用工作階段失敗：{e}" => "Kích hoạt lại phiên thất bại: {e}",
        "遠端主機結束了工作階段" => "Máy từ xa đã kết thúc phiên",
        "遠端主機關閉了連線" => "Máy từ xa đã đóng kết nối",
        "不支援的 VNC 認證型別：{n}" => "Kiểu xác thực VNC không được hỗ trợ: {n}",
        "VNC 伺服器回應的版本字串格式不正確" => "Chuỗi phiên bản do máy chủ VNC trả về sai định dạng",
        "伺服器未提供指定的 VNC 認證方式（{name}）；實際提供：{list}" => "Máy chủ không cung cấp phương thức xác thực VNC đã chọn ({name}); thực tế cung cấp: {list}",
        "伺服器未提供任何支援的 VNC 認證方式；實際提供：{list}" => "Máy chủ không cung cấp phương thức xác thực VNC nào được hỗ trợ; thực tế cung cấp: {list}",
        "VNC 伺服器拒絕連線" => "Máy chủ VNC từ chối kết nối",
        "ARD 金鑰長度不合理" => "Độ dài khóa ARD không hợp lệ",
        "伺服器不接受 VeNCrypt 0.2" => "Máy chủ không chấp nhận VeNCrypt 0.2",
        "伺服器未提供 VeNCrypt-Plain 子型別" => "Máy chủ không cung cấp kiểu con VeNCrypt-Plain",
        "VNC 認證被伺服器拒絕" => "Máy chủ từ chối xác thực VNC",
        "VNC 伺服器回應的原因字串過長" => "Chuỗi lý do do máy chủ VNC trả về quá dài",
        "VNC 連線 I/O 錯誤：{detail}" => "Lỗi I/O kết nối VNC: {detail}",
        "noVNC 端回應的 RFB 版本字串格式不正確" => "Chuỗi phiên bản RFB do phía noVNC trả về sai định dạng",
        "noVNC 端選了非預期的認證型別：{n}" => "Phía noVNC chọn kiểu xác thực không mong đợi: {n}",
        _ => return None,
    })
}
