import { describe, it, expect, vi } from "vitest";
import {
  applyToolEvent,
  dbTarget,
  displayToolName,
  isSqlToolCall,
  type DbTargetState,
  type ToolCallView,
} from "./agentTools";
import type { AgentEvent, ConnectionConfig, DbKind } from "./api";
import type { SelectedNode } from "./store";

// 照 aiReview.test.ts 的作法保留 ./api 的真值（agentTools 只用到純函式 isProdConn），
// 但把 api facade 整個換成「一被呼叫就丟例外」而不是 vi.fn()。
// 這一層擋的是未來的修改：本模組的三支函式都是同步純函式，串流事件一秒可以來上百筆；
// 哪天有人在裡面加了 `await api.xxx()`，資料就會在 reducer 回傳之後才到，面板那一列會永遠
// 停在轉圈，而且沒有任何錯誤訊息。與其讓它安靜地壞掉，不如在這裡直接紅燈。
const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(() => {
    throw new Error("agentTools 必須是純函式，不得呼叫 Tauri");
  }),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  const trap = Object.fromEntries(Object.keys(actual.api).map((k) => [k, mocks.forbidden]));
  return { ...actual, api: trap };
});

// 事件工廠：AgentEvent 欄位多且幾乎全可選，每個案例都手寫一遍會把真正在測的差異埋掉。
function ev(e: Partial<AgentEvent> & Pick<AgentEvent, "kind">): AgentEvent {
  return { req_id: "r1", ...e };
}

function conn(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "c1",
    name: "local",
    kind: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    ...over,
  };
}

function view(over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "t1", name: "run_query", done: true, ...over };
}

describe("displayToolName", () => {
  it("剝掉 Claude 的 mcp__<server>__ 前綴", () => {
    expect(displayToolName("mcp__dbkit__run_query")).toBe("run_query");
    expect(displayToolName("mcp__dbkit__explain_query")).toBe("explain_query");
  });

  it("剝掉 <server>: 前綴", () => {
    expect(displayToolName("dbkit:run_query")).toBe("run_query");
  });

  it("裸名原樣回傳", () => {
    expect(displayToolName("run_query")).toBe("run_query");
    expect(displayToolName("list_databases")).toBe("list_databases");
    expect(displayToolName("describe_table")).toBe("describe_table");
  });

  it("只切第一段 server 名，工具名自己含 __ 的後半段要留著", () => {
    expect(displayToolName("mcp__dbkit__sample__rows")).toBe("sample__rows");
  });

  it("與 Rust 端 strip_mcp_prefix 的邊界一致（mcp__ 後沒有第二段就整段當工具名）", () => {
    expect(displayToolName("mcp__foo")).toBe("foo");
    expect(displayToolName("mcp__dbkit__")).toBe("");
  });

  it("空字串 / 前後空白不炸", () => {
    expect(displayToolName("")).toBe("");
    expect(displayToolName("  mcp__dbkit__run_query  ")).toBe("run_query");
  });
});

describe("applyToolEvent", () => {
  it("非 tool / tool_result 事件回傳同一個陣列參考（讓 React 跳過重繪）", () => {
    const list: ToolCallView[] = [view()];
    for (const kind of ["system", "text", "result", "error", "done"] as const) {
      expect(applyToolEvent(list, ev({ kind, text: "x" }))).toBe(list);
    }
  });

  // HTTP 供應商：tool 只有名字（沒有 tool_id），tool_result 才帶 id。
  it("HTTP 流程：tool（無 id）→ tool_result（有 id）併成同一列", () => {
    const started = applyToolEvent([], ev({ kind: "tool", tool: "run_query", tool_input: '{"sql":"SELECT 1"}' }));
    expect(started).toHaveLength(1);
    expect(started[0].done).toBe(false);
    expect(started[0].input).toBe('{"sql":"SELECT 1"}');

    const finished = applyToolEvent(
      started,
      ev({
        kind: "tool_result",
        tool_id: "toolu_1",
        tool_output_preview: "1",
        tool_rows: 1,
        tool_truncated: false,
        tool_ms: 12,
      }),
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toEqual({
      id: "toolu_1", // 認領真 id，後續同 id 的事件才對得回這一列
      name: "run_query",
      input: '{"sql":"SELECT 1"}',
      preview: "1",
      rows: 1,
      truncated: false,
      ms: 12,
      error: undefined,
      done: true,
    });
  });

  // CLI（MCP）：同一次呼叫的 tool 事件來兩次，一筆有 id 沒參數、一筆 id 與參數都有。
  it("CLI 流程：重複的 tool 事件併成一列，且參數不會被空的那筆蓋掉", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "mcp__dbkit__run_query", tool_id: "toolu_9" }));
    list = applyToolEvent(
      list,
      ev({ kind: "tool", tool: "mcp__dbkit__run_query", tool_id: "toolu_9", tool_input: '{"sql":"SELECT 2"}' }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("run_query"); // 前綴剝乾淨才存進去
    expect(list[0].input).toBe('{"sql":"SELECT 2"}');
    expect(list[0].done).toBe(false);

    list = applyToolEvent(list, ev({ kind: "tool_result", tool_id: "toolu_9", tool_rows: 2, tool_ms: 30 }));
    expect(list).toHaveLength(1);
    expect(list[0].input).toBe('{"sql":"SELECT 2"}'); // 結果事件沒帶參數，不准把它清掉
    expect(list[0].rows).toBe(2);
    expect(list[0].done).toBe(true);
  });

  it("兩筆 tool 事件的順序顛倒（先帶參數、後只有 id）也保住參數", () => {
    let list = applyToolEvent(
      [],
      ev({ kind: "tool", tool: "run_query", tool_id: "toolu_9", tool_input: '{"sql":"SELECT 3"}' }),
    );
    list = applyToolEvent(list, ev({ kind: "tool", tool: "run_query", tool_id: "toolu_9" }));
    expect(list).toHaveLength(1);
    expect(list[0].input).toBe('{"sql":"SELECT 3"}');
  });

  it("空字串參數視同沒帶，不覆蓋既有參數", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "run_query", tool_id: "t", tool_input: '{"sql":"SELECT 4"}' }));
    list = applyToolEvent(list, ev({ kind: "tool", tool: "run_query", tool_id: "t", tool_input: "   " }));
    expect(list[0].input).toBe('{"sql":"SELECT 4"}');
  });

  it("沒有 tool_id 時併進「最後一筆同名且未完成」的呼叫", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "list_tables" }));
    list = applyToolEvent(list, ev({ kind: "tool_result", tool: "list_tables", tool_rows: 7, tool_ms: 5 }));
    expect(list).toHaveLength(1);
    expect(list[0].rows).toBe(7);
    expect(list[0].done).toBe(true);
    expect(list[0].id).toBe("#0"); // 從頭到尾沒有真 id，維持本地代號
  });

  it("同名但前一筆已完成時另起一列（第二次呼叫不該蓋掉第一次的結果）", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "list_tables" }));
    list = applyToolEvent(list, ev({ kind: "tool_result", tool: "list_tables", tool_rows: 7 }));
    list = applyToolEvent(list, ev({ kind: "tool", tool: "list_tables" }));
    expect(list).toHaveLength(2);
    expect(list[0].rows).toBe(7);
    expect(list[1].done).toBe(false);
    expect(list[1].id).toBe("#1"); // 本地代號取自當下列數（清單只增不減，故不重複）
  });

  it("名字不同就各自一列（未完成也不併）", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "list_tables" }));
    list = applyToolEvent(list, ev({ kind: "tool", tool: "describe_table" }));
    expect(list.map((v) => v.name)).toEqual(["list_tables", "describe_table"]);
  });

  it("已綁到某個 tool_id 的列不會被另一個 tool_id 認領（平行呼叫要看得出跑了幾次）", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "list_tables", tool_id: "toolu_a" }));
    list = applyToolEvent(list, ev({ kind: "tool", tool: "list_tables", tool_id: "toolu_b" }));
    expect(list).toHaveLength(2);
    list = applyToolEvent(list, ev({ kind: "tool_result", tool_id: "toolu_b", tool_rows: 3 }));
    expect(list[0].done).toBe(false); // a 還在跑
    expect(list[1].rows).toBe(3);
  });

  it("tool_result 未回聲工具名時仍配得回未完成的那一列", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "sample_rows" }));
    list = applyToolEvent(list, ev({ kind: "tool_result", tool_rows: 10, tool_truncated: true }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("sample_rows");
    expect(list[0].truncated).toBe(true);
  });

  it("回 0 列是有意義的結果，不能退回 undefined", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "run_query", tool_id: "t" }));
    list = applyToolEvent(list, ev({ kind: "tool_result", tool_id: "t", tool_rows: 0, tool_ms: 0 }));
    expect(list[0].rows).toBe(0);
    expect(list[0].ms).toBe(0);
  });

  it("is_error 標成錯誤；後續事件沒帶 is_error 也不會把它抹掉", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "run_query", tool_id: "t" }));
    list = applyToolEvent(
      list,
      ev({ kind: "tool_result", tool_id: "t", is_error: true, tool_output_preview: "syntax error" }),
    );
    expect(list[0].error).toBe(true);
    expect(list[0].preview).toBe("syntax error");
    list = applyToolEvent(list, ev({ kind: "tool", tool: "run_query", tool_id: "t" }));
    expect(list[0].error).toBe(true);
  });

  it("晚到的 tool 事件不把已完成的呼叫打回轉圈狀態", () => {
    let list = applyToolEvent([], ev({ kind: "tool", tool: "run_query", tool_id: "t" }));
    list = applyToolEvent(list, ev({ kind: "tool_result", tool_id: "t", tool_rows: 1 }));
    list = applyToolEvent(list, ev({ kind: "tool", tool: "run_query", tool_id: "t", tool_input: '{"sql":"SELECT 5"}' }));
    expect(list[0].done).toBe(true);
    expect(list[0].input).toBe('{"sql":"SELECT 5"}'); // 參數照樣補上
  });

  it("不改動傳入的陣列，也不改動裡面的元素", () => {
    const first = view({ id: "toolu_1", name: "run_query", done: false });
    const list: ToolCallView[] = [first];
    const snapshot = { ...first };

    const next = applyToolEvent(list, ev({ kind: "tool_result", tool_id: "toolu_1", tool_rows: 4 }));
    expect(next).not.toBe(list);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(first);
    expect(first).toEqual(snapshot);
    expect(next[0].rows).toBe(4);

    // 新增列的路徑同樣不得動到原陣列。
    const appended = applyToolEvent(list, ev({ kind: "tool", tool: "list_databases", tool_id: "toolu_2" }));
    expect(appended).toHaveLength(2);
    expect(list).toHaveLength(1);
  });

  it("同一串事件重播兩次得到完全相同的結果（reducer 為純函式）", () => {
    const stream = [
      ev({ kind: "tool", tool: "mcp__dbkit__list_tables", tool_id: "toolu_1" }),
      ev({ kind: "text", text: "查一下" }),
      ev({ kind: "tool", tool: "mcp__dbkit__list_tables", tool_id: "toolu_1", tool_input: "{}" }),
      ev({ kind: "tool_result", tool_id: "toolu_1", tool_rows: 12, tool_ms: 8 }),
      ev({ kind: "tool", tool: "run_query" }),
      ev({ kind: "tool_result", tool_rows: 1, tool_output_preview: "ok" }),
    ];
    const run = (): ToolCallView[] => stream.reduce<ToolCallView[]>(applyToolEvent, []);
    expect(run()).toEqual(run());
    expect(run()).toHaveLength(2);
  });
});

describe("isSqlToolCall", () => {
  it("SQL 方言 + run_query / explain_query 為真", () => {
    const kinds: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle", "external"];
    for (const kind of kinds) {
      expect(isSqlToolCall(view({ name: "run_query" }), kind)).toBe(true);
      expect(isSqlToolCall(view({ name: "explain_query" }), kind)).toBe(true);
    }
  });

  // Mongo 的 run_query 參數是 JSON 管線、Redis 是一行指令：高亮會亂標，貼回 SQL 編輯器更跑不動。
  it("Mongo / Redis 的 run_query 不是 SQL", () => {
    expect(isSqlToolCall(view({ name: "run_query" }), "mongo")).toBe(false);
    expect(isSqlToolCall(view({ name: "run_query" }), "redis")).toBe(false);
    expect(isSqlToolCall(view({ name: "explain_query" }), "mongo")).toBe(false);
  });

  it("沒有查詢語言的類型一律為假", () => {
    for (const kind of ["kafka", "elastic", "rabbitmq"] as const) {
      expect(isSqlToolCall(view({ name: "run_query" }), kind)).toBe(false);
    }
  });

  it("kind 為 null / undefined 時為假（沒選連線就無從判斷方言）", () => {
    expect(isSqlToolCall(view({ name: "run_query" }), null)).toBe(false);
    expect(isSqlToolCall(view({ name: "run_query" }), undefined)).toBe(false);
  });

  it("其他工具的參數不是語句", () => {
    for (const name of ["list_databases", "list_tables", "describe_table", "sample_rows", ""]) {
      expect(isSqlToolCall(view({ name }), "mysql")).toBe(false);
    }
  });

  it("名字還帶著 MCP 前綴（舊存檔還原）也認得出來", () => {
    expect(isSqlToolCall(view({ name: "mcp__dbkit__run_query" }), "postgres")).toBe(true);
    expect(isSqlToolCall(view({ name: "dbkit:explain_query" }), "postgres")).toBe(true);
  });
});

describe("dbTarget", () => {
  const base: DbTargetState = {
    activeId: "c1",
    connectedIds: new Set(["c1"]),
    connections: [conn({ id: "c1", kind: "mysql", database: "sakila" })],
    selectedNode: null,
  };

  it("連線設定的預設庫作為 database", () => {
    expect(dbTarget(base)).toEqual({ connectionId: "c1", database: "sakila", kind: "mysql", prod: false });
  });

  it("側欄選取的節點優先於連線設定的預設庫", () => {
    const node: SelectedNode = { type: "database", connId: "c1", db: "warehouse", kind: "mysql" };
    expect(dbTarget({ ...base, selectedNode: node })?.database).toBe("warehouse");

    const table: SelectedNode = {
      type: "table", connId: "c1", db: "reports", table: "daily", kind: "mysql", objKind: "table",
    };
    expect(dbTarget({ ...base, selectedNode: table })?.database).toBe("reports");
  });

  // 切換作用中連線不會清掉 selectedNode：拿 A 的庫名去當 B 的預設庫，工具只會安靜地查到零張表。
  it("屬於其他連線的選取節點要忽略", () => {
    const node: SelectedNode = { type: "database", connId: "c2", db: "other_db", kind: "postgres" };
    expect(dbTarget({ ...base, selectedNode: node })?.database).toBe("sakila");
  });

  it("選到的是連線節點（沒有 db）時退回連線設定的預設庫", () => {
    const node: SelectedNode = { type: "connection", connId: "c1" };
    expect(dbTarget({ ...base, selectedNode: node })?.database).toBe("sakila");
  });

  it("連線沒有預設庫（null / 空字串 / 純空白）時 database 為 null", () => {
    for (const database of [null, undefined, "", "   "]) {
      const s = { ...base, connections: [conn({ id: "c1", database })] };
      expect(dbTarget(s)?.database).toBeNull();
    }
  });

  it("沒有作用中連線時回 null（不給助手任何資料庫工具）", () => {
    expect(dbTarget({ ...base, activeId: null })).toBeNull();
  });

  // 沒連線的連線在後端根本沒有 pool，附上去只會讓模型收到一串 not connected 然後自行腦補結構。
  it("作用中連線尚未連線時回 null", () => {
    expect(dbTarget({ ...base, connectedIds: new Set() })).toBeNull();
    expect(dbTarget({ ...base, connectedIds: new Set(["c2"]) })).toBeNull();
  });

  it("activeId 在 connections 裡找不到（剛被刪掉）時回 null 而非丟例外", () => {
    expect(dbTarget({ ...base, connections: [] })).toBeNull();
  });

  it("prod 由 options.prod 決定（與 api.isProdConn 同一份判斷）", () => {
    const prod = { ...base, connections: [conn({ id: "c1", options: { prod: "1" } })] };
    expect(dbTarget(prod)?.prod).toBe(true);
    const notProd = { ...base, connections: [conn({ id: "c1", options: { prod: "0" } })] };
    expect(dbTarget(notProd)?.prod).toBe(false);
  });

  it("kind 原樣帶出（後端據此決定有哪些工具）", () => {
    const s = { ...base, connections: [conn({ id: "c1", kind: "mongo" })] };
    expect(dbTarget(s)?.kind).toBe("mongo");
  });

  it("多條連線時只看 activeId 那一條", () => {
    const s: DbTargetState = {
      activeId: "c2",
      connectedIds: new Set(["c1", "c2"]),
      connections: [conn({ id: "c1", database: "sakila" }), conn({ id: "c2", kind: "postgres", database: "app" })],
      selectedNode: null,
    };
    expect(dbTarget(s)).toEqual({ connectionId: "c2", database: "app", kind: "postgres", prod: false });
  });
});
