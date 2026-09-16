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
        _ => return None,
    })
}
