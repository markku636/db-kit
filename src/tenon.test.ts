import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { useTenon, tenonSession, type TenonConfig } from "./tenon";
const config: TenonConfig = { enabled: false, auto_sync: false, url: "", profile: "" };
beforeEach(() => { invoke.mockReset(); useTenon.setState({ status: { config, signed_in: false }, devices: [], busy: false, error: "", loaded: false }); });
describe("Tenon privacy boundary", () => {
  it("does not fetch a directory when disabled or signed out", async () => {
    await useTenon.getState().refresh();
    useTenon.setState({ status: { config: { ...config, enabled: true }, signed_in: false } });
    await useTenon.getState().refresh();expect(invoke).not.toHaveBeenCalled();
  });
  it("ignores an old directory response after disabling", async () => {
    useTenon.setState({ status: { config: { ...config, enabled: true }, signed_in: true } });
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command: string) => command === "tenon_directory" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ config, signed_in: false }));
    const pending = useTenon.getState().refresh();await useTenon.getState().save(config);
    finish({ devices: [{ id: "private" }] });await pending;
    expect(useTenon.getState().devices).toEqual([]);expect(useTenon.getState().status.config.enabled).toBe(false);
  });
  it("clears cached devices when access is rejected", async () => {
    useTenon.setState({ status: { config: { ...config, enabled: true }, signed_in: true } });
    invoke.mockRejectedValueOnce(new Error("revoked")).mockResolvedValueOnce({ config, signed_in: false });
    await useTenon.getState().refresh();expect(useTenon.getState().devices).toEqual([]);expect(useTenon.getState().status.signed_in).toBe(false);
  });
  it("creates an ephemeral profile-bound target without a server credential", () => {
    const session = tenonSession({ id: "123456789", name: "Office", book: "Team", book_guid: "1", online: true, tags: [], can_connect: true }, { ...config, profile: "profile1" });
    expect(session.options.ui).toEqual({ tenon_profile: "profile1" });expect(session.options.rustdesk_key).toBe("");expect(session.options.rustdesk_server).toBe("");
  });
});
