const path = require("path");

// 仅用于在生成的数据中标记来源说明，不再直接抓取该 URL。
// 实际论文列表由 scripts/fetch_papers.js 通过 arXiv API 拉取。
const SOURCE_URL = "arXiv API: auto-driving + embodied navigation/manipulation";
const OUTPUT_PATH = path.join("data", "papers.json");
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 60);
const LLM_ENABLE = String(process.env.LLM_ENABLE || "true") !== "false";

const LLM_PROVIDER = process.env.LLM_PROVIDER || "dashscope";
const LLM_MODEL = process.env.LLM_MODEL || "qwen-max";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

module.exports = {
  SOURCE_URL,
  OUTPUT_PATH,
  MAX_ITEMS,
  LLM_ENABLE,
  LLM_PROVIDER,
  LLM_MODEL,
  LLM_API_KEY,
};
