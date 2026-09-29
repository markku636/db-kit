// Registry v2 / Harbor DTO（欄位對齊後端 src-tauri/src/db/{registry,harbor}/dto.rs 的 snake_case serde）。

export interface RegistryInfo {
  base_url: string;
  api_version: string;
  /** none / basic / bearer */
  auth: string;
  catalog: boolean;
}

export interface RegistryLayer {
  digest: string;
  size: number;
  media_type: string;
}

export interface RegistryPlatform {
  digest: string;
  os: string;
  arch: string;
  variant: string;
  size: number;
  media_type: string;
}

export interface RegistryImageConfig {
  created: string;
  os: string;
  arch: string;
  author: string;
  entrypoint: string[];
  cmd: string[];
  env: string[];
  exposed_ports: string[];
  working_dir: string;
  user: string;
  labels: Record<string, string>;
  history: string[];
}

export interface RegistryManifest {
  repository: string;
  reference: string;
  digest: string;
  media_type: string;
  size: number;
  is_index: boolean;
  layers: RegistryLayer[];
  platforms: RegistryPlatform[];
  config_digest: string;
  config: RegistryImageConfig | null;
  raw: string;
}

export interface HarborComponent {
  name: string;
  status: string;
  error: string;
}

export interface HarborOverview {
  base_url: string;
  harbor_version: string;
  auth_mode: string;
  registry_url: string;
  health: string;
  components: HarborComponent[];
  private_projects: number;
  public_projects: number;
  private_repos: number;
  public_repos: number;
  storage_used: number;
  user: string;
  is_admin: boolean;
}

export interface HarborProject {
  name: string;
  project_id: number;
  public: boolean;
  repo_count: number;
  owner: string;
  creation_time: string;
  auto_scan: boolean;
  prevent_vul: boolean;
  severity: string;
  quota_hard: number;
  quota_used: number;
  registry_name: string;
}

export interface HarborRepository {
  name: string;
  full_name: string;
  artifact_count: number;
  pull_count: number;
  creation_time: string;
  update_time: string;
  description: string;
}

export interface HarborTag {
  name: string;
  push_time: string;
  pull_time: string;
  immutable: boolean;
}

export interface HarborLabel {
  name: string;
  color: string;
}

export interface HarborScan {
  status: string;
  severity: string;
  total: number;
  fixable: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  end_time: string;
  complete_percent: number;
  scanner: string;
}

export interface HarborArtifact {
  digest: string;
  kind: string;
  media_type: string;
  size: number;
  push_time: string;
  pull_time: string;
  os: string;
  arch: string;
  tags: HarborTag[];
  labels: HarborLabel[];
  scan: HarborScan | null;
  references: number;
}

export interface HarborArtifactPage {
  items: HarborArtifact[];
  total: number;
}

export interface HarborVulnerability {
  id: string;
  package: string;
  version: string;
  fix_version: string;
  severity: string;
  description: string;
  links: string[];
  cvss: number;
}

export interface HarborVulnReport {
  scanner: string;
  generated_at: string;
  severity: string;
  items: HarborVulnerability[];
}
