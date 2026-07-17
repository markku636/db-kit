// 依資料庫類型（DbKind）對應的側欄圖示：讓連線一眼辨型（致敬 Navicat / TablePlus 的連線圖示）。
// 純前端對照表；顏色仍取 KIND_META[kind].color，此處只決定 glyph，不動 api.ts（避免把 lucide 依賴帶進純資料層）。
import { Database, Leaf, Boxes, Waypoints, Search, Rabbit, Globe, type LucideIcon } from "lucide-react";
import type { DbKind } from "./api";

// 關聯型（mysql / mariadb / postgres / mssql / oracle / sqlite）共用 Database，靠 KIND_META 色相區分品牌；
// 非關聯型給專屬圖示：mongo=綠葉 logo、redis=疊方塊 logo、kafka=串流節點拓撲、external=HTTP 閘道。
export const KIND_ICON: Record<DbKind, LucideIcon> = {
  mysql: Database,
  mariadb: Database,
  postgres: Database,
  mssql: Database,
  oracle: Database,
  sqlite: Database,
  mongo: Leaf,
  redis: Boxes,
  kafka: Waypoints,
  elastic: Search,
  rabbitmq: Rabbit,
  external: Globe,
};

export function kindIcon(kind: DbKind): LucideIcon {
  return KIND_ICON[kind] ?? Database;
}
