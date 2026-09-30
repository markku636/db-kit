import { describe, it, expect } from "vitest";
import {
  COMBOS,
  RD_INPUT_RECORD_SIZE,
  RD_SCANCODE_PAUSE,
  RD_WHEEL_HORIZONTAL,
  RdInputEncoder,
  RdInputOp,
  RdLockFlag,
  WheelAccumulator,
  decodeRdInput,
  encodeCombo,
  lockFlagsFromEvent,
  mouseButtonFromDom,
  scancodeForCode,
  wheelDeltaFromDom,
} from "./rdInput";

// 解回物件再比對，比直接比 bytes 好讀；另外有一個案例鎖住原始 byte 排列（little-endian）。
function drain(enc: RdInputEncoder) {
  const bytes = enc.take();
  return bytes ? decodeRdInput(bytes) : [];
}

describe("scancodeForCode", () => {
  it("字母、數字列與基本鍵", () => {
    expect(scancodeForCode("Escape")).toBe(0x01);
    expect(scancodeForCode("Digit1")).toBe(0x02);
    expect(scancodeForCode("Digit0")).toBe(0x0b);
    expect(scancodeForCode("KeyQ")).toBe(0x10);
    expect(scancodeForCode("KeyA")).toBe(0x1e);
    expect(scancodeForCode("KeyZ")).toBe(0x2c);
    expect(scancodeForCode("KeyM")).toBe(0x32);
    expect(scancodeForCode("Backquote")).toBe(0x29);
    expect(scancodeForCode("Backslash")).toBe(0x2b);
    expect(scancodeForCode("Enter")).toBe(0x1c);
    expect(scancodeForCode("Space")).toBe(0x39);
    expect(scancodeForCode("ShiftRight")).toBe(0x36);
    expect(scancodeForCode("AltLeft")).toBe(0x38);
  });

  it("26 個字母與 10 個數字全都有，且互不重複", () => {
    const codes = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
      ..."0123456789".split("").map((d) => `Digit${d}`),
    ];
    const scs = codes.map(scancodeForCode);
    expect(scs.every((s) => s !== null)).toBe(true);
    expect(new Set(scs).size).toBe(codes.length);
  });

  it("F1–F24（F11/F12 與 F13+ 不連續）", () => {
    expect(scancodeForCode("F1")).toBe(0x3b);
    expect(scancodeForCode("F10")).toBe(0x44);
    expect(scancodeForCode("F11")).toBe(0x57);
    expect(scancodeForCode("F12")).toBe(0x58);
    expect(scancodeForCode("F13")).toBe(0x64);
    expect(scancodeForCode("F23")).toBe(0x6e);
    expect(scancodeForCode("F24")).toBe(0x76);
    for (let i = 1; i <= 24; i++) expect(scancodeForCode(`F${i}`)).not.toBeNull();
  });

  it("數字鍵盤：一般鍵非延伸，Enter / Divide 是延伸", () => {
    expect(scancodeForCode("Numpad7")).toBe(0x47);
    expect(scancodeForCode("Numpad0")).toBe(0x52);
    expect(scancodeForCode("NumpadDecimal")).toBe(0x53);
    expect(scancodeForCode("NumpadMultiply")).toBe(0x37);
    expect(scancodeForCode("NumpadSubtract")).toBe(0x4a);
    expect(scancodeForCode("NumpadAdd")).toBe(0x4e);
    expect(scancodeForCode("NumLock")).toBe(0x45);
    expect(scancodeForCode("NumpadEnter")).toBe(0xe01c);
    expect(scancodeForCode("NumpadDivide")).toBe(0xe035);
  });

  it("方向鍵與編輯區是 E0 延伸鍵（跟數字鍵盤的同位置鍵區分）", () => {
    expect(scancodeForCode("ArrowUp")).toBe(0xe048);
    expect(scancodeForCode("ArrowDown")).toBe(0xe050);
    expect(scancodeForCode("ArrowLeft")).toBe(0xe04b);
    expect(scancodeForCode("ArrowRight")).toBe(0xe04d);
    expect(scancodeForCode("Home")).toBe(0xe047);
    expect(scancodeForCode("End")).toBe(0xe04f);
    expect(scancodeForCode("PageUp")).toBe(0xe049);
    expect(scancodeForCode("PageDown")).toBe(0xe051);
    expect(scancodeForCode("Insert")).toBe(0xe052);
    expect(scancodeForCode("Delete")).toBe(0xe053);
    // 與數字鍵盤同一個低位元組，只差 E0。
    expect(scancodeForCode("Home")! & 0xff).toBe(scancodeForCode("Numpad7"));
  });

  it("右側修飾鍵、Win、選單、PrintScreen", () => {
    expect(scancodeForCode("ControlRight")).toBe(0xe01d);
    expect(scancodeForCode("AltRight")).toBe(0xe038);
    expect(scancodeForCode("MetaLeft")).toBe(0xe05b);
    expect(scancodeForCode("MetaRight")).toBe(0xe05c);
    expect(scancodeForCode("OSLeft")).toBe(0xe05b);
    expect(scancodeForCode("OSRight")).toBe(0xe05c);
    expect(scancodeForCode("ContextMenu")).toBe(0xe05d);
    expect(scancodeForCode("PrintScreen")).toBe(0xe037);
  });

  it("Pause 用特殊值 0xE11D（後端展開成 E1 序列）", () => {
    expect(RD_SCANCODE_PAUSE).toBe(0xe11d);
    expect(scancodeForCode("Pause")).toBe(0xe11d);
  });

  it("國際 / 日韓鍵", () => {
    expect(scancodeForCode("IntlBackslash")).toBe(0x56);
    expect(scancodeForCode("IntlRo")).toBe(0x73);
    expect(scancodeForCode("IntlYen")).toBe(0x7d);
    expect(scancodeForCode("Lang1")).toBe(0x72);
    expect(scancodeForCode("Lang2")).toBe(0x71);
    expect(scancodeForCode("KanaMode")).toBe(0x70);
    expect(scancodeForCode("Convert")).toBe(0x79);
    expect(scancodeForCode("NonConvert")).toBe(0x7b);
  });

  it("認不出來回 null（含原型鏈上的名字）", () => {
    expect(scancodeForCode("")).toBeNull();
    expect(scancodeForCode("Unidentified")).toBeNull();
    expect(scancodeForCode("Fn")).toBeNull();
    expect(scancodeForCode("toString")).toBeNull();
    expect(scancodeForCode("__proto__")).toBeNull();
  });
});

describe("mouseButtonFromDom", () => {
  it("0–4 原樣對映（上一頁 → X1、下一頁 → X2），其他回 null", () => {
    expect(mouseButtonFromDom(0)).toBe(0);
    expect(mouseButtonFromDom(1)).toBe(1);
    expect(mouseButtonFromDom(2)).toBe(2);
    expect(mouseButtonFromDom(3)).toBe(3);
    expect(mouseButtonFromDom(4)).toBe(4);
    expect(mouseButtonFromDom(5)).toBeNull();
    expect(mouseButtonFromDom(-1)).toBeNull();
    expect(mouseButtonFromDom(1.5)).toBeNull();
  });
});

describe("lockFlagsFromEvent", () => {
  it("把 getModifierState 轉成位元", () => {
    const on = new Set(["CapsLock", "NumLock"]);
    expect(lockFlagsFromEvent({ getModifierState: (k) => on.has(k) })).toBe(RdLockFlag.CAPS | RdLockFlag.NUM);
    expect(lockFlagsFromEvent({ getModifierState: () => false })).toBe(0);
  });
});

describe("RdInputEncoder", () => {
  it("原始 byte 排列：[op][flags][a LE][b LE][c LE]", () => {
    const enc = new RdInputEncoder();
    enc.button(true, 2, 0x1234, 0x0abc);
    const bytes = enc.take()!;
    expect(Array.from(bytes)).toEqual([RdInputOp.BUTTON_DOWN, 0, 2, 0, 0x34, 0x12, 0xbc, 0x0a]);
  });

  it("key：對得到掃描碼就寫紀錄，認不出來回 false 且不寫", () => {
    const enc = new RdInputEncoder();
    expect(enc.key(true, "ControlRight")).toBe(true);
    expect(enc.key(false, "ControlRight")).toBe(true);
    expect(enc.key(true, "Unidentified")).toBe(false);
    expect(drain(enc)).toEqual([
      { op: RdInputOp.KEY_DOWN, flags: 0, a: 0xe01d, b: 0, c: 0 },
      { op: RdInputOp.KEY_UP, flags: 0, a: 0xe01d, b: 0, c: 0 },
    ]);
  });

  it("unicode 寫 UTF-16 code unit", () => {
    const enc = new RdInputEncoder();
    enc.unicode(true, "中".charCodeAt(0));
    enc.unicode(false, "中".charCodeAt(0));
    expect(drain(enc)).toEqual([
      { op: RdInputOp.UNICODE_DOWN, flags: 0, a: 0x4e2d, b: 0, c: 0 },
      { op: RdInputOp.UNICODE_UP, flags: 0, a: 0x4e2d, b: 0, c: 0 },
    ]);
  });

  it("連續移動只留最後一筆", () => {
    const enc = new RdInputEncoder();
    for (let i = 0; i < 50; i++) enc.move(i, i * 2);
    expect(enc.pending).toBe(1);
    expect(drain(enc)).toEqual([{ op: RdInputOp.MOUSE_MOVE, flags: 0, a: 49, b: 98, c: 0 }]);
  });

  it("移動被其他紀錄隔開時不合併（保留拖曳順序）", () => {
    const enc = new RdInputEncoder();
    enc.move(1, 1);
    enc.move(10, 10);
    enc.button(true, 0, 10, 10);
    enc.move(20, 20);
    enc.move(30, 30);
    enc.button(false, 0, 30, 30);
    expect(drain(enc).map((r) => [r.op, r.a, r.b])).toEqual([
      [RdInputOp.MOUSE_MOVE, 10, 10],
      [RdInputOp.BUTTON_DOWN, 0, 10],
      [RdInputOp.MOUSE_MOVE, 30, 30],
      [RdInputOp.BUTTON_UP, 0, 30],
    ]);
  });

  it("take 之後的移動不會覆寫已取走的那批", () => {
    const enc = new RdInputEncoder();
    enc.move(1, 2);
    const first = enc.take()!;
    enc.move(3, 4);
    expect(decodeRdInput(first)).toEqual([{ op: RdInputOp.MOUSE_MOVE, flags: 0, a: 1, b: 2, c: 0 }]);
    expect(drain(enc)).toEqual([{ op: RdInputOp.MOUSE_MOVE, flags: 0, a: 3, b: 4, c: 0 }]);
  });

  it("take 沒東西回 null，取完即清空", () => {
    const enc = new RdInputEncoder();
    expect(enc.take()).toBeNull();
    enc.releaseAll();
    expect(enc.take()!.length).toBe(RD_INPUT_RECORD_SIZE);
    expect(enc.take()).toBeNull();
  });

  it("座標夾在 u16、四捨五入", () => {
    const enc = new RdInputEncoder();
    enc.move(-5, 70000);
    enc.button(true, 0, 10.6, NaN);
    expect(drain(enc).map((r) => [r.a, r.b, r.c])).toEqual([
      [0, 0xffff, 0],
      [0, 11, 0],
    ]);
  });

  it("wheel：負值以 u16 二補數存、水平設 flags bit0、0 不寫", () => {
    const enc = new RdInputEncoder();
    enc.wheel(120, false, 5, 6);
    enc.wheel(-240, true, 7, 8);
    enc.wheel(0, false, 0, 0);
    enc.wheel(100000, false, 0, 0);
    const recs = drain(enc);
    expect(recs).toEqual([
      { op: RdInputOp.WHEEL, flags: 0, a: 120, b: 5, c: 6 },
      { op: RdInputOp.WHEEL, flags: RD_WHEEL_HORIZONTAL, a: 0x10000 - 240, b: 7, c: 8 },
      { op: RdInputOp.WHEEL, flags: 0, a: 0x7fff, b: 0, c: 0 },
    ]);
    // 後端以 i16 讀回來是 -240。
    expect(new Int16Array(new Uint16Array([recs[1].a]).buffer)[0]).toBe(-240);
  });

  it("releaseAll / syncLocks", () => {
    const enc = new RdInputEncoder();
    enc.releaseAll();
    enc.syncLocks(RdLockFlag.CAPS | RdLockFlag.NUM | 0xf0);
    expect(drain(enc)).toEqual([
      { op: RdInputOp.RELEASE_ALL, flags: 0, a: 0, b: 0, c: 0 },
      { op: RdInputOp.SYNC_LOCKS, flags: 6, a: 0, b: 0, c: 0 },
    ]);
  });

  it("超過初始容量會長大，內容不丟", () => {
    const enc = new RdInputEncoder();
    for (let i = 0; i < 500; i++) enc.unicode(true, i);
    const recs = drain(enc);
    expect(recs.length).toBe(500);
    expect(recs[0].a).toBe(0);
    expect(recs[499].a).toBe(499);
  });
});

describe("wheelDeltaFromDom", () => {
  it("像素模式：100px = 一格；DOM 往下（正）→ RDP 負", () => {
    expect(wheelDeltaFromDom({ deltaY: 100, deltaX: 0, deltaMode: 0 })).toEqual({ v: -120, h: 0 });
    expect(wheelDeltaFromDom({ deltaY: -100, deltaX: 50, deltaMode: 0 })).toEqual({ v: 120, h: 60 });
  });

  it("行模式：3 行 = 一格", () => {
    expect(wheelDeltaFromDom({ deltaY: 3, deltaX: 0, deltaMode: 1 })).toEqual({ v: -120, h: 0 });
    expect(wheelDeltaFromDom({ deltaY: -1, deltaX: 0, deltaMode: 1 })).toEqual({ v: 40, h: 0 });
  });

  it("頁模式：一頁 = 三格", () => {
    expect(wheelDeltaFromDom({ deltaY: 1, deltaX: 0, deltaMode: 2 })).toEqual({ v: -360, h: 0 });
  });

  it("沒有位移回 0 而不是 -0", () => {
    const r = wheelDeltaFromDom({ deltaY: 0, deltaX: 0, deltaMode: 0 });
    expect(Object.is(r.v, 0)).toBe(true);
    expect(Object.is(r.h, 0)).toBe(true);
  });
});

describe("WheelAccumulator", () => {
  it("觸控板的小位移累積到一格才送", () => {
    const acc = new WheelAccumulator();
    const out: number[] = [];
    for (let i = 0; i < 10; i++) out.push(acc.push({ deltaY: 25, deltaX: 0, deltaMode: 0 }).v);
    // 25px = 30 單位，每 4 次湊滿一格往下（-120）。
    expect(out).toEqual([0, 0, 0, -120, 0, 0, 0, -120, 0, 0]);
  });

  it("一次大位移送出多格、餘數保留", () => {
    const acc = new WheelAccumulator();
    expect(acc.push({ deltaY: -250, deltaX: 0, deltaMode: 0 }).v).toBe(240); // 300 → 240，餘 60
    expect(acc.push({ deltaY: -50, deltaX: 0, deltaMode: 0 }).v).toBe(120); // 60 + 60
  });

  it("方向反轉時丟掉舊餘數", () => {
    const acc = new WheelAccumulator();
    expect(acc.push({ deltaY: 90, deltaX: 0, deltaMode: 0 }).v).toBe(0); // 餘 -108
    // 若不清餘數，這一下 +120 會先抵掉 -108 而送不出去。
    expect(acc.push({ deltaY: -100, deltaX: 0, deltaMode: 0 }).v).toBe(120);
  });

  it("水平與垂直各自累積；reset 清空", () => {
    const acc = new WheelAccumulator();
    expect(acc.push({ deltaY: 0, deltaX: 60, deltaMode: 0 })).toEqual({ v: 0, h: 0 });
    acc.reset();
    expect(acc.push({ deltaY: 0, deltaX: 60, deltaMode: 0 })).toEqual({ v: 0, h: 0 });
    expect(acc.push({ deltaY: 0, deltaX: 60, deltaMode: 0 })).toEqual({ v: 0, h: 120 });
  });

  it("行模式的整格直接送出", () => {
    const acc = new WheelAccumulator();
    expect(acc.push({ deltaY: 3, deltaX: 0, deltaMode: 1 })).toEqual({ v: -120, h: 0 });
  });
});

describe("COMBOS / encodeCombo", () => {
  it("每個組合鍵的碼都查得到，且按下 / 放開成對", () => {
    for (const [name, steps] of Object.entries(COMBOS)) {
      for (const [code] of steps) expect(scancodeForCode(code), `${name}: ${code}`).not.toBeNull();
      const downs = steps.filter(([, d]) => d).map(([c]) => c);
      const ups = steps.filter(([, d]) => !d).map(([c]) => c);
      expect(ups.slice().reverse(), name).toEqual(downs);
    }
  });

  it("Ctrl+Alt+Del 的紀錄", () => {
    expect(decodeRdInput(encodeCombo("ctrlAltDel")).map((r) => [r.op, r.a])).toEqual([
      [RdInputOp.KEY_DOWN, 0x1d],
      [RdInputOp.KEY_DOWN, 0x38],
      [RdInputOp.KEY_DOWN, 0xe053],
      [RdInputOp.KEY_UP, 0xe053],
      [RdInputOp.KEY_UP, 0x38],
      [RdInputOp.KEY_UP, 0x1d],
    ]);
  });

  it("Win / Alt+Tab / Ctrl+Esc / PrintScreen", () => {
    expect(decodeRdInput(encodeCombo("win")).map((r) => [r.op, r.a])).toEqual([
      [RdInputOp.KEY_DOWN, 0xe05b],
      [RdInputOp.KEY_UP, 0xe05b],
    ]);
    expect(decodeRdInput(encodeCombo("altTab")).map((r) => r.a)).toEqual([0x38, 0x0f, 0x0f, 0x38]);
    expect(decodeRdInput(encodeCombo("ctrlEsc")).map((r) => r.a)).toEqual([0x1d, 0x01, 0x01, 0x1d]);
    expect(decodeRdInput(encodeCombo("printScreen")).map((r) => [r.op, r.a])).toEqual([
      [RdInputOp.KEY_DOWN, 0xe037],
      [RdInputOp.KEY_UP, 0xe037],
    ]);
  });
});

describe("decodeRdInput", () => {
  it("長度不是 8 的倍數丟錯", () => {
    expect(() => decodeRdInput(new Uint8Array(9))).toThrow(/8 的倍數/);
  });

  it("尊重 byteOffset（subarray 也能解）", () => {
    const enc = new RdInputEncoder();
    enc.releaseAll();
    enc.move(7, 8);
    const bytes = enc.take()!;
    expect(decodeRdInput(bytes.subarray(8))).toEqual([{ op: RdInputOp.MOUSE_MOVE, flags: 0, a: 7, b: 8, c: 0 }]);
  });
});
