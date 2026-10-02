// noVNC（@novnc/novnc，MPL-2.0）沒有附型別；只宣告 VncView 用到的部分（見套件的 docs/API.md）。
declare module "@novnc/novnc" {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  /** WebSocket / RTCDataChannel 相容的物件（見 vncChannel.ts）。 */
  export type RfbChannel = object;

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | RfbChannel, options?: RfbOptions);
    background: string;
    readonly capabilities: { power: boolean };
    clipViewport: boolean;
    compressionLevel: number;
    dragViewport: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    resizeSession: boolean;
    scaleViewport: boolean;
    viewOnly: boolean;
    showDotCursor: boolean;
    blur(): void;
    focus(options?: FocusOptions): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    toDataURL(type?: string, encoderOptions?: number): string;
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    /** 協定訊息的編碼器（RFB.messages.*，第一個參數是內部的 Websock）。 */
    static messages: {
      fbUpdateRequest(sock: unknown, incremental: boolean, x: number, y: number, w: number, h: number): void;
    };
  }
}
