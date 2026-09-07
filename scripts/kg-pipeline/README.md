# 扫描版 PDF → 知识图流水线（closed-loop）

本目录补上了 `dsh-knowledge-graph` 的一个缺口：**扫描版（纯图像）PDF 无从进入知识图**。

仓库的 `src/index.host.js` 只消费「已有可搜索文本层」的文档（README 明说
「扫描版 PDF 当前不做 OCR」），并且真正的图谱抽取需要在一个活跃的 DSH 会话里
由注入的 `kgExtractor`（LLM）完成。对一个 350 页、`get_text()` 全空的扫描版书籍，
这两步都不存在，因此「扫描版 PDF → 知识图」没有闭环。

下面这条流水线把这两段补上：**OCR → 组装正文 → 段落切分 → LLM 批量抽取 →
schema 规范化 → 图装配 → SQLite 落盘**。所有图结构与证据契约都与仓库 host/client
严格一致（8 类节点 / 12 类关系、`[P数字]` 内容单元、`quote` 逐字认证、`saveGraph`
校验），保证落库后的文档能被插件自身加载、渲染、往返定位。

## 阶段总览

```
scan.pdf
   │  (1) ocr_pdf.py                  每页 get_pixmap(dpi)（应用旋转）+ RapidOCR(中文)
   ▼
pages.json  { "1": "…", "2": "…" }
   │  (2) assemble_text.py            组段、去页眉/页脚/图注噪声、修复行尾断词
   ▼
learn-clean.json                      每页重排成真实段落（\n\n 分隔）
   │  (3) kg-extract.mjs              读 → paragraphs.mjs 切分 → buildSourceManifest →
   │                                  llm-client.mjs 逐块调用(同 SYSTEM_PROMPT) →
   ▼                                  normalize.mjs 规范化 → 组装 graph JSON
learn-graph.json
   │  (4) kg-import-and-verify.mjs    用仓库 src/kg-store.mjs saveGraph 落盘 + 体检
   ▼
knowledge-graph.sqlite
```

## 步骤

### 1. OCR（需要 Python + RapidOCR）
```bash
python scripts/kg-pipeline/ocr_pdf.py \
  --pdf "/path/to/scan.pdf" --out-dir scripts/kg-pipeline/work --dpi 200 --jobs 8
```
- 用 `fitz.get_pixmap(dpi=...)` 渲染：PyMuPDF 会应用页面旋转矩阵，OCR 结果按
  左→右 / 上→下的正确阅读顺序返回。
- 用 `rapidocr_onnxruntime`（内置 PP-OCRv4 中文模型）识别，无需联网、无外部二进制。
- 产出 `<stem>.pages.json`（每页文本）、`<stem>.raw.jsonl`、`<stem>.progress.json`；
  页码更靠后、中途中断也支持续跑。

### 2. 正文组装（去噪、重排段落）
```bash
python scripts/kg-pipeline/assemble_text.py \
  --pages scripts/kg-pipeline/work/learn-clean.json \
  --out  scripts/kg-pipeline/work/learn-clean.json
```
- 把一页内的 OCR 行重组成真实段落：丢弃页眉/页脚（如 `44|学习观：从感觉懂了到真正学会`）、
  图注（`图6-3…`）、插图标签（`Message`、`doupnins` 等噪声）。
- 只把**结构化标题**（`第X部分/章/节`、`01 何以避害` 等）单独成段，其余换行当作
  同一段落的折行拼接，交给下游切分器细化，从而显著提升证据 quote 的落地率
  （本仓库测试：同一批 3 页在清洗前 15 warnings / 18 边，清洗后 3 warnings / 29 边）。

### 3. LLM 抽取与图装配
```bash
node scripts/kg-pipeline/kg-extract.mjs \
  --pages scripts/kg-pipeline/work/learn-clean.json \
  --out  scripts/kg-pipeline/work/learn-graph.json \
  --title "学习观：从感觉懂了到真正学会"
```
- `paragraphs.mjs` 是对 host `splitParagraphs*` 的**逐字移植**：`[P数字]` 内容单元的
  编号与 host/client 完全一致，因此节点/关系的 `paragraph` 与 `quote` 证据能双方解析。
- `llm-client.mjs` 是缺失的**独立 LLM 客户端**：只做 OpenAI 兼容的
  `/v1/chat/completions`，从 `KG_LLM_API_KEY` 或 `~/.dsh/.credentials.yaml` 里读
  bearer token，无 DSH 会话也能调用。可用 `KG_LLM_BASE_URL` / `KG_LLM_MODEL` 切换。
- `normalize.mjs` 是对 host `normalizeGraph` + `exactOrUniqueTypographicQuote` 的
  移植：type/relation 走同一 alias 表；fact/claim/inference/rule/definition/
  counter_example 的 `quote` 必须在对应段落里唯一认证，否则降级为
  `unsupported/candidate`；每条边必须有直接证明该关系的证据 quote，否则丢弃。
- 模型 prompt 与仓库 `SYSTEM_PROMPT` 完全一致，保证 8 类节点 / 12 类关系的语义契约。
- 产出 `learn-graph.json`（含 `source`、`sourceText`、`sections`、`staging.chunks`、
  `nodes`、`edges`、`revision`），可直接喂给 `saveGraph`。
- `--max-batches N`、`--resume`（读取 `*.partial.json` 续跑）可用于受控分批。

### 4. 落库与体检
```bash
node scripts/kg-pipeline/kg-import-and-verify.mjs \
  --graph scripts/kg-pipeline/work/learn-graph.json \
  --db   /path/to/knowledge-graph.sqlite
```
- 复用仓库 `src/kg-store.mjs` `saveGraph`（含 `sourceUnits`），落库后的文档与 host
  自己写入的规范形状一致：`documents`、`document_units`、`chunks`、`graph_nodes`、
  `graph_edges`、`entity_candidates`、`claim_candidates`、`graph_revisions`。
- 顺带体检：悬空/自环边、grounding 分布、`quote` 认证、孤立节点、边/节点比。

## 模型选择
默认 `KG_LLM_MODEL=gpt-5.6-sol`（本地代理 `http://192.168.3.252:8317/v1`，已验证），
也支持任意 OpenAI 兼容端点。若用多模态模型，也可在 OCR 阶段直接以图输入，但纯文本
OCR + 文本抽取的组合在此更省 token、更可控。

## 结果（本书实际跑通）

以《学习观：从感觉懂了到真正学会》（于建国 YJango，350 页扫描版）为例，完整流水线产出：

| 指标 | 值 |
|---|---|
| 扫描页数 | 350（`get_text()` 全空，纯图像） |
| OCR 字符数 | 约 197k |
| 内容单元（paragraphs） | 5226 |
| 抽取批块（chunks） | 33 |
| 章节（sections） | 2092 |
| 节点 | 1144（claim 467 · definition 209 · example 166 · rule 115 · concept 111 · fact 12 · inference 7） |
| 关系 | 918（supports 223 · example 239 · defines 132 · causes 92 · contains 65 · is_a 47 · aims_at 36 · driven_by 29 · analogy 20 · not_is 19 · infers 15 · counter_example 1） |
| 悬空/自环边 | 0 |
| 越界段落索引 | 0 |
| grounded 已认证节点 | 1087 / 1144（≈95%；其余按保守策略标为 `unsupported`） |
| 证据 quote 可回链原文 | 1087 / 1087（全部可在 sourceText 中定位，UI 可双向定位） |
| 落库 | `knowledge-graph.sqlite`（8MB，`saveGraph` 原生写入） |

关系覆盖了 12 种允许关系中的全部 12 种，说明语义契约（8 类节点 / 12 类关系）被严格遵守，
核心概念（经验预测、类固有观、判别模型、预测能力等）成为高连接度枢纽节点。

## 为什么这样设计
- **契约复刻**：段落切分、类型/关系别名、quote 认证、`saveGraph` 校验都逐一对应到
  host 源码，而不是另造一套 schema。这样落库的文档才能被插件「加载 → 渲染 → 定位 →
  验证 → 导出」而不需要改动插件本体。
- **正确而保守**：宁可因证据不足丢弃一条边、把一个节点标为 `unsupported`，也不虚构
  一条没有原文支撑的关系。这是本仓库的一贯原则（见 `normalizeGraph` 注释）。
- **可复用**：脚本全部落在 `scripts/kg-pipeline/` 下，可对任意扫描版文档跑通
  「OCR → 正文 → 图 → 落库」，而不只是本书。
