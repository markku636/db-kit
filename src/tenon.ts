import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { RdSession } from "./rdTypes";
import { defaultRdOptions } from "./rdTypes";

export interface TenonConfig { enabled: boolean; url: string; auto_sync: boolean; profile: string }
export interface TenonStatus { config: TenonConfig; signed_in: boolean }
export interface TenonDevice { id: string; name: string; book: string; book_guid: string; online: boolean; tags: string[]; can_connect: boolean }
interface Directory { devices: TenonDevice[] }
const blank: TenonStatus = { config: { enabled: false, url: "", auto_sync: false, profile: "" }, signed_in: false };
let epoch = 0;
const message = (e: unknown) => e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
export const useTenon = create<{
  status: TenonStatus; devices: TenonDevice[]; busy: boolean; error: string; loaded: boolean;
  load: () => Promise<void>; save: (config: TenonConfig) => Promise<void>;
  login: (username: string, password: string, code: string) => Promise<void>;
  logout: () => Promise<void>; refresh: () => Promise<void>;
}>((set, get) => {
  const mutate = async (command: string, args?: Record<string, unknown>) => {
    const current = ++epoch; set({ busy: true, error: "", devices: [] });
    try { const status = await invoke<TenonStatus>(command, args); if (current === epoch) set({ status }); }
    catch (e) {
      if (current === epoch) {
        set({ error: message(e) });
        try { const status = await invoke<TenonStatus>("tenon_status"); if (current === epoch) set({ status }); } catch { /* keep error visible */ }
      }
    } finally { if (current === epoch) set({ busy: false }); }
  };
  return {
    status: blank, devices: [], busy: false, error: "", loaded: false,
    load: async () => {
      const current = epoch;
      try { const status = await invoke<TenonStatus>("tenon_status"); if (current === epoch) set({ status, loaded: true }); }
      catch (e) { if (current === epoch) set({ error: message(e), loaded: true }); }
    },
    save: config => mutate("tenon_config_set", { config }),
    login: (username, password, code) => mutate("tenon_login", { username, password, code }),
    logout: () => mutate("tenon_logout"),
    refresh: async () => {
      if (!get().status.config.enabled || !get().status.signed_in || get().busy) return;
      const current = ++epoch; set({ busy: true, error: "" });
      try { const data = await invoke<Directory>("tenon_directory"); if (current === epoch) set({ devices: data.devices }); }
      catch (e) { if (current === epoch) { set({ devices: [], error: message(e) }); await get().load(); } }
      finally { if (current === epoch) set({ busy: false }); }
    },
  };
});

export function tenonSession(device: TenonDevice, config: TenonConfig): RdSession {
  return { id: `tenon:${config.profile}:${device.id}`, name: device.name || device.id, protocol: "rustdesk", host: device.id, port: 0,
    username: "", domain: "", via_ssh_session_id: null, folder_id: null,
    options: { ...defaultRdOptions(), ui: { tenon_profile: config.profile } } };
}
