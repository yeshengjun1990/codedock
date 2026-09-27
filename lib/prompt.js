/**
 * The one-liner users hand to a web agent to get it connected.
 *
 * Kept in a single place so the control panel and the onboarding page can never
 * drift apart, and so the wording is easy to tune in one spot.
 *
 * Why this is enough for an agent to get going: a single `initialize` call
 * returns the full usage rules in the `instructions` field, and `tools/list`
 * returns the tool surface. The agent does not need anything else.
 */

function buildConnectionPrompt({ endpoint, guideTextUrl }) {
  const lines = [
    "快速连接这个 MCP，明确使用规则、熟悉可用工具，做好处理接下来一系列工作的准备。",
    "",
    `MCP 地址：${endpoint}`,
    "（所有请求都以 POST + Content-Type: application/json 发送 JSON-RPC：第一个请求发 initialize 会返回完整使用规则，再用 tools/list 获取工具清单。）",
  ];

  if (guideTextUrl) {
    lines.push("", `需要完整握手示例时读取：${guideTextUrl}`);
  }

  return lines.join("\n");
}

module.exports = { buildConnectionPrompt };
