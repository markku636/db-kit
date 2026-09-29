// Docker DTO（欄位對齊後端 src-tauri/src/db/docker/dto.rs 的 snake_case serde）。

export interface DockerOverview {
  endpoint: string;
  server_version: string;
  api_version: string;
  os: string;
  os_type: string;
  arch: string;
  kernel: string;
  name: string;
  ncpu: number;
  mem_total: number;
  driver: string;
  root_dir: string;
  containers: number;
  running: number;
  paused: number;
  stopped: number;
  images: number;
  warnings: string[];
}

export interface DockerPort {
  private_port: number;
  public_port: number | null;
  ip: string;
  proto: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  command: string;
  created: number;
  /** running / exited / paused / restarting / created / dead / removing */
  state: string;
  status: string;
  ports: DockerPort[];
  compose_project: string;
  compose_service: string;
}

export interface DockerMount {
  kind: string;
  name: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface DockerContainerNet {
  name: string;
  ip: string;
  gateway: string;
  mac: string;
  aliases: string[];
}

export interface DockerHealthLog {
  start: string;
  exit_code: number;
  output: string;
}

export interface DockerContainerDetail {
  id: string;
  name: string;
  image: string;
  image_id: string;
  created: string;
  state: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  oom_killed: boolean;
  pid: number;
  exit_code: number;
  error: string;
  started_at: string;
  finished_at: string;
  restart_count: number;
  restart_policy: string;
  health: string;
  health_log: DockerHealthLog[];
  tty: boolean;
  hostname: string;
  user: string;
  working_dir: string;
  entrypoint: string[];
  cmd: string[];
  env: string[];
  labels: Record<string, string>;
  ports: DockerPort[];
  mounts: DockerMount[];
  networks: DockerContainerNet[];
  network_mode: string;
  raw: string;
}

export interface DockerStats {
  cpu_percent: number;
  online_cpus: number;
  mem_usage: number;
  mem_limit: number;
  mem_percent: number;
  net_rx: number;
  net_tx: number;
  blk_read: number;
  blk_write: number;
  pids: number;
}

export interface DockerTop {
  titles: string[];
  processes: string[][];
}

export interface DockerImage {
  id: string;
  reference: string;
  repo_tags: string[];
  repo_digests: string[];
  created: number;
  size: number;
  containers: number;
  dangling: boolean;
}

export interface DockerImageLayer {
  created: number;
  created_by: string;
  size: number;
  comment: string;
}

export interface DockerImageDetail {
  id: string;
  repo_tags: string[];
  repo_digests: string[];
  created: string;
  arch: string;
  os: string;
  size: number;
  author: string;
  entrypoint: string[];
  cmd: string[];
  env: string[];
  exposed_ports: string[];
  working_dir: string;
  user: string;
  labels: Record<string, string>;
  layers: number;
  history: DockerImageLayer[];
  raw: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
  scope: string;
  labels: Record<string, string>;
  used_by: string[];
  raw: string;
}

export interface DockerNetworkMember {
  name: string;
  ipv4: string;
  mac: string;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  subnets: string[];
  gateways: string[];
  members: DockerNetworkMember[];
  builtin: boolean;
  raw: string;
}

export interface DockerDiskUsage {
  images_count: number;
  images_size: number;
  images_reclaimable: number;
  containers_count: number;
  containers_size: number;
  volumes_count: number;
  volumes_size: number;
  volumes_reclaimable: number;
  build_cache_count: number;
  build_cache_size: number;
}

export interface DockerPruneResult {
  deleted: number;
  space_reclaimed: number;
}

export interface DockerPullProgress {
  id: string;
  status: string;
  progress: string;
  current: number;
  total: number;
  error: string;
}

export type DockerPruneTarget = "containers" | "images" | "volumes" | "networks" | "build";
export type DockerContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "kill";

/** log / exec 串流結束事件。 */
export interface DockerStreamEnd {
  stream_id: string;
  error: string | null;
  exit_code: number | null;
}

/** 連線樹的四個固定分類（對應後端 db/docker/mod.rs 的 CATEGORIES）。 */
export const DOCKER_CATEGORIES = ["containers", "images", "volumes", "networks"] as const;
export type DockerCategory = (typeof DOCKER_CATEGORIES)[number];
