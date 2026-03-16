const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const pdfParse = require("pdf-parse");
const { SOURCE_URL, OUTPUT_PATH, MAX_ITEMS } = require("./config");
const { runConcurrent, filterByRelevance, generateSummary, generateDetailedSummary } = require("./llm");
const { normalizeArxivId, normalizeArxivInput } = require("./arxiv");

/* ── helpers ─────────────────────────────────────────── */

const stripTags = (value) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const readExisting = (filePath) => {
  if (!fs.existsSync(filePath)) return { items: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.warn("Failed to parse existing data, will regenerate.");
    return { items: [] };
  }
};

/* ── fetch candidate papers from arXiv API ───────────── */

// 从 arXiv Atom Feed 中解析出 entry 列表
const extractEntriesFromAtom = (xml) => {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/i);
    const id = idMatch ? idMatch[1].trim() : "";
    if (!id || !id.includes("arxiv.org/abs/")) continue;

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : "arXiv Paper";

    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/i);
    const date = publishedMatch ? publishedMatch[1].trim().slice(0, 10) : "";

    const authorNames = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map(
      (m) => stripTags(m[1])
    );
    const authors = authorNames.join(", ");

    const catMatch = entry.match(/<category[^>]*term=["']([^"']+)["']/i);
    const category = catMatch ? catMatch[1].trim() : "";

    entries.push({
      url: id,
      title,
      date,
      authors,
      category,
    });

    if (entries.length >= MAX_ITEMS) break;
  }
  return entries;
};

// 构造针对自动驾驶 + 具身智能的搜索查询，并从 arXiv API 拉取候选论文
const fetchCandidateItemsFromArxiv = async () => {
  const baseUrl = "https://export.arxiv.org/api/query";
  // 关注 cs.RO / cs.CV / cs.LG 中，带有自动驾驶 / 具身 / 导航 / 抓取等关键词的论文
  const searchQuery =
    '((cat:cs.RO OR cat:cs.CV OR cat:cs.LG) AND (all:"autonomous driving" OR all:"end-to-end driving" OR all:"self-driving" OR all:"embodied" OR all:"embodied navigation" OR all:"navigation" OR all:"grasping" OR all:"manipulation"))';

  const params = new URLSearchParams({
    search_query: searchQuery,
    sortBy: "submittedDate",
    sortOrder: "descending",
    max_results: String(MAX_ITEMS * 2), // 多抓一点，后面再用 LLM 过滤
  });

  const url = `${baseUrl}?${params.toString()}`;
  console.log(`\n========== Phase 1: 从 arXiv API 抓取候选论文 ==========`);
  console.log(`Query URL: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch arXiv API: ${res.status}`);
  }
  const xml = await res.text();
  const items = extractEntriesFromAtom(xml);
  console.log(`从 arXiv API 解析到 ${items.length} 篇候选论文`);
  return items;
};

/* ── fetch arXiv HTML full text and images ────────────── */

const fetchArxivHtmlLink = async (absUrl) => {
  try {
    const r = await fetch(absUrl, { redirect: "follow" });
    if (!r.ok) return null;
    const html = await r.text();
    // Look for: <a href="https://arxiv.org/html/XXXX" ... id="latexml-download-link">
    const m = html.match(
      /<a[^>]*href=["'](https:\/\/arxiv\.org\/html\/[^"']+)["'][^>]*id=["']latexml-download-link["']/i
    );
    if (m) return m[1];
    // fallback: any link to arxiv.org/html/
    const m2 = html.match(
      /href=["'](https:\/\/arxiv\.org\/html\/[^"']+)["']/i
    );
    return m2 ? m2[1] : null;
  } catch {
    return null;
  }
};

const fetchArxivContent = async (htmlUrl) => {
  try {
    const r = await fetch(htmlUrl, { redirect: "follow" });
    if (!r.ok) return { fullText: "", imageUrls: [] };
    const html = await r.text();

    // Extract all image URLs (relative → absolute)
    const baseUrl = htmlUrl.endsWith("/") ? htmlUrl : htmlUrl + "/";
    const imgMatches = [...html.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*/gi)];
    const imageUrls = imgMatches
      .map((m) => m[1])
      .filter((src) => !src.startsWith("data:"))
      .map((src) => {
        if (src.startsWith("http")) return src;
        return new URL(src, baseUrl).href;
      });

    // Extract text content
    const fullText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    return { fullText, imageUrls };
  } catch (e) {
    console.warn(`Failed to fetch arXiv HTML: ${e.message}`);
    return { fullText: "", imageUrls: [] };
  }
};

const fetchAbsPageMeta = async (absUrl) => {
  try {
    const r = await fetch(absUrl, { redirect: "follow" });
    if (!r.ok) return null;
    const html = await r.text();

    const titleM = html.match(/<meta\s+name=["']citation_title["']\s+content=["']([^"']+)["']/i);
    const title = titleM ? titleM[1] : "arXiv Paper";

    const authorMs = [...html.matchAll(/<meta\s+name=["']citation_author["']\s+content=["']([^"']+)["']/gi)];
    const authors = authorMs.map((m) => m[1]).join(", ");

    const dateM = html.match(/<meta\s+name=["']citation_date["']\s+content=["']([^"']+)["']/i);
    const date = dateM ? dateM[1] : "";

    const catM = html.match(/primary-subject[^>]*>([^<]+)</i);
    const category = catM ? catM[1].trim() : "Robotics";

    return { title, authors, date, category };
  } catch {
    return null;
  }
};

/* ── build detail HTML page for a paper ──────────────── */

const buildDetailPage = (paper) => {
  const bodyHtml = marked.parse(paper.detailedSummary || "", {
    breaks: true,
    gfm: true,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${paper.title} - Robotics arXiv Daily</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet"/>
  <link rel="stylesheet" href="../assets/styles.css"/>
  <link rel="stylesheet" href="../assets/detail.css"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"/>
</head>
<body>
  <div class="bg-orbit"></div>
  <header class="site-header">
    <div class="brand">
      <a href="../index.html" class="back-link">← 返回列表</a>
    </div>
  </header>
  <main class="detail-main">
    <article class="detail-card">
      <span class="detail-category">${paper.category || "Robotics"}</span>
      <h1>${paper.title}</h1>
      <div class="detail-meta">
        <span>arXiv: <a href="${paper.url}" target="_blank" rel="noreferrer">${paper.arxivId}</a></span>
        <span>作者: ${paper.authors || "--"}</span>
        <span>日期: ${paper.date || "--"}</span>
      </div>
      <section class="detail-body">
        <h2>📝 详细解读</h2>
        ${bodyHtml || "<p>摘要生成中...</p>"}
      </section>
      <section class="detail-tldr">
        <h2>💡 一句话总结</h2>
        <p>${paper.summary || "暂无"}</p>
      </section>
      <div class="detail-actions">
        <a href="${paper.url}" target="_blank" rel="noreferrer" class="btn">查看 arXiv 原文</a>
        <a href="../index.html" class="btn btn-outline">返回列表</a>
      </div>
    </article>
  </main>
  <footer class="site-footer">
    <span>数据抓取来源于 Robotics arXiv Daily</span>
    <span>本页由 GitHub Actions 定时更新</span>
  </footer>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})"></script>
</body>
</html>`;
};

/* ── enrich items with summaries (incremental save) ──── */

const SUMMARY_CONCURRENCY = 16; // parallel paper processing

const buildOutput = async (items, existing, outputPath, pagesDir) => {
  const existingMap = new Map(
    (existing.items || []).map((item) => [item.url, item])
  );

  const generatedAt = new Date().toISOString();

  // Separate cached vs new
  const cached = [];
  const toProcess = [];
  for (const item of items) {
    const previous = existingMap.get(item.url);
    if (previous?.summary && previous?.detailedSummary) {
      cached.push({
        ...previous,
        title: item.title,
        date: item.date,
        authors: item.authors,
        category: item.category,
        updatedAt: generatedAt,
      });
    } else {
      toProcess.push({ item, previous });
    }
  }

  console.log(`  Cached (skip): ${cached.length}, Need LLM: ${toProcess.length}`);

  // All completed papers (cached + newly done) — shared across workers
  const allDone = [...cached];

  // Helper: save current progress to disk
  const saveProgress = () => {
    const payload = { generatedAt, source: SOURCE_URL, items: [...allDone] };
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  };

  // Save cached papers immediately
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(pagesDir, { recursive: true });
  saveProgress();

  if (toProcess.length === 0) {
    return { generatedAt, source: SOURCE_URL, items: allDone };
  }

  let doneCount = 0;
  const total = toProcess.length;

  const tasks = toProcess.map(({ item, previous }) => async () => {
    const arxivId = normalizeArxivId(item.url);

    // Fetch full text from arXiv HTML page
    const absUrl = item.url.replace("http://", "https://");
    const htmlLink = await fetchArxivHtmlLink(absUrl);
    let fullText = "";
    let imageUrls = [];
    let noHtmlAvailable = false;
    if (htmlLink) {
      const content = await fetchArxivContent(htmlLink);
      fullText = content.fullText;
      imageUrls = content.imageUrls;
    } else {
      noHtmlAvailable = true;
    }

    const NO_HTML_MSG = "目标不存在html界面，获取失败……";

    const summary = noHtmlAvailable
      ? NO_HTML_MSG
      : (previous?.summary ||
        (await generateSummary({ title: item.title, fullText })));
    const detailedSummary = noHtmlAvailable
      ? NO_HTML_MSG
      : (previous?.detailedSummary ||
        (await generateDetailedSummary({ title: item.title, fullText, imageUrls })));
    const tags = previous?.tags || (item.category ? [item.category] : []);

    const paper = {
      id: item.url,
      title: item.title,
      url: item.url,
      arxivId,
      date: item.date,
      authors: item.authors,
      category: item.category,
      summary,
      detailedSummary,
      imageUrls,
      tags,
      updatedAt: generatedAt,
    };

    // Immediately save this paper
    allDone.push(paper);
    saveProgress();

    // Generate detail page immediately
    const pageHtml = buildDetailPage(paper);
    const fileName = `${arxivId.replace(/[\/\\]/g, "_")}.html`;
    fs.writeFileSync(path.join(pagesDir, fileName), pageHtml);

    doneCount++;
    const pct = ((doneCount / total) * 100).toFixed(0);
    console.log(`  [Summary ${doneCount}/${total} ${pct}%] ${item.title}  (text:${fullText.length} imgs:${imageUrls.length}) ✓ saved`);

    return paper;
  });

  console.log(`  Starting ${total} summaries with concurrency=${SUMMARY_CONCURRENCY}...`);
  await runConcurrent(tasks, SUMMARY_CONCURRENCY);

  return { generatedAt, source: SOURCE_URL, items: allDone };
};

const saveIndex = (payload) => {
  const indexItems = payload.items.map((p) => ({
    id: p.id,
    title: p.title,
    arxivId: p.arxivId,
    date: p.date,
    authors: p.authors,
    category: p.category,
    summary: p.summary,
    tags: p.tags,
    updatedAt: p.updatedAt,
  }));
  const indexPath = path.resolve(__dirname, "..", "data", "papers-index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({ generatedAt: payload.generatedAt, source: payload.source, items: indexItems })
  );
  console.log(`Index file saved to data/papers-index.json (${(Buffer.byteLength(JSON.stringify({generatedAt: payload.generatedAt, source: payload.source, items: indexItems})) / 1024).toFixed(0)} KB)`);
};

/* ── main ────────────────────────────────────────────── */

const main = async () => {
  const outputPath = path.resolve(__dirname, "..", OUTPUT_PATH);
  const pagesDir = path.resolve(__dirname, "..", "papers");
  const forceArxivInput = (process.env.FORCE_ARXIV_INPUT || "").trim();
  const forceAddSingle = /^(1|true|yes)$/i.test(String(process.env.FORCE_ADD_SINGLE || ""));

  if (forceArxivInput && forceAddSingle) {
    console.log(`\n========== Force Add 模式 ==========`);

    const normalized = normalizeArxivInput(forceArxivInput);
    if (!normalized) {
      throw new Error(`Invalid FORCE_ARXIV_INPUT: ${forceArxivInput}`);
    }

    const existing = readExisting(outputPath);
    const existingById = new Map(
      (existing.items || [])
        .map((item) => {
          const id = normalizeArxivId(item.arxivId || item.url || item.id || "");
          return id ? [id, item] : null;
        })
        .filter(Boolean)
    );

    if (existingById.has(normalized.arxivId)) {
      console.log(`论文已存在: ${normalized.arxivId}，跳过新增。`);
      return;
    }

    const meta = await fetchAbsPageMeta(normalized.absUrl);
    if (!meta) {
      throw new Error(`Failed to fetch metadata from ${normalized.absUrl}`);
    }

    const forcedItem = {
      url: normalized.absUrl,
      title: meta.title,
      date: meta.date,
      authors: meta.authors,
      category: meta.category,
    };

    console.log(`准备强制新增论文: ${forcedItem.title}`);

    const payload = await buildOutput([forcedItem], existing, outputPath, pagesDir);
    const oldPapers = (existing.items || []).filter((paper) => {
      const id = normalizeArxivId(paper.arxivId || paper.url || paper.id || "");
      return id !== normalized.arxivId;
    });

    payload.items = [...payload.items, ...oldPapers];
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    saveIndex(payload);

    console.log(`\n========== 完成 ==========`);
    console.log(`Force add 完成: ${normalized.arxivId}`);
    return;
  }

  if (forceArxivInput && !forceAddSingle) {
    console.log("FORCE_ARXIV_INPUT 已提供，但 FORCE_ADD_SINGLE 未开启，忽略单篇强制入库参数。");
  }

  // Phase 1: 从 arXiv API 拉取候选论文（自动驾驶 + 具身导航/抓取相关）
  const allItems = await fetchCandidateItemsFromArxiv();

  const existing = readExisting(outputPath);

  // ── incremental filtering with cache ──────────────────
  console.log(`\n========== Phase 2: 过滤 ==========`);
  const cachePath = path.resolve(__dirname, "..", "data", "filter_cache.json");
  let filterCache = { kept: [], rejected: [] };
  try {
    if (fs.existsSync(cachePath)) {
      filterCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    }
  } catch { /* ignore */ }

  const knownUrls = new Set([
    ...(filterCache.kept || []),
    ...(filterCache.rejected || []),
  ]);
  const existingUrls = new Set((existing.items || []).map((i) => i.url));

  // Split into already-known and truly-new papers
  const alreadyKept = [];
  const newItems = [];
  for (const item of allItems) {
    if (existingUrls.has(item.url) || (filterCache.kept || []).includes(item.url)) {
      alreadyKept.push(item);
    } else if ((filterCache.rejected || []).includes(item.url)) {
      // previously rejected → skip
    } else {
      newItems.push(item);
    }
  }

  console.log(`Already processed: ${alreadyKept.length}, New to filter: ${newItems.length}`);

  let newlyKept = [];
  if (newItems.length > 0) {
    console.log(`Filtering ${newItems.length} new papers by relevance...`);
    newlyKept = await filterByRelevance(newItems);
    console.log(`${newlyKept.length} / ${newItems.length} new papers passed filter`);

    // Update cache
    const newlyKeptUrls = new Set(newlyKept.map((i) => i.url));
    filterCache.kept = [...new Set([...(filterCache.kept || []), ...newlyKeptUrls])];
    filterCache.rejected = [
      ...new Set([
        ...(filterCache.rejected || []),
        ...newItems.filter((i) => !newlyKeptUrls.has(i.url)).map((i) => i.url),
      ]),
    ];
  } else {
    console.log(`No new papers to filter`);
  }

  const items = [...alreadyKept, ...newlyKept];
  console.log(`过滤完成，共 ${items.length} 篇来自源页面的相关论文`);

  // Save filter cache immediately after filtering
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(filterCache, null, 2));
  console.log(`过滤缓存已保存到 data/filter_cache.json`);

  // ── Merge back old papers not on the current source page ──
  const currentUrls = new Set(items.map((i) => i.url));
  const oldPapers = (existing.items || []).filter((p) => !currentUrls.has(p.url || p.id));
  console.log(`保留 ${oldPapers.length} 篇历史论文（不在当前源页面上）`);

  console.log(`\n========== Phase 3: 生成摘要 ==========`);
  const payload = await buildOutput(items, existing, outputPath, pagesDir);

  // Append old papers that are no longer on the source page
  payload.items = [...payload.items, ...oldPapers];

  // Final save (ensure consistency)
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  // Generate lightweight index for fast main-page loading
  saveIndex(payload);

  console.log(`\n========== 完成 ==========`);
  console.log(
    `Saved ${payload.items.length} papers to ${OUTPUT_PATH} + detail pages`
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
