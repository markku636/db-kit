//! 由 `SchemaDiff` 產生「讓目標變成來源」的同步 DDL（純函式）。
//!
//! 全域順序（不是逐表）：先卸外鍵 → 建缺少的表 → 卸索引 → 欄位（加 / 改 / 刪）→ 建索引 → 加外鍵
//! → 視圖 → 程序 → 最後才 DROP TABLE。這樣被參照的表一定先存在、要刪的表上的外鍵一定先卸。
//!
//! 每句帶 `destructive` 旗標：DROP TABLE / COLUMN / VIEW / ROUTINE、改型別、改成 NOT NULL、
//! 卸 unique 索引——CLI 以 `--force`、GUI 以二次勾選把關；其餘（加欄 / 加索引 / 外鍵）為一般寫入。
//! 引擎表達不出來的變更（SQLite 改型別、MSSQL 改 default）進 `skipped`，不會靜默漏掉。

use serde::{Deserialize, Serialize};

use super::diff::{ColumnAttr, SchemaDiff, TableDiff, TextChange};
use super::schema::{group_fks, strip_auto_increment, DbSchema, ForeignKey, TableSchema};
use crate::db::sqlgen::{qualified, quote_ident, sql_literal};
use crate::db::{ColumnInfo, DbKind, IndexInfo};
use crate::error::{AppError, AppResult};
use crate::transfer::rewrite_create_table_name;

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncKind {
    CreateTable,
    DropTable,
    AddColumn,
    AlterColumn,
    DropColumn,
    CreateIndex,
    DropIndex,
    AddForeignKey,
    DropForeignKey,
    CreateView,
    DropView,
    CreateRoutine,
    DropRoutine,
    Comment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatement {
    pub sql: String,
    pub kind: SyncKind,
    /// 受影響的物件（表名 / 表.欄 / 索引名…），供 UI 分組顯示。
    pub object: String,
    pub destructive: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncScript {
    pub target_kind: DbKind,
    pub target_db: String,
    pub statements: Vec<SyncStatement>,
    pub destructive_count: usize,
    /// 無法以 DDL 表達的變更（人可讀），要使用者手動處理。
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncOptions {
    /// false：DROP TABLE / COLUMN / VIEW / ROUTINE 進 `skipped` 而非 `statements`。
    #[serde(default)]
    pub include_drops: bool,
    #[serde(default = "yes")]
    pub include_indexes: bool,
    #[serde(default = "yes")]
    pub include_fks: bool,
    #[serde(default = "yes")]
    pub include_views: bool,
    #[serde(default)]
    pub include_routines: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self { include_drops: false, include_indexes: true, include_fks: true, include_views: true, include_routines: false }
    }
}

/// 整份腳本文字：語句以 `;` 結尾、空行分隔；破壞性語句前加註解。
pub fn script_text(script: &SyncScript) -> String {
    let mut out = String::new();
    for s in &script.statements {
        if s.destructive {
            out.push_str("-- [destructive]\n");
        }
        if let Some(n) = &s.note {
            out.push_str(&format!("-- {n}\n"));
        }
        out.push_str(s.sql.trim_end_matches(';').trim_end());
        out.push_str(";\n\n");
    }
    if !script.skipped.is_empty() {
        out.push_str("-- 未能自動產生的變更：\n");
        for s in &script.skipped {
            out.push_str(&format!("-- * {s}\n"));
        }
    }
    out
}

struct Gen<'a> {
    kind: DbKind,
    db: &'a str,
    src: &'a DbSchema,
    dst: &'a DbSchema,
    opts: &'a SyncOptions,
    // 依階段收集，最後再攤平成全域順序。
    drop_fks: Vec<SyncStatement>,
    create_tables: Vec<SyncStatement>,
    drop_indexes: Vec<SyncStatement>,
    columns: Vec<SyncStatement>,
    create_indexes: Vec<SyncStatement>,
    add_fks: Vec<SyncStatement>,
    views: Vec<SyncStatement>,
    routines: Vec<SyncStatement>,
    drop_tables: Vec<SyncStatement>,
    skipped: Vec<String>,
}

pub fn generate(diff: &SchemaDiff, src: &DbSchema, dst: &DbSchema, opts: &SyncOptions) -> AppResult<SyncScript> {
    if diff.cross_engine {
        return Err(AppError::Unsupported(t!("來源與目標資料庫種類不同，無法產生同步 DDL").into()));
    }
    let mut g = Gen {
        kind: dst.kind,
        db: &dst.database,
        src,
        dst,
        opts,
        drop_fks: vec![],
        create_tables: vec![],
        drop_indexes: vec![],
        columns: vec![],
        create_indexes: vec![],
        add_fks: vec![],
        views: vec![],
        routines: vec![],
        drop_tables: vec![],
        skipped: vec![],
    };

    for name in &diff.tables_added {
        if let Some(t) = src.table(name) {
            g.create_table(t);
        }
    }
    for td in &diff.tables_changed {
        g.changed_table(td);
    }
    for name in &diff.tables_removed {
        g.drop_table(name);
    }
    if opts.include_views {
        for name in &diff.views_removed {
            g.drop_view(name);
        }
        for tc in &diff.views_changed {
            g.drop_view(&tc.name);
            if let Some(v) = src.view(&tc.name) {
                g.create_view(v);
            }
        }
        for name in &diff.views_added {
            if let Some(v) = src.view(name) {
                g.create_view(v);
            }
        }
    }
    if opts.include_routines {
        // 觸發器要排在函式之前卸除：PG 的觸發器相依於觸發函式，先 DROP FUNCTION 會被
        // 「cannot drop function … because other objects depend on it」擋下。
        // capture 依 (routine_type, name) 排序，"function" 字典序在 "trigger" 前面，剛好是錯的順序。
        let is_trigger = |t: &TextChange| t.routine_type.as_deref() == Some("trigger");
        for tc in diff.routines_removed.iter().filter(|t| is_trigger(t)) {
            g.drop_routine(tc, dst);
        }
        for tc in diff.routines_removed.iter().filter(|t| !is_trigger(t)) {
            g.drop_routine(tc, dst);
        }
        for tc in &diff.routines_changed {
            g.drop_routine(tc, dst);
            g.create_routine(tc);
        }
        for tc in &diff.routines_added {
            g.create_routine(tc);
        }
    }

    let mut statements = Vec::new();
    statements.append(&mut g.drop_fks);
    statements.append(&mut g.create_tables);
    statements.append(&mut g.drop_indexes);
    statements.append(&mut g.columns);
    statements.append(&mut g.create_indexes);
    statements.append(&mut g.add_fks);
    statements.append(&mut g.views);
    statements.append(&mut g.routines);
    statements.append(&mut g.drop_tables);
    let destructive_count = statements.iter().filter(|s| s.destructive).count();
    Ok(SyncScript {
        target_kind: dst.kind,
        target_db: dst.database.clone(),
        statements,
        destructive_count,
        skipped: g.skipped,
    })
}

fn st(kind: SyncKind, object: impl Into<String>, sql: String, destructive: bool) -> SyncStatement {
    SyncStatement { sql, kind, object: object.into(), destructive, note: None }
}

fn with_note(mut s: SyncStatement, note: impl Into<String>) -> SyncStatement {
    s.note = Some(note.into());
    s
}

/// 從 MySQL 的 EXTRA 取出 `ON UPDATE CURRENT_TIMESTAMP[(n)]` 子句（沒有則 None）。
/// EXTRA 形如 `DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)`，8.0.23+ 還可能在尾端接 `INVISIBLE`，
/// 所以只取 `on update` 後的那一個 token，不能整段尾巴照抄。
fn on_update_clause(extra: &str) -> Option<String> {
    let low = extra.to_ascii_lowercase();
    let p = low.find("on update")?;
    // to_ascii_lowercase 不改變位元組長度，索引可直接套回原字串。
    let tok = extra[p + "on update".len()..].split_whitespace().next()?;
    Some(format!("ON UPDATE {tok}"))
}

/// SQL Server 專用：把一句 DDL 包成「在目標資料庫裡自成一個批次」的 sp_executesql。
/// 兩個 T-SQL 硬限制逼出這個寫法：CREATE / DROP 的 VIEW、PROCEDURE、FUNCTION、TRIGGER 一律
/// 拒收三部式名稱（Msg 166 does not allow specifying the database name as a prefix），
/// 而 CREATE VIEW / PROCEDURE / TRIGGER 又必須是批次的第一個語句。包起來後名稱只剩
/// `[schema].[obj]`，資料庫改由 `[db].sys.sp_executesql` 指定 —— 不必倚賴連線當下 USE 在哪個庫，
/// 跨連線同步（來源庫 != 目標庫）才不會建到錯的資料庫去。
fn mssql_batch(db: &str, inner: &str) -> String {
    let body = inner.trim().trim_end_matches(';').trim_end();
    if db.is_empty() {
        return body.to_string();
    }
    format!(
        "EXEC {}.sys.sp_executesql N'{}'",
        quote_ident(DbKind::Mssql, db),
        body.replace('\'', "''")
    )
}

/// 預設值是否可原樣放進 DDL（表達式 / 數字 / 關鍵字），否則要當字串加引號。
fn default_is_expression(d: &str) -> bool {
    let l = d.trim().to_ascii_lowercase();
    l.is_empty()
        || l == "null"
        || l == "true"
        || l == "false"
        || l.starts_with("current_")
        || l.starts_with("now(")
        || l.starts_with("nextval(")
        || l.starts_with("getdate(")
        || l.starts_with("sys")
        || l.starts_with('(')
        || l.starts_with('\'')
        || l.starts_with("b'")
        || l.starts_with("x'")
        || l.contains("::")
        || l.parse::<f64>().is_ok()
}

impl<'a> Gen<'a> {
    fn q(&self, table: &str) -> String {
        qualified(self.kind, self.db, table)
    }
    fn qi(&self, id: &str) -> String {
        quote_ident(self.kind, id)
    }

    fn default_sql(&self, c: &ColumnInfo) -> Option<String> {
        let d = c.default.as_deref()?.trim();
        // SQLite（PRAGMA dflt_value）與部分 driver 把「無預設值」回成空字串而非 NULL。
        if d.is_empty() || d.eq_ignore_ascii_case("null") {
            return None;
        }
        match self.kind {
            // MySQL information_schema 的字串預設值不帶引號（abc），表達式帶 DEFAULT_GENERATED 才會是原樣。
            DbKind::Mysql | DbKind::Mariadb => {
                if default_is_expression(d) || c.extra.to_ascii_lowercase().contains("default_generated") {
                    Some(d.to_string())
                } else {
                    Some(sql_literal(self.kind, Some(d)))
                }
            }
            // PG / MSSQL / Oracle / SQLite 的 catalog 已是可執行表達式。
            _ => Some(d.to_string()),
        }
    }

    /// 完整欄位規格（MySQL ADD / MODIFY、Oracle ADD、MSSQL ADD 用）。
    fn column_spec(&self, c: &ColumnInfo) -> String {
        let mut s = format!("{} {}", self.qi(&c.name), c.data_type);
        let extra = c.extra.to_ascii_lowercase();
        match self.kind {
            DbKind::Mysql | DbKind::Mariadb => {
                s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
                if let Some(d) = self.default_sql(c) {
                    s.push_str(&format!(" DEFAULT {d}"));
                }
                if extra.contains("auto_increment") {
                    s.push_str(" AUTO_INCREMENT");
                }
                // MODIFY COLUMN 會重設未列出的屬性，而 ON UPDATE CURRENT_TIMESTAMP 只存在於 EXTRA：
                // 不補回來的話，只要該欄有任何其他屬性要改，同步就會靜默拿掉目標的自動更新行為。
                if let Some(clause) = on_update_clause(&c.extra) {
                    s.push_str(&format!(" {clause}"));
                }
                if !c.comment.is_empty() {
                    s.push_str(&format!(" COMMENT {}", sql_literal(self.kind, Some(&c.comment))));
                }
            }
            DbKind::Oracle => {
                if let Some(d) = self.default_sql(c) {
                    s.push_str(&format!(" DEFAULT {d}"));
                }
                if !c.nullable {
                    s.push_str(" NOT NULL");
                }
            }
            DbKind::Mssql => {
                s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
                if let Some(d) = self.default_sql(c) {
                    s.push_str(&format!(" DEFAULT {d}"));
                }
            }
            _ => {
                // PG / SQLite
                if !c.nullable {
                    s.push_str(" NOT NULL");
                }
                if let Some(d) = self.default_sql(c) {
                    s.push_str(&format!(" DEFAULT {d}"));
                }
            }
        }
        s
    }

    fn skip(&mut self, msg: String) {
        self.skipped.push(msg);
    }

    // ---- tables ----

    fn create_table(&mut self, t: &TableSchema) {
        let Some(ddl) = &t.ddl else {
            self.skip(tf!("資料表 {name}：來源無 DDL，無法產生 CREATE TABLE", name = t.name));
            return;
        };
        let ddl = if matches!(self.kind, DbKind::Mysql | DbKind::Mariadb) { strip_auto_increment(ddl) } else { ddl.clone() };
        // PG 的 serial 預設值是 `nextval('<來源 schema>.xxx_seq')`。照抄過去，目標表就與來源**共用同一條序列**：
        // 來源插入會吃掉目標的號碼，來源 schema 一被 DROP，目標的預設值也跟著壞掉。
        // diff 端看不到（normalize_default 把兩側都收斂成 "nextval(…)"），所以至少在這裡讓使用者看見。
        if self.kind == DbKind::Postgres
            && self.src.database != self.dst.database
            && ddl.contains(&format!("nextval('{}.", self.src.database))
        {
            self.skip(tf!(
                "資料表 {name}：serial 預設值指向來源 schema（{src}）的序列，目標需自建序列後改 DEFAULT",
                name = t.name,
                src = self.src.database
            ));
        }
        match rewrite_create_table_name(&ddl, self.db, &t.name, self.kind) {
            Ok(sql) => {
                let mut s = st(SyncKind::CreateTable, t.name.clone(), sql, false);
                if self.kind == DbKind::Oracle {
                    s = with_note(s, t!("Oracle DDL 含儲存子句（TABLESPACE 等），目標環境可能需調整"));
                }
                self.create_tables.push(s);
            }
            Err(e) => self.skip(tf!("資料表 {name}：{err}", name = t.name, err = e.to_string())),
        }
        // 合成 DDL（PG / MSSQL）不含索引 / 外鍵：另外補。
        if t.ddl_synthesized {
            if self.opts.include_indexes {
                for ix in t.indexes.iter().filter(|i| !i.primary) {
                    self.create_index(&t.name, ix);
                }
            }
            if self.opts.include_fks {
                for fk in group_fks(&t.foreign_keys) {
                    self.add_fk(&t.name, &fk);
                }
            }
        }
    }

    fn drop_table(&mut self, name: &str) {
        if !self.opts.include_drops {
            self.skip(tf!("資料表 {name}：目標多出（未含 DROP）", name = name));
            return;
        }
        // 先卸掉目標上這張表的外鍵（其他表參照它時 DROP 會失敗；自身的外鍵隨表消失，卸了也無妨）。
        if let Some(dt) = self.dst.table(name) {
            for fk in group_fks(&dt.foreign_keys) {
                self.drop_fk(name, &fk);
            }
        }
        let sql = format!("DROP TABLE {}", self.q(name));
        self.drop_tables.push(st(SyncKind::DropTable, name, sql, true));
    }

    fn changed_table(&mut self, td: &TableDiff) {
        let name = td.name.as_str();
        // 「結構化比對看不出差異、但原始 DDL 不同」的整個類別（charset / collation / ENGINE /
        // ROW_FORMAT / 表註解 / 分割 / ON UPDATE 等）都產不出語句。不記一筆的話，使用者會看到
        // 「同步完成」但下次比對依然有差異，且永遠不知道差在哪 —— 與本檔案「不靜默漏掉」的原則相違。
        if td.ddl_differs && td.is_empty() {
            self.skip(tf!(
                "資料表 {name}：欄位 / 索引 / 外鍵皆相同，但建表 DDL 仍有差異（字元集 / 儲存引擎 / 註解 / ON UPDATE 等），需手動比對",
                name = name
            ));
        }
        // 外鍵：改 = 卸 + 加。
        if self.opts.include_fks {
            for f in &td.fks_removed {
                self.drop_fk(name, f);
            }
            for c in &td.fks_changed {
                self.drop_fk(name, &c.dst);
            }
        }
        // 索引：改 = 卸 + 建；主鍵變更太引擎特定 → skipped。
        if self.opts.include_indexes {
            for i in &td.indexes_removed {
                if i.primary {
                    self.skip(tf!("{table}：主鍵變更請手動處理", table = name));
                } else {
                    self.drop_index(name, i);
                }
            }
            for c in &td.indexes_changed {
                if c.src.primary || c.dst.primary {
                    self.skip(tf!("{table}：主鍵變更請手動處理", table = name));
                } else {
                    self.drop_index(name, &c.dst);
                }
            }
        }
        // SQL Server 不准 ALTER COLUMN 動「被索引參照」的欄位（Msg 5074 The index … is dependent on
        // column …）。不先卸索引的話，產出的語句看起來合法、套用時卻必定失敗，使用者只會看到同步錯誤
        // 而不知道要自己拆索引。全域順序本來就是「卸索引 → 欄位 → 建索引」，這裡補上兩句就自動排對位置；
        // 主鍵 / 唯一索引多半由約束建立（DROP INDEX 卸不掉，要 DROP CONSTRAINT），只能記 skipped。
        let mut blocked: Vec<String> = Vec::new();
        if self.kind == DbKind::Mssql && self.opts.include_indexes {
            // 已經要卸 / 要改的索引不必再處理一次。
            let handled: Vec<&str> = td
                .indexes_removed
                .iter()
                .map(|i| i.name.as_str())
                .chain(td.indexes_changed.iter().map(|c| c.name.as_str()))
                .collect();
            let dst_idx: Vec<IndexInfo> = self.dst.table(name).map(|t| t.indexes.clone()).unwrap_or_default();
            let mut recreated: Vec<String> = Vec::new();
            for c in td
                .columns_changed
                .iter()
                .filter(|c| c.attrs.iter().any(|a| matches!(a, ColumnAttr::DataType | ColumnAttr::Nullable)))
            {
                for ix in dst_idx.iter().filter(|i| {
                    !handled.contains(&i.name.as_str()) && i.columns.iter().any(|x| x.eq_ignore_ascii_case(&c.name))
                }) {
                    if ix.primary || ix.unique {
                        // 唯一索引多半由 PRIMARY KEY / UNIQUE 約束建立，DROP INDEX 卸不掉（要 DROP
                        // CONSTRAINT 並重建），跨版本寫法差異大 → 交回使用者，但不可靜默漏掉。
                        self.skip(tf!(
                            "{table}.{col}：欄位被主鍵 / 唯一索引 {ix} 參照，SQL Server 無法直接 ALTER COLUMN，請手動處理",
                            table = name,
                            col = c.name,
                            ix = ix.name
                        ));
                        blocked.push(c.name.clone());
                    } else if !recreated.contains(&ix.name) {
                        self.drop_index(name, ix);
                        self.create_index(name, ix);
                        recreated.push(ix.name.clone());
                    }
                }
            }
        }
        for c in &td.columns_added {
            self.add_column(name, c);
        }
        for c in &td.columns_changed {
            if blocked.contains(&c.name) {
                continue; // 已記進 skipped，不可再送出一句必定失敗的 ALTER COLUMN。
            }
            self.alter_column(name, &c.src, &c.dst, &c.attrs);
        }
        for c in &td.columns_removed {
            self.drop_column(name, c);
        }
        if self.opts.include_indexes {
            for i in &td.indexes_added {
                if i.primary {
                    self.skip(tf!("{table}：主鍵變更請手動處理", table = name));
                } else {
                    self.create_index(name, i);
                }
            }
            for c in &td.indexes_changed {
                if !(c.src.primary || c.dst.primary) {
                    self.create_index(name, &c.src);
                }
            }
        }
        if self.opts.include_fks {
            for f in &td.fks_added {
                self.add_fk(name, f);
            }
            for c in &td.fks_changed {
                self.add_fk(name, &c.src);
            }
        }
    }

    // ---- columns ----

    fn add_column(&mut self, table: &str, c: &ColumnInfo) {
        let q = self.q(table);
        let obj = format!("{table}.{}", c.name);
        let sql = match self.kind {
            DbKind::Oracle => format!("ALTER TABLE {q} ADD ({})", self.column_spec(c)),
            DbKind::Mssql => format!("ALTER TABLE {q} ADD {}", self.column_spec(c)),
            DbKind::Sqlite => {
                // SQLite：NOT NULL 新欄必須有 DEFAULT，否則既有列無法填值。
                if !c.nullable && self.default_sql(c).is_none() {
                    let mut relaxed = c.clone();
                    relaxed.nullable = true;
                    let s = format!("ALTER TABLE {q} ADD COLUMN {}", self.column_spec(&relaxed));
                    self.columns.push(with_note(
                        st(SyncKind::AddColumn, obj, s, false),
                        t!("SQLite 無 DEFAULT 的 NOT NULL 欄無法新增，已改為允許 NULL"),
                    ));
                    return;
                }
                format!("ALTER TABLE {q} ADD COLUMN {}", self.column_spec(c))
            }
            _ => format!("ALTER TABLE {q} ADD COLUMN {}", self.column_spec(c)),
        };
        let mut s = st(SyncKind::AddColumn, obj, sql, false);
        if self.kind == DbKind::Postgres && !c.comment.is_empty() {
            self.columns.push(s);
            s = self.comment_stmt(table, c);
        } else if self.kind == DbKind::Oracle && !c.comment.is_empty() {
            self.columns.push(s);
            s = self.comment_stmt(table, c);
        }
        self.columns.push(s);
    }

    fn comment_stmt(&self, table: &str, c: &ColumnInfo) -> SyncStatement {
        let sql = format!(
            "COMMENT ON COLUMN {}.{} IS {}",
            self.q(table),
            self.qi(&c.name),
            sql_literal(self.kind, Some(&c.comment))
        );
        st(SyncKind::Comment, format!("{table}.{}", c.name), sql, false)
    }

    fn alter_column(&mut self, table: &str, src: &ColumnInfo, dst: &ColumnInfo, attrs: &[ColumnAttr]) {
        let q = self.q(table);
        let obj = format!("{table}.{}", src.name);
        let type_changed = attrs.contains(&ColumnAttr::DataType);
        let to_not_null = attrs.contains(&ColumnAttr::Nullable) && !src.nullable;
        let destructive = type_changed || to_not_null;
        match self.kind {
            DbKind::Mysql | DbKind::Mariadb => {
                // MODIFY 會重設未給的屬性 → 一律帶完整規格（含 default / comment）。
                let sql = format!("ALTER TABLE {q} MODIFY COLUMN {}", self.column_spec(src));
                self.columns.push(st(SyncKind::AlterColumn, obj, sql, destructive));
            }
            DbKind::Postgres => {
                let qc = self.qi(&src.name);
                for a in attrs {
                    match a {
                        ColumnAttr::DataType => {
                            let sql = format!("ALTER TABLE {q} ALTER COLUMN {qc} TYPE {ty} USING {qc}::{ty}", ty = src.data_type);
                            self.columns.push(st(SyncKind::AlterColumn, obj.clone(), sql, true));
                        }
                        ColumnAttr::Nullable => {
                            let verb = if src.nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                            let sql = format!("ALTER TABLE {q} ALTER COLUMN {qc} {verb}");
                            self.columns.push(st(SyncKind::AlterColumn, obj.clone(), sql, !src.nullable));
                        }
                        ColumnAttr::Default => {
                            let sql = match self.default_sql(src) {
                                Some(d) => format!("ALTER TABLE {q} ALTER COLUMN {qc} SET DEFAULT {d}"),
                                None => format!("ALTER TABLE {q} ALTER COLUMN {qc} DROP DEFAULT"),
                            };
                            self.columns.push(st(SyncKind::AlterColumn, obj.clone(), sql, false));
                        }
                        ColumnAttr::Comment => {
                            let s = self.comment_stmt(table, src);
                            self.columns.push(s);
                        }
                        ColumnAttr::Extra => self.skip(tf!(
                            "{obj}：identity / generated 屬性變更（{src} → {dst}）請手動處理",
                            obj = obj,
                            src = src.extra,
                            dst = dst.extra
                        )),
                    }
                }
            }
            DbKind::Sqlite => {
                self.skip(tf!("{obj}：SQLite 無法修改欄位型別 / NULL / 預設值（需重建資料表）", obj = obj));
            }
            DbKind::Mssql => {
                if type_changed || attrs.contains(&ColumnAttr::Nullable) {
                    let nn = if src.nullable { "NULL" } else { "NOT NULL" };
                    let sql = format!("ALTER TABLE {q} ALTER COLUMN {} {} {nn}", self.qi(&src.name), src.data_type);
                    self.columns.push(st(SyncKind::AlterColumn, obj.clone(), sql, destructive));
                }
                if attrs.contains(&ColumnAttr::Default) {
                    self.skip(tf!("{obj}：SQL Server 預設值為具名約束，請手動處理", obj = obj));
                }
                if attrs.contains(&ColumnAttr::Extra) {
                    self.skip(tf!("{obj}：identity 屬性變更請手動處理", obj = obj));
                }
            }
            DbKind::Oracle => {
                let mut parts = vec![self.qi(&src.name)];
                if type_changed {
                    parts.push(src.data_type.clone());
                }
                if attrs.contains(&ColumnAttr::Default) {
                    parts.push(format!("DEFAULT {}", self.default_sql(src).unwrap_or_else(|| "NULL".into())));
                }
                // Oracle 對「已經是該狀態」的 NULL / NOT NULL 會報錯，只在真的變了才給。
                if attrs.contains(&ColumnAttr::Nullable) {
                    parts.push(if src.nullable { "NULL".into() } else { "NOT NULL".into() });
                }
                if parts.len() > 1 {
                    let sql = format!("ALTER TABLE {q} MODIFY ({})", parts.join(" "));
                    self.columns.push(st(SyncKind::AlterColumn, obj.clone(), sql, destructive));
                }
                if attrs.contains(&ColumnAttr::Comment) {
                    let s = self.comment_stmt(table, src);
                    self.columns.push(s);
                }
            }
            _ => self.skip(tf!("{obj}：此引擎不支援欄位變更", obj = obj)),
        }
    }

    fn drop_column(&mut self, table: &str, c: &ColumnInfo) {
        let obj = format!("{table}.{}", c.name);
        if !self.opts.include_drops {
            self.skip(tf!("{obj}：目標多出的欄位（未含 DROP）", obj = obj));
            return;
        }
        let sql = format!("ALTER TABLE {} DROP COLUMN {}", self.q(table), self.qi(&c.name));
        let mut s = st(SyncKind::DropColumn, obj, sql, true);
        if self.kind == DbKind::Sqlite {
            s = with_note(s, t!("需 SQLite 3.35+"));
        }
        self.columns.push(s);
    }

    // ---- indexes ----

    fn index_name(&self, name: &str) -> String {
        // PG / Oracle 的索引屬 schema，DROP 要限定；其餘掛在表上。
        match self.kind {
            DbKind::Postgres | DbKind::Oracle => {
                if self.db.is_empty() { self.qi(name) } else { format!("{}.{}", self.qi(self.db), self.qi(name)) }
            }
            _ => self.qi(name),
        }
    }

    fn create_index(&mut self, table: &str, ix: &IndexInfo) {
        let cols = ix.columns.iter().map(|c| self.qi(c)).collect::<Vec<_>>().join(", ");
        let uniq = if ix.unique { "UNIQUE " } else { "" };
        // CREATE INDEX 的索引名**不可**限定 schema：PG / Oracle 的索引一定建在表所屬的 schema，
        // 文法只收不限定的識別字（`CREATE INDEX s.ix ON s.t (c)` 會直接 syntax error）。
        // 只有 DROP INDEX 需要限定（見 index_name）——兩者共用同一個 helper 曾讓 PG 結構同步必定失敗。
        let sql = format!("CREATE {uniq}INDEX {} ON {} ({cols})", self.qi(&ix.name), self.q(table));
        self.create_indexes.push(st(SyncKind::CreateIndex, format!("{table}.{}", ix.name), sql, false));
    }

    fn drop_index(&mut self, table: &str, ix: &IndexInfo) {
        let sql = match self.kind {
            DbKind::Mysql | DbKind::Mariadb | DbKind::Mssql => {
                format!("DROP INDEX {} ON {}", self.qi(&ix.name), self.q(table))
            }
            _ => format!("DROP INDEX {}", self.index_name(&ix.name)),
        };
        let mut s = st(SyncKind::DropIndex, format!("{table}.{}", ix.name), sql, ix.unique);
        if ix.unique && matches!(self.kind, DbKind::Postgres | DbKind::Mssql | DbKind::Oracle) {
            s = with_note(s, t!("若此唯一索引由 UNIQUE 約束建立，請改用 DROP CONSTRAINT"));
        }
        self.drop_indexes.push(s);
    }

    // ---- foreign keys ----

    fn add_fk(&mut self, table: &str, fk: &ForeignKey) {
        if self.kind == DbKind::Sqlite {
            self.skip(tf!("{table}.{fk}：SQLite 無法新增外鍵（需重建資料表）", table = table, fk = fk.name));
            return;
        }
        let cols = fk.columns.iter().map(|c| self.qi(c)).collect::<Vec<_>>().join(", ");
        let rcols = fk.ref_columns.iter().map(|c| self.qi(c)).collect::<Vec<_>>().join(", ");
        let sql = format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({cols}) REFERENCES {} ({rcols})",
            self.q(table),
            self.qi(&fk.name),
            self.q(&fk.ref_table)
        );
        self.add_fks.push(st(SyncKind::AddForeignKey, format!("{table}.{}", fk.name), sql, false));
    }

    fn drop_fk(&mut self, table: &str, fk: &ForeignKey) {
        if self.kind == DbKind::Sqlite {
            self.skip(tf!("{table}.{fk}：SQLite 無法刪除外鍵（需重建資料表）", table = table, fk = fk.name));
            return;
        }
        let verb = if matches!(self.kind, DbKind::Mysql | DbKind::Mariadb) { "DROP FOREIGN KEY" } else { "DROP CONSTRAINT" };
        let sql = format!("ALTER TABLE {} {verb} {}", self.q(table), self.qi(&fk.name));
        self.drop_fks.push(st(SyncKind::DropForeignKey, format!("{table}.{}", fk.name), sql, false));
    }

    // ---- views ----

    fn drop_view(&mut self, name: &str) {
        if !self.opts.include_drops && self.src.view(name).is_none() {
            self.skip(tf!("視圖 {name}：目標多出（未含 DROP）", name = name));
            return;
        }
        let ine = if self.kind == DbKind::Sqlite { "IF EXISTS " } else { "" };
        let sql = if self.kind == DbKind::Mssql {
            // DROP VIEW 不收三部式名稱，改走目標庫的 sp_executesql（見 mssql_batch）。
            mssql_batch(self.db, &format!("DROP VIEW {}", qualified(self.kind, "", name)))
        } else {
            format!("DROP VIEW {ine}{}", self.q(name))
        };
        // 「改」視圖走 DROP + CREATE：這裡的 DROP 只有在來源沒有這個視圖時才算真的刪除。
        let destructive = self.src.view(name).is_none();
        self.views.push(st(SyncKind::DropView, name, sql, destructive));
    }

    fn create_view(&mut self, v: &TableSchema) {
        let Some(ddl) = &v.ddl else {
            self.skip(tf!("視圖 {name}：來源無定義", name = v.name));
            return;
        };
        // MSSQL：CREATE VIEW 既不收庫名前綴、又必須是批次第一句，名稱只能限定到 schema，
        // 再由 sp_executesql 指定目標庫（見 mssql_batch）。
        let sql = if self.kind == DbKind::Mssql {
            mssql_batch(self.db, &rewrite_view_ddl(ddl, self.kind, "", &v.name))
        } else {
            rewrite_view_ddl(ddl, self.kind, self.db, &v.name)
        };
        let mut s = st(SyncKind::CreateView, v.name.clone(), sql, false);
        if self.kind == DbKind::Postgres && self.src.database != self.dst.database {
            // pg_get_viewdef 會把本體參照的表限定到**來源** schema，而 rewrite_view_ddl 只改視圖自己的名字。
            // 直接套用會在目標 schema 建出一個「讀來源 schema 資料」的視圖——語句成功、diff 也看不出來。
            s = with_note(s, tf!(
                "視圖本體中的表名仍限定在來源 schema（{src}），套用前請改成 {dst}",
                src = self.src.database,
                dst = self.dst.database
            ));
        } else if matches!(self.kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Mssql) {
            s = with_note(s, t!("視圖本體引用的表未限定資料庫，請在目標資料庫的連線環境下執行"));
        }
        self.views.push(s);
    }

    // ---- routines ----

    fn drop_routine(&mut self, tc: &TextChange, dst: &DbSchema) {
        let rtype = tc.routine_type.clone().unwrap_or_default();
        let is_change = tc.src.is_some();
        if !self.opts.include_drops && !is_change {
            self.skip(tf!("{rtype} {name}：目標多出（未含 DROP）", rtype = rtype, name = tc.name));
            return;
        }
        let info = dst.routines.iter().find(|r| r.info.name == tc.name && r.info.routine_type == rtype).map(|r| &r.info);
        let upper = rtype.to_ascii_uppercase();
        let sql = match self.kind {
            DbKind::Postgres => {
                if rtype == "trigger" {
                    let parent = info.and_then(|i| i.parent.clone()).unwrap_or_default();
                    format!("DROP TRIGGER {} ON {}", self.qi(&tc.name), self.q(&parent))
                } else {
                    let sig = info.and_then(|i| i.signature.clone()).unwrap_or_default();
                    format!("DROP {upper} {}({sig})", self.q(&tc.name))
                }
            }
            DbKind::Sqlite => format!("DROP {upper} {}", self.qi(&tc.name)),
            // DROP PROCEDURE / FUNCTION / TRIGGER 同樣拒收庫名前綴（見 mssql_batch）。
            DbKind::Mssql => {
                mssql_batch(self.db, &format!("DROP {upper} {}", qualified(self.kind, "", &tc.name)))
            }
            _ => format!("DROP {upper} {}", self.q(&tc.name)),
        };
        self.routines.push(st(SyncKind::DropRoutine, tc.name.clone(), sql, !is_change));
    }

    fn create_routine(&mut self, tc: &TextChange) {
        let Some(def) = &tc.src else {
            self.skip(tf!("{name}：來源無定義", name = tc.name));
            return;
        };
        // PG 的 pg_get_functiondef / pg_get_triggerdef 一律輸出 schema 限定名。跨 schema 同步時
        // 直接套用等於「改到來源」（觸發器還會因同名同表已存在而失敗）——這正是本檔案開頭說的
        // 「引擎表達不出來的變更要進 skipped，不可靜默」的情形，不該放進可執行語句。
        if self.kind == DbKind::Postgres
            && self.src.database != self.dst.database
            && def.contains(&format!("{}.", self.src.database))
        {
            self.skip(tf!(
                "{name}：定義限定在來源 schema（{src}），請手動改成 {dst} 後執行",
                name = tc.name,
                src = self.src.database,
                dst = self.dst.database
            ));
            return;
        }
        let mut sql = def.clone();
        if matches!(self.kind, DbKind::Mysql | DbKind::Mariadb) {
            sql = strip_definer(&sql);
        }
        // MSSQL：CREATE PROCEDURE / FUNCTION / TRIGGER 必須是批次的第一句，而定義文字本身
        // 無從限定資料庫；包進目標庫的 sp_executesql 一次解決兩件事（見 mssql_batch）。
        if self.kind == DbKind::Mssql {
            sql = mssql_batch(self.db, &sql);
        }
        let mut s = st(SyncKind::CreateRoutine, tc.name.clone(), sql, false);
        if self.src.database != self.dst.database {
            s = with_note(s, tf!("定義沿用來源（{src}），若內含 schema 限定名請改為 {dst}", src = self.src.database, dst = self.dst.database));
        } else if matches!(self.kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Mssql) {
            s = with_note(s, t!("請在目標資料庫的連線環境下執行"));
        }
        self.routines.push(s);
    }
}

/// 去掉 MySQL `DEFINER=`user`@`host` `。
fn strip_definer(sql: &str) -> String {
    let mut t = sql.to_string();
    while let Some(start) = t.find("DEFINER=") {
        match t[start..].find(char::is_whitespace) {
            Some(rel) => t.replace_range(start..start + rel + 1, ""),
            None => break,
        }
    }
    t
}

/// 把視圖 DDL 改成「可在目標重複執行、名稱限定到目標庫」的形式。
/// 定位 `VIEW` 關鍵字與其後的 ` AS`，中間的舊名（含引號 / 欄位清單）整段換掉；
/// 找不到就原樣回傳（寧可讓使用者看到原文，不要產生半殘語句）。
pub fn rewrite_view_ddl(ddl: &str, kind: DbKind, dst_db: &str, name: &str) -> String {
    let mut t = ddl.trim().to_string();
    if matches!(kind, DbKind::Mysql | DbKind::Mariadb) {
        t = strip_definer(&t);
        t = t.replace("ALGORITHM=UNDEFINED ", "").replace("SQL SECURITY DEFINER ", "").replace("SQL SECURITY INVOKER ", "");
    }
    let lower = t.to_ascii_lowercase();
    let Some(vpos) = lower.find("view") else { return t };
    let after = vpos + 4;
    let Some(as_rel) = lower[after..].find(" as") else { return t };
    let as_pos = after + as_rel;
    // `VIEW` 之前是 CREATE [OR REPLACE] [FORCE] [EDITIONABLE] … 之類的前綴，一律換成統一寫法。
    let tail = &t[as_pos..];
    let create = match kind {
        DbKind::Mssql => "CREATE OR ALTER ",
        DbKind::Sqlite => "CREATE ",
        _ => "CREATE OR REPLACE ",
    };
    let q = qualified(kind, dst_db, name);
    let body = format!("{create}VIEW {q}{tail}");
    if kind == DbKind::Sqlite {
        format!("DROP VIEW IF EXISTS {q};\n{body}")
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::super::diff::tests::{col, db, idx, table};
    use super::super::diff::{diff, DiffOptions};
    use super::*;

    fn opts_all() -> SyncOptions {
        SyncOptions { include_drops: true, include_routines: true, ..Default::default() }
    }

    fn gen(kind: DbKind, src: Vec<TableSchema>, dst: Vec<TableSchema>, opts: &SyncOptions) -> SyncScript {
        let mut s = db(kind, src);
        s.database = "src".into();
        let mut d = db(kind, dst);
        d.database = "tgt".into();
        let df = diff(&s, &d, &DiffOptions::default());
        generate(&df, &s, &d, opts).unwrap()
    }

    fn sqls(s: &SyncScript) -> Vec<&str> {
        s.statements.iter().map(|x| x.sql.as_str()).collect()
    }

    #[test]
    fn mysql_add_modify_drop_column_full_spec() {
        let mut c = col("name", "varchar(50)", false);
        c.default = Some("abc".into());
        c.comment = "姓名".into();
        let mut ai = col("id", "int", false);
        ai.extra = "auto_increment".into();
        let src = vec![table("t", vec![ai.clone(), c.clone(), col("new", "int", true)], vec![])];
        let dst = vec![table("t", vec![ai, col("name", "varchar(20)", true), col("old", "int", true)], vec![])];
        let s = gen(DbKind::Mysql, src, dst, &opts_all());
        let v = sqls(&s);
        assert_eq!(v[0], "ALTER TABLE `tgt`.`t` ADD COLUMN `new` int NULL");
        assert_eq!(v[1], "ALTER TABLE `tgt`.`t` MODIFY COLUMN `name` varchar(50) NOT NULL DEFAULT 'abc' COMMENT '姓名'");
        assert_eq!(v[2], "ALTER TABLE `tgt`.`t` DROP COLUMN `old`");
        assert!(!s.statements[0].destructive);
        assert!(s.statements[1].destructive); // 改型別
        assert!(s.statements[2].destructive);
        assert_eq!(s.destructive_count, 2);
    }

    #[test]
    fn include_drops_false_moves_drops_to_skipped() {
        let src = vec![table("t", vec![col("id", "int", false)], vec![])];
        let dst = vec![table("t", vec![col("id", "int", false), col("old", "int", true)], vec![]), table("gone", vec![], vec![])];
        let s = gen(DbKind::Mysql, src, dst, &SyncOptions::default());
        assert!(s.statements.is_empty());
        assert_eq!(s.skipped.len(), 2);
    }

    #[test]
    fn global_ordering_fk_index_column_phases() {
        let f = |n: &str, c: &str| crate::db::ForeignKeyInfo { name: n.into(), column: c.into(), ref_table: "p".into(), ref_column: "id".into() };
        let mut s_t = table("t", vec![col("a", "int", true), col("b", "int", true)], vec![idx("ix_b", &["b"], false, false)]);
        s_t.foreign_keys = vec![f("fk_b", "b")];
        let mut d_t = table("t", vec![col("a", "int", true), col("c", "int", true)], vec![idx("ix_c", &["c"], true, false)]);
        d_t.foreign_keys = vec![f("fk_c", "c")];
        let s = gen(DbKind::Postgres, vec![s_t, table("p", vec![], vec![])], vec![d_t, table("p", vec![], vec![]), table("dead", vec![], vec![])], &opts_all());
        let kinds: Vec<SyncKind> = s.statements.iter().map(|x| x.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SyncKind::DropForeignKey,
                SyncKind::DropIndex,
                SyncKind::AddColumn,
                SyncKind::DropColumn,
                SyncKind::CreateIndex,
                SyncKind::AddForeignKey,
                SyncKind::DropTable
            ]
        );
        let v = sqls(&s);
        assert_eq!(v[0], "ALTER TABLE \"tgt\".\"t\" DROP CONSTRAINT \"fk_c\"");
        assert_eq!(v[1], "DROP INDEX \"tgt\".\"ix_c\"");
        // CREATE INDEX 的索引名不限定 schema（PG 文法不收）；DROP INDEX 才限定，見 v[1]。
        assert_eq!(v[4], "CREATE INDEX \"ix_b\" ON \"tgt\".\"t\" (\"b\")");
        assert_eq!(v[5], "ALTER TABLE \"tgt\".\"t\" ADD CONSTRAINT \"fk_b\" FOREIGN KEY (\"b\") REFERENCES \"tgt\".\"p\" (\"id\")");
        assert_eq!(v[6], "DROP TABLE \"tgt\".\"dead\"");
        // unique 索引卸除視為破壞性。
        assert!(s.statements[1].destructive);
    }

    #[test]
    fn postgres_alter_column_per_attribute() {
        let mut sc = col("n", "bigint", false);
        sc.default = Some("0".into());
        sc.comment = "num".into();
        let s = gen(DbKind::Postgres, vec![table("t", vec![sc], vec![])], vec![table("t", vec![col("n", "integer", true)], vec![])], &opts_all());
        let v = sqls(&s);
        assert_eq!(v[0], "ALTER TABLE \"tgt\".\"t\" ALTER COLUMN \"n\" TYPE bigint USING \"n\"::bigint");
        assert_eq!(v[1], "ALTER TABLE \"tgt\".\"t\" ALTER COLUMN \"n\" SET NOT NULL");
        assert_eq!(v[2], "ALTER TABLE \"tgt\".\"t\" ALTER COLUMN \"n\" SET DEFAULT 0");
        assert_eq!(v[3], "COMMENT ON COLUMN \"tgt\".\"t\".\"n\" IS 'num'");
        assert!(s.statements[0].destructive && s.statements[1].destructive);
        assert!(!s.statements[2].destructive && !s.statements[3].destructive);
    }

    #[test]
    fn sqlite_type_change_and_fk_are_skipped() {
        let f = |n: &str| crate::db::ForeignKeyInfo { name: n.into(), column: "a".into(), ref_table: "p".into(), ref_column: "id".into() };
        let mut st_ = table("t", vec![col("a", "TEXT", true)], vec![]);
        st_.foreign_keys = vec![f("fk")];
        let s = gen(DbKind::Sqlite, vec![st_], vec![table("t", vec![col("a", "INTEGER", true)], vec![])], &opts_all());
        assert!(s.statements.is_empty());
        assert_eq!(s.skipped.len(), 2);
    }

    #[test]
    fn mssql_three_part_names_and_default_skipped() {
        let mut sc = col("x", "int", false);
        sc.default = Some("((1))".into());
        let s = gen(DbKind::Mssql, vec![table("sales.orders", vec![sc, col("y", "int", true)], vec![])], vec![table("sales.orders", vec![col("x", "int", true)], vec![])], &opts_all());
        let v = sqls(&s);
        assert_eq!(v[0], "ALTER TABLE [tgt].[sales].[orders] ADD [y] int NULL");
        assert_eq!(v[1], "ALTER TABLE [tgt].[sales].[orders] ALTER COLUMN [x] int NOT NULL");
        assert_eq!(s.skipped.len(), 1); // default 變更
    }

    /// T-SQL 的 CREATE / DROP VIEW、PROCEDURE、TRIGGER 一律拒收庫名前綴，CREATE 又必須是批次第一句：
    /// 包成目標庫的 sp_executesql 是唯一「跨連線也指得到正確資料庫」的合法寫法。
    #[test]
    fn mssql_views_and_routines_wrapped_in_target_db_batch() {
        use super::super::schema::RoutineSchema;
        use crate::db::RoutineInfo;
        let view = |body: &str| TableSchema {
            name: "sales.v".into(),
            kind: "view".into(),
            ddl: Some(format!("CREATE VIEW sales.v AS {body}")),
            ..Default::default()
        };
        let mut s = db(DbKind::Mssql, vec![]);
        s.database = "src".into();
        s.views = vec![view("SELECT 1 AS x")];
        s.routines = vec![RoutineSchema {
            info: RoutineInfo {
                name: "sales.p".into(),
                routine_type: "procedure".into(),
                parent: None,
                signature: None,
                modified: None,
                deterministic: None,
                comment: None,
            },
            definition: Some("CREATE PROCEDURE sales.p AS BEGIN SELECT N'it''s' AS q; END".into()),
        }];
        let mut d = db(DbKind::Mssql, vec![]);
        d.database = "tgt".into();
        d.views = vec![view("SELECT 2 AS x")];
        let df = diff(&s, &d, &DiffOptions::default());
        let sc = generate(&df, &s, &d, &opts_all()).unwrap();
        let v = sqls(&sc);
        assert_eq!(v[0], "EXEC [tgt].sys.sp_executesql N'DROP VIEW [sales].[v]'");
        assert_eq!(v[1], "EXEC [tgt].sys.sp_executesql N'CREATE OR ALTER VIEW [sales].[v] AS SELECT 1 AS x'");
        // 定義裡的單引號要加倍，否則包起來的字串會提前結束。
        assert_eq!(
            v[2],
            "EXEC [tgt].sys.sp_executesql N'CREATE PROCEDURE sales.p AS BEGIN SELECT N''it''''s'' AS q; END'"
        );
    }

    /// SQL Server 不准 ALTER COLUMN 動被索引參照的欄位：一般索引自動卸了再重建，
    /// 主鍵 / 唯一索引卸不掉 → 記 skipped 且**不可**再送出那句必定失敗的 ALTER COLUMN。
    #[test]
    fn mssql_alter_column_handles_dependent_indexes() {
        let srct = |ty: &str| table("t", vec![col("a", ty, false)], vec![idx("ix_a", &["a"], false, false)]);
        let s = gen(DbKind::Mssql, vec![srct("bigint")], vec![srct("int")], &opts_all());
        let kinds: Vec<SyncKind> = s.statements.iter().map(|x| x.kind).collect();
        assert_eq!(kinds, vec![SyncKind::DropIndex, SyncKind::AlterColumn, SyncKind::CreateIndex]);
        assert_eq!(sqls(&s)[0], "DROP INDEX [ix_a] ON [tgt].[dbo].[t]");
        assert_eq!(sqls(&s)[2], "CREATE INDEX [ix_a] ON [tgt].[dbo].[t] ([a])");
        assert!(s.skipped.is_empty());

        let uniq = |ty: &str| table("t", vec![col("a", ty, false)], vec![idx("ux_a", &["a"], true, false)]);
        let s = gen(DbKind::Mssql, vec![uniq("bigint")], vec![uniq("int")], &opts_all());
        assert!(s.statements.is_empty(), "{:?}", sqls(&s));
        assert_eq!(s.skipped.len(), 1);
        assert!(s.skipped[0].contains("ux_a"), "{:?}", s.skipped);
    }

    #[test]
    fn oracle_modify_only_emits_changed_parts() {
        // 只改型別：不能帶 NOT NULL（已是該狀態會 ORA-01442）。
        let s = gen(DbKind::Oracle, vec![table("T", vec![col("C", "VARCHAR2(100)", false)], vec![])], vec![table("T", vec![col("C", "VARCHAR2(50)", false)], vec![])], &opts_all());
        assert_eq!(sqls(&s)[0], "ALTER TABLE \"tgt\".\"T\" MODIFY (\"C\" VARCHAR2(100))");
        // 只改 NULL → 只給 NULL。
        let s = gen(DbKind::Oracle, vec![table("T", vec![col("C", "NUMBER", true)], vec![])], vec![table("T", vec![col("C", "NUMBER", false)], vec![])], &opts_all());
        assert_eq!(sqls(&s)[0], "ALTER TABLE \"tgt\".\"T\" MODIFY (\"C\" NULL)");
        assert!(!s.statements[0].destructive);
    }

    #[test]
    fn create_table_rewrites_name_and_strips_auto_increment() {
        let mut t = table("n", vec![col("id", "int", false)], vec![]);
        t.ddl = Some("CREATE TABLE `n` (\n  `id` int NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB AUTO_INCREMENT=77 DEFAULT CHARSET=utf8mb4;".into());
        let s = gen(DbKind::Mysql, vec![t], vec![], &opts_all());
        assert_eq!(s.statements[0].kind, SyncKind::CreateTable);
        assert_eq!(s.statements[0].sql, "CREATE TABLE `tgt`.`n` (\n  `id` int NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
        assert!(!s.statements[0].destructive);
    }

    #[test]
    fn synthesized_create_table_appends_indexes_and_fks() {
        let mut t = table("n", vec![col("id", "integer", false), col("p", "integer", true)], vec![idx("n_pkey", &["id"], true, true), idx("ix_p", &["p"], false, false)]);
        t.ddl = Some("CREATE TABLE \"src\".\"n\" (\n    \"id\" integer NOT NULL,\n    PRIMARY KEY (\"id\")\n);".into());
        t.ddl_synthesized = true;
        t.foreign_keys = vec![crate::db::ForeignKeyInfo { name: "fk_p".into(), column: "p".into(), ref_table: "parent".into(), ref_column: "id".into() }];
        let s = gen(DbKind::Postgres, vec![t], vec![], &opts_all());
        let kinds: Vec<SyncKind> = s.statements.iter().map(|x| x.kind).collect();
        assert_eq!(kinds, vec![SyncKind::CreateTable, SyncKind::CreateIndex, SyncKind::AddForeignKey]);
        assert!(s.statements[0].sql.starts_with("CREATE TABLE \"tgt\".\"n\" ("));
    }

    #[test]
    fn drop_table_first_drops_its_fks_and_is_last() {
        let mut dead = table("dead", vec![], vec![]);
        dead.foreign_keys = vec![crate::db::ForeignKeyInfo { name: "fk_x".into(), column: "x".into(), ref_table: "p".into(), ref_column: "id".into() }];
        let s = gen(DbKind::Mysql, vec![table("t", vec![col("a", "int", true)], vec![])], vec![table("t", vec![], vec![]), dead], &opts_all());
        let kinds: Vec<SyncKind> = s.statements.iter().map(|x| x.kind).collect();
        assert_eq!(kinds, vec![SyncKind::DropForeignKey, SyncKind::AddColumn, SyncKind::DropTable]);
        assert_eq!(s.statements[0].sql, "ALTER TABLE `tgt`.`dead` DROP FOREIGN KEY `fk_x`");
    }

    #[test]
    fn views_and_routines() {
        let mut s = db(DbKind::Mysql, vec![]);
        s.database = "src".into();
        s.views = vec![TableSchema {
            name: "v".into(),
            kind: "view".into(),
            ddl: Some("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `x`".into()),
            ..Default::default()
        }];
        let mut d = db(DbKind::Mysql, vec![]);
        d.database = "tgt".into();
        d.views = vec![TableSchema { name: "v".into(), kind: "view".into(), ddl: Some("CREATE VIEW `v` AS select 2".into()), ..Default::default() }, TableSchema { name: "gone".into(), kind: "view".into(), ..Default::default() }];
        let df = diff(&s, &d, &DiffOptions::default());
        let sc = generate(&df, &s, &d, &opts_all()).unwrap();
        let v = sqls(&sc);
        assert_eq!(v[0], "DROP VIEW `tgt`.`gone`");
        assert!(sc.statements[0].destructive);
        assert_eq!(v[1], "DROP VIEW `tgt`.`v`");
        assert!(!sc.statements[1].destructive); // 屬「改」的一部分
        assert_eq!(v[2], "CREATE OR REPLACE VIEW `tgt`.`v` AS select 1 AS `x`");
    }

    #[test]
    fn rewrite_view_ddl_per_engine() {
        assert_eq!(
            rewrite_view_ddl("CREATE OR REPLACE VIEW \"src\".\"v\" AS\nSELECT 1", DbKind::Postgres, "tgt", "v"),
            "CREATE OR REPLACE VIEW \"tgt\".\"v\" AS\nSELECT 1"
        );
        assert_eq!(
            rewrite_view_ddl("CREATE VIEW [dbo].[v] AS SELECT 1", DbKind::Mssql, "tgt", "v"),
            "CREATE OR ALTER VIEW [tgt].[dbo].[v] AS SELECT 1"
        );
        assert_eq!(
            rewrite_view_ddl("CREATE VIEW v AS SELECT 1", DbKind::Sqlite, "main", "v"),
            "DROP VIEW IF EXISTS `v`;\nCREATE VIEW `v` AS SELECT 1"
        );
        assert_eq!(
            rewrite_view_ddl("CREATE OR REPLACE FORCE EDITIONABLE VIEW \"S\".\"V\" (\"A\") AS SELECT 1 FROM DUAL", DbKind::Oracle, "T", "V"),
            "CREATE OR REPLACE VIEW \"T\".\"V\" AS SELECT 1 FROM DUAL"
        );
    }

    /// MySQL 的 ON UPDATE 只存在於 EXTRA：MODIFY COLUMN 不帶它就會靜默拿掉目標的自動更新。
    #[test]
    fn mysql_modify_column_preserves_on_update() {
        let mut src = col("ts", "datetime", false);
        src.default = Some("CURRENT_TIMESTAMP".into());
        src.extra = "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)".into();
        let mut dst = src.clone();
        dst.data_type = "timestamp".into(); // 造一個「其他屬性有差」的理由，逼出 MODIFY
        let s = gen(DbKind::Mysql, vec![table("t", vec![src], vec![])], vec![table("t", vec![dst], vec![])], &opts_all());
        assert_eq!(
            sqls(&s)[0],
            "ALTER TABLE `tgt`.`t` MODIFY COLUMN `ts` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP(3)"
        );
        // 8.0.23+ 會在 EXTRA 尾端接 INVISIBLE，只能取 on update 後的那一個 token。
        assert_eq!(on_update_clause("DEFAULT_GENERATED on update CURRENT_TIMESTAMP INVISIBLE").as_deref(), Some("ON UPDATE CURRENT_TIMESTAMP"));
        assert_eq!(on_update_clause("auto_increment"), None);
    }

    /// 只有原始 DDL 不同（字元集 / ENGINE / ON UPDATE…）時產不出語句，但必須留一筆 skipped，
    /// 否則使用者會看到「同步完成」卻永遠不收斂。
    #[test]
    fn ddl_only_difference_is_reported_as_skipped() {
        let mut a = table("t", vec![col("id", "int", false)], vec![]);
        a.ddl = Some("CREATE TABLE `t` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4".into());
        let mut b = a.clone();
        b.ddl = Some("CREATE TABLE `t` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=latin1".into());
        let s = gen(DbKind::Mysql, vec![a], vec![b], &opts_all());
        assert!(s.statements.is_empty());
        assert_eq!(s.skipped.len(), 1);
        assert!(s.skipped[0].contains("t"), "{:?}", s.skipped);
    }

    #[test]
    fn cross_engine_refused() {
        let s = db(DbKind::Mysql, vec![]);
        let d = db(DbKind::Postgres, vec![]);
        let df = diff(&s, &d, &DiffOptions::default());
        assert!(generate(&df, &s, &d, &SyncOptions::default()).is_err());
    }

    #[test]
    fn script_text_marks_destructive_and_skipped() {
        let sc = SyncScript {
            target_kind: DbKind::Mysql,
            target_db: "d".into(),
            statements: vec![st(SyncKind::DropTable, "x", "DROP TABLE `x`".into(), true), st(SyncKind::AddColumn, "y", "ALTER TABLE `y` ADD COLUMN `a` int;".into(), false)],
            destructive_count: 1,
            skipped: vec!["foo".into()],
        };
        let t = script_text(&sc);
        assert_eq!(t, "-- [destructive]\nDROP TABLE `x`;\n\nALTER TABLE `y` ADD COLUMN `a` int;\n\n-- 未能自動產生的變更：\n-- * foo\n");
    }
}
