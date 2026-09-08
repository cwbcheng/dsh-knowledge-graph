# 扫描版 PDF 到知识图

这是一条独立 CLI 流水线：OCR、正文组装、分批抽取、确定性验收、显式导入 SQLite。
需要 Node 22.13+；OCR 另外需要 Python 3、PyMuPDF 和 rapidocr_onnxruntime。
它不会自动调用正在运行的 DSH 会话，也不会默认选择一个数据库写入。

## 1. OCR

```bash
python3 scripts/kg-pipeline/ocr_pdf.py \
  --pdf /path/to/scan.pdf --out-dir ./work/ocr --dpi 200 --jobs 4
```

每页完成后原子保存 `<stem>.progress.json`，它是续跑的权威状态。
再次执行同一命令只处理尚未完成的页；PDF 的 SHA-256、总页数、DPI 或 OCR 引擎标识
不匹配时拒绝复用。换源或重做时使用新目录，或显式传 `--restart`。

输出还包括 `<stem>.pages.json`、`<stem>.raw.jsonl` 和
`<stem>.pages.json.source.json`。原始行保留页码、边界框和置信度；来源清单记录
PDF 指纹、页数、缺页和输出文件校验和。投影文件中断写入后可由 progress 重建。
任何页失败都返回退出码 1；有意限制页范围但未完成全文返回 2，不会伪装成完整 OCR。
阅读顺序和识别准确性仍取决于 OCR 引擎，复杂版式需要人工抽查。

## 2. 保真组装正文

```bash
python3 scripts/kg-pipeline/assemble_text.py \
  --pages ./work/ocr/scan.pages.json --out ./work/scan-clean.json
```

默认保留所有非空 OCR 行，包括英文短词、数字、图注和页眉，不包含书名专用删除规则。
只将结构化标题独立成段，其余折行按中英文规则拼接。不得原地覆盖原始 pages 文件。
只有显式 `--drop-line '完整行正则'` 才删除匹配行，可重复传入；来源清单保留被删行、
清洗前后校验和，以及清洗段落到原始行的映射。偏移统一使用 UTF-16 代码单元，
可与 JavaScript 的 sourceText 偏移对应。使用旧 pages 文件时来源标为 unverified，
不能据此证明原 PDF 全页完整。

## 3. 抽取与可靠续跑

```bash
export KG_LLM_BASE_URL="http://your-provider/v1"
export KG_LLM_MODEL="your-model"
export KG_LLM_API_KEY="your-key"
node scripts/kg-pipeline/kg-extract.mjs \
  --pages ./work/scan-clean.json --out ./work/scan-graph.json --title "资料标题"
```

`paragraphs.mjs` 和 `normalize.mjs` 直接复用 Host 导出的无副作用契约，
不再复制切分、prompt、类型关系别名、证据认证和 invariant 校验逻辑。
每批新节点 ID 在合并前重编号，关系端点随同映射，不会因模型重复使用 n1 丢节点或接错边。
有原文引文只能证明来源可认证，不等于节点语义已被独立验证。

`<out>.partial.json` 保存完整累积图、每批状态、下一批游标、来源/模型/契约指纹和校验和。
写入失败会让命令失败。续跑显式加 `--resume`；已完成的图不会重新抽取或丢失节点。
失败批次最多尝试三次后停止，续跑从失败处重试。旧版、被破坏或源配置变化的 checkpoint
拒绝加载，不会只拿旧游标配一个空图继续。重做使用新输出路径或 `--restart`。

`--max-batches N` 是全程批次索引上限，不是本次新增批数；仍有未完成批次时退出码为 2，
模型/校验失败为 1，全部完成才为 0。部分和失败结果可检查，但不能发布到 SQLite。
模型请求的截止时间覆盖响应头及完整正文，并限制正文总字节数；
截断响应和无效 JSON 不会通过猜补括号伪装成成功。

## 4. 验收与显式落库

```bash
# 只验收，不创建数据库
node scripts/kg-pipeline/kg-import-and-verify.mjs \
  --graph ./work/scan-graph.json --dry-run

# 新文档，默认 expectedRevision = 0
node scripts/kg-pipeline/kg-import-and-verify.mjs \
  --graph ./work/scan-graph.json --db /path/to/knowledge.sqlite

# 替换已有文档，必须明确提交者所见版本
node scripts/kg-pipeline/kg-import-and-verify.mjs \
  --graph ./work/scan-graph.json --db /path/to/knowledge.sqlite --expected-revision 3
```

两个 CLI 导入入口和抽取器的 `--import` 共用 `src/kg-import.mjs`：
要求非空完整图和全文、拒绝部分生成/截断窗口、认证引文、校验关系类型约束，
并清除文件自带的验证授权。任何 blocking invariant 都拒绝整次导入。
候选节点允许保留，但不会被当作已验证事实；确定性检查不是语义准确率证明。

数据库目标必须通过 `--db` 或 `DSH_KG_DB` 明确指定。覆盖使用事务内 CAS，
省略 expectedRevision 不会读取当前版本后自动覆盖。抽取器
`--resume --import --db FILE` 的成功回执同时校验图内容、目标路径和数据库版本；
目标未变时不重复写入，目标已变时不静默覆盖。

## 历史版本与恢复

```bash
npm run kg -- list-revisions --db /path/to/knowledge.sqlite --id DOCUMENT_ID
npm run kg -- restore-revision --db /path/to/knowledge.sqlite \
  --id DOCUMENT_ID --revision 2 --expected-revision 5
```

每次覆盖在同一事务里保存上一版图和 source units 的快照；恢复产生新 revision，
不会改写版本历史。旧版只保存计数的记录明确标为不可恢复，不能补回此前已丢失的内容。
快照会随修改次数占用空间，应与数据库一起备份。候选审核记录不是该图快照的恢复对象。

## 回归验证与边界

`npm test` 包括流水线、CAS/历史列表、模拟 OCR 中断和 CRX 载荷一致性测试。
测试使用临时数据库和本地假模型，覆盖完整续跑、部分续跑、重复 ID、失败批重试、
伪引文、越权 verified、并发冲突、正文超时、写盘失败、缺页与来源不匹配。

历史上单本书得到的节点数、关系类型覆盖或引文命中率，不构成语义质量验收。
真实 PDF 的 OCR 质量、标题识别及图谱语义质量仍需独立的人工标注样本评估；
本轮修复不会重新抽取或覆盖已经部署的文档。
