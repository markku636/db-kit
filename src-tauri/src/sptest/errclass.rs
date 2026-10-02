//! 錯誤分類：把三個引擎各自的錯誤號 / SQLSTATE 收斂成同一組類別，讓「兩邊都出錯」能以類別比對，
//! 而不是比對永遠不會相同的訊息文字。

use serde::{Deserialize, Serialize};

use crate::db::DbKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    ConstraintViolation,
    NotNull,
    Conversion,
    DivideByZero,
    UserRaised,
    NotFound,
    Timeout,
    Other,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::ConstraintViolation => "constraint_violation",
            ErrorClass::NotNull => "not_null",
            ErrorClass::Conversion => "conversion",
            ErrorClass::DivideByZero => "divide_by_zero",
            ErrorClass::UserRaised => "user_raised",
            ErrorClass::NotFound => "not_found",
            ErrorClass::Timeout => "timeout",
            ErrorClass::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<ErrorClass> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "constraint_violation" | "constraint" => ErrorClass::ConstraintViolation,
            "not_null" => ErrorClass::NotNull,
            "conversion" => ErrorClass::Conversion,
            "divide_by_zero" => ErrorClass::DivideByZero,
            "user_raised" | "user" => ErrorClass::UserRaised,
            "not_found" => ErrorClass::NotFound,
            "timeout" => ErrorClass::Timeout,
            "other" => ErrorClass::Other,
            _ => return None,
        })
    }
}

/// 依引擎把（錯誤號, SQLSTATE）對到類別。PG 只有 SQLSTATE；MSSQL 只有錯誤號；MySQL 兩者都有，
/// `SIGNAL SQLSTATE '45000'` 的自訂錯誤號落在任何範圍都算使用者丟出的。
pub fn classify(kind: DbKind, number: Option<i64>, sqlstate: Option<&str>) -> ErrorClass {
    match kind {
        DbKind::Mssql => match number {
            Some(2627 | 2601 | 547) => ErrorClass::ConstraintViolation,
            Some(515) => ErrorClass::NotNull,
            Some(245 | 8114 | 241 | 242) => ErrorClass::Conversion,
            Some(8134) => ErrorClass::DivideByZero,
            Some(n) if n >= 50000 => ErrorClass::UserRaised,
            Some(208 | 2812) => ErrorClass::NotFound,
            Some(1222 | -2) => ErrorClass::Timeout,
            _ => ErrorClass::Other,
        },
        DbKind::Postgres => match sqlstate.unwrap_or("") {
            "23505" | "23503" | "23514" | "23P01" => ErrorClass::ConstraintViolation,
            "23502" => ErrorClass::NotNull,
            "22P02" | "22007" | "22003" | "22008" | "22001" => ErrorClass::Conversion,
            "22012" => ErrorClass::DivideByZero,
            "P0001" => ErrorClass::UserRaised,
            "42P01" | "42883" | "42703" => ErrorClass::NotFound,
            "55P03" | "57014" => ErrorClass::Timeout,
            _ => ErrorClass::Other,
        },
        DbKind::Mysql | DbKind::Mariadb => {
            if sqlstate == Some("45000") {
                return ErrorClass::UserRaised;
            }
            match number {
                Some(1062 | 1452 | 1451 | 3819 | 1586) => ErrorClass::ConstraintViolation,
                Some(1048 | 1364) => ErrorClass::NotNull,
                Some(1366 | 1292 | 1264 | 1406) => ErrorClass::Conversion,
                Some(1365) => ErrorClass::DivideByZero,
                Some(1644) => ErrorClass::UserRaised,
                Some(1146 | 1305 | 1054) => ErrorClass::NotFound,
                Some(1205 | 1213 | 3024) => ErrorClass::Timeout,
                _ => ErrorClass::Other,
            }
        }
        _ => ErrorClass::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mssql_numbers() {
        assert_eq!(classify(DbKind::Mssql, Some(2627), None), ErrorClass::ConstraintViolation);
        assert_eq!(classify(DbKind::Mssql, Some(50001), None), ErrorClass::UserRaised);
        assert_eq!(classify(DbKind::Mssql, Some(8134), None), ErrorClass::DivideByZero);
        assert_eq!(classify(DbKind::Mssql, Some(1222), None), ErrorClass::Timeout);
        assert_eq!(classify(DbKind::Mssql, Some(9999), None), ErrorClass::Other);
    }

    #[test]
    fn pg_sqlstates() {
        assert_eq!(classify(DbKind::Postgres, None, Some("23505")), ErrorClass::ConstraintViolation);
        assert_eq!(classify(DbKind::Postgres, None, Some("P0001")), ErrorClass::UserRaised);
        assert_eq!(classify(DbKind::Postgres, None, Some("22012")), ErrorClass::DivideByZero);
        assert_eq!(classify(DbKind::Postgres, None, Some("42P01")), ErrorClass::NotFound);
    }

    #[test]
    fn mysql_signal_and_numbers() {
        assert_eq!(classify(DbKind::Mysql, Some(50001), Some("45000")), ErrorClass::UserRaised);
        assert_eq!(classify(DbKind::Mysql, Some(1644), Some("45000")), ErrorClass::UserRaised);
        assert_eq!(classify(DbKind::Mysql, Some(1062), Some("23000")), ErrorClass::ConstraintViolation);
        assert_eq!(classify(DbKind::Mysql, Some(1048), Some("23000")), ErrorClass::NotNull);
        assert_eq!(classify(DbKind::Mariadb, Some(1213), Some("40001")), ErrorClass::Timeout);
    }

    #[test]
    fn roundtrip_names() {
        for c in [
            ErrorClass::ConstraintViolation,
            ErrorClass::NotNull,
            ErrorClass::Conversion,
            ErrorClass::DivideByZero,
            ErrorClass::UserRaised,
            ErrorClass::NotFound,
            ErrorClass::Timeout,
            ErrorClass::Other,
        ] {
            assert_eq!(ErrorClass::parse(c.as_str()), Some(c));
        }
        assert_eq!(ErrorClass::parse("nope"), None);
    }
}
