import type { Filter } from "./api";

// 資料格篩選預設（仿 DataGrip / TablePlus 的 named filters）：按「連線 + DB + 表」存在本機。
export interface FilterPreset {
  name: string;
  filters: Filter[];
  matchAny: boolean;
}

const CAP = 30;

export function loadFilterPresets(raw: string | null): FilterPreset[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is FilterPreset =>
      !!p && typeof p === "object"
      && typeof (p as FilterPreset).name === "string" && (p as FilterPreset).name.trim().length > 0
      && Array.isArray((p as FilterPreset).filters)
    ).slice(-CAP);
  } catch {
    return [];
  }
}

export function recordFilterPreset(
  presets: readonly FilterPreset[],
  name: string,
  filters: Filter[],
  matchAny: boolean,
): FilterPreset[] {
  const n = name.trim().slice(0, 60);
  if (!n || filters.length === 0) return [...presets];
  // 同名覆蓋；新存的排到最後。
  return [...presets.filter((p) => p.name !== n), { name: n, filters, matchAny }].slice(-CAP);
}
