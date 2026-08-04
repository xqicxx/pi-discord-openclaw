// /reasoning command — ported from openclaw reasoning commands (对照遗漏).
// openclaw 文档: /reasoning stream 流式思考到 live preview，生成后删除预览；
//            /reasoning on 保留思考可见；/reasoning off 不显示思考。

export type ReasoningCommand =
  | { kind: "stream" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "unknown"; arg: string };

/** 解析 /reasoning <arg> 命令。 */
export function parseReasoningCommand(arg?: string): ReasoningCommand {
  const trimmed = (arg ?? "").trim().toLowerCase();
  switch (trimmed) {
    case "stream":
      return { kind: "stream" };
    case "on":
      return { kind: "on" };
    case "off":
      return { kind: "off" };
    default:
      return trimmed ? { kind: "unknown", arg: trimmed } : { kind: "stream" };
  }
}
