import { describe, expect, it } from "vitest";
import {
  age, b64decode, builtinRef, CLUSTER_TREE_KINDS, defaultContainer, fmtCpu, forwardablePorts, forwardTarget, parseObjKind, podContainers,
  podStatus, replicas, servicePorts, splitTreeName, stateTone, TREE_KINDS, workloadSelector, k8sOptionsFor, pickK8sOpts,
} from "./k8sModel";
import type { K8sObject } from "./k8sTypes";

const pod = (extra: Partial<K8sObject> = {}): K8sObject => ({
  metadata: { name: "web-1", namespace: "demo", annotations: {} },
  spec: {
    containers: [
      { name: "sidecar", image: "envoy:1", ports: [{ containerPort: 9901, name: "admin" }] },
      { name: "app", image: "postgres:16", ports: [{ containerPort: 5432, name: "pg" }, { containerPort: 53, protocol: "UDP" }] },
    ],
  },
  status: {
    phase: "Running",
    containerStatuses: [
      { name: "sidecar", ready: true, restartCount: 0, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } },
      { name: "app", ready: false, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } },
    ],
  },
  ...extra,
});

describe("tree names and kinds", () => {
  it("splits plural/name", () => {
    expect(splitTreeName("pods/redis-abc")).toEqual({ plural: "pods", name: "redis-abc" });
    expect(splitTreeName("widgets.example.com/a")).toEqual({ plural: "widgets.example.com", name: "a" });
    expect(splitTreeName("bare")).toEqual({ plural: "", name: "bare" });
  });
  it("parses k8s obj kinds", () => {
    expect(parseObjKind("k8s:pods:running")).toEqual({ plural: "pods", state: "running" });
    expect(parseObjKind("k8s:secrets:kubernetes.io/tls")).toEqual({ plural: "secrets", state: "kubernetes.io/tls" });
    expect(parseObjKind("container-running")).toBeNull();
  });
  it("every tree kind is a builtin", () => {
    for (const k of [...TREE_KINDS, ...CLUSTER_TREE_KINDS]) expect(builtinRef(k), k).not.toBeNull();
    expect(builtinRef("nodes")?.namespaced).toBe(false);
    expect(builtinRef("deployments")?.group).toBe("apps");
  });
  it("tones", () => {
    expect(stateTone("pods", "running")).toBe("success");
    expect(stateTone("pods", "error")).toBe("danger");
    expect(stateTone("deployments", "warn")).toBe("warning");
    expect(stateTone("cronjobs", "suspended")).toBe("neutral");
  });
});

describe("pods", () => {
  it("status prefers container waiting reason", () => {
    expect(podStatus(pod())).toBe("CrashLoopBackOff");
    expect(podStatus(pod({ metadata: { name: "x", deletionTimestamp: "2026-01-01T00:00:00Z" } }))).toBe("Terminating");
  });
  it("containers rows", () => {
    const rows = podContainers(pod());
    expect(rows.map((r) => [r.name, r.state, r.restarts])).toEqual([["sidecar", "running", 0], ["app", "waiting", 4]]);
    expect(rows[1].reason).toBe("CrashLoopBackOff");
  });
  it("default container honours the annotation", () => {
    expect(defaultContainer(pod())).toBe("sidecar");
    const p = pod();
    p.metadata.annotations = { "kubectl.kubernetes.io/default-container": "app" };
    expect(defaultContainer(p)).toBe("app");
  });
  it("forwardable ports skip UDP", () => {
    expect(forwardablePorts(pod(), "pods").map((p) => p.port)).toEqual([9901, 5432]);
  });
});

describe("workloads and services", () => {
  it("replicas for deployments and daemonsets", () => {
    expect(replicas({ metadata: { name: "d" }, spec: { replicas: 3 }, status: { readyReplicas: 2 } }, "deployments")).toMatchObject({ desired: 3, ready: 2 });
    expect(replicas({ metadata: { name: "d" }, spec: {}, status: { desiredNumberScheduled: 4, numberReady: 4 } }, "daemonsets")).toMatchObject({ desired: 4, ready: 4 });
  });
  it("selectors", () => {
    expect(workloadSelector({ metadata: { name: "s" }, spec: { selector: { app: "pg", tier: "db" } } }, "services")).toBe("app=pg,tier=db");
    expect(workloadSelector({ metadata: { name: "d" }, spec: { selector: { matchLabels: { app: "x" } } } }, "deployments")).toBe("app=x");
    expect(workloadSelector({ metadata: { name: "j", uid: "u1" }, spec: {} }, "jobs")).toBe("controller-uid=u1");
  });
  it("service ports and forward targets", () => {
    const svc: K8sObject = { metadata: { name: "pg" }, spec: { ports: [{ name: "pg", port: 15432, targetPort: "pg" }, { port: 53, protocol: "UDP" }] } };
    expect(servicePorts(svc)[0]).toMatchObject({ port: 15432, targetPort: "pg", protocol: "TCP" });
    expect(forwardablePorts(svc, "services").map((p) => p.port)).toEqual([15432]);
    expect(forwardTarget("services", "pg")).toBe("svc/pg");
    expect(forwardTarget("statefulsets", "pg")).toBe("sts/pg");
    expect(forwardTarget("pods", "pg-0")).toBe("pod/pg-0");
  });
});

describe("formatting", () => {
  it("age like kubectl", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    expect(age("2026-01-09T23:59:30Z", now)).toBe("30s");
    expect(age("2026-01-09T23:00:00Z", now)).toBe("60m");
    expect(age("2026-01-08T01:00:00Z", now)).toBe("47h");
    expect(age("2026-01-08T00:00:00Z", now)).toBe("2d");
    expect(age("2026-01-01T00:00:00Z", now)).toBe("9d");
    expect(age(undefined, now)).toBe("");
  });
  it("cpu", () => {
    expect(fmtCpu(250)).toBe("250m");
    expect(fmtCpu(2500)).toBe("2.50");
    expect(fmtCpu(null)).toBe("—");
  });
  it("base64 text only", () => {
    expect(b64decode("c2VjcmV0")).toBe("secret");
    expect(b64decode("/w==")).toBeNull();
  });
});

describe("connection options", () => {
  it("picks only k8s keys", () => {
    expect(pickK8sOpts({ k8s_context: "dev", ssl_mode: "require" })).toEqual({ k8s_context: "dev" });
  });
  it("kubernetes kind keeps cluster keys for its mode only", () => {
    const opts = { k8s_context: "dev", k8s_kubeconfig: "~/.kube/a", k8s_tls_ca: "ca.pem", k8s_namespaces: "a,b", k8s_conn: "x" };
    expect(k8sOptionsFor("kubernetes", opts)).toEqual({ k8s_context: "dev", k8s_kubeconfig: "~/.kube/a", k8s_namespaces: "a,b" });
    expect(k8sOptionsFor("kubernetes", { ...opts, k8s_source: "manual" })).toEqual({ k8s_source: "manual", k8s_tls_ca: "ca.pem", k8s_namespaces: "a,b" });
  });
  it("db kinds keep forward keys only when enabled", () => {
    expect(k8sOptionsFor("postgres", { k8s_conn: "", k8s_target: "svc/pg" })).toEqual({});
    expect(k8sOptionsFor("postgres", { k8s_conn: "c1", k8s_ns: "demo", k8s_target: " svc/pg ", k8s_port: "5432", k8s_context: "x" }))
      .toEqual({ k8s_conn: "c1", k8s_ns: "demo", k8s_target: "svc/pg", k8s_port: "5432" });
  });
});
