# dsh-knowledge-graph

**[中文](README.md) | [English](README.en.md)**

**DSH（DeepSeek Harness）Cordis 插件**：把任意一段资料正文——或一段 AI 会话执行轨迹——用 AI 拆解成一张**知识图**，并在**知识图与原文之间双向定位**。


> 贴原文 → AI 异步拆图 → 双向锚点定位。是 NovelStudio「资料 ⇄ 知识图」落地为独立、可复用插件的形态。

---

## 它能做什么

- **AI 异步拆分**：输入任意正文（章节、技术文档、学习笔记…），后台任务模式调用 LLM，约 15–40 秒返回一张知识图。支持最长约 100 万字符的书级正文；Host 按内容块分批处理，并生成确定性的来源 ID、章节地图、chunk ID 与逐节点 evidence。常驻模式把全文、canonical graph 与无损 checkpoint 保存在 SQLite；刷新后浏览器只凭 `documentId/runId` 恢复，只有 Host 重启遗留的 `running` 任务才允许从 checkpoint 续跑，显式 `failed/cancelled` 任务绝不自动重试。
- **7 类节点 / 6 类关系**：
  - 节点：`fact` 事实 · `inference` 推论 · `concept` 概念 · `definition` 定义 · `example` 例子 · `counter_example` 反例 · `rule` 规则。
  - 关系：`supports` 支持 · `example` 例子 · `counter_example` 反例 · `defines` 定义 · `infers` 推断 · `causes` 因果。
- **双向定位**：
  - 点击**图中节点** → 弹出**详情卡片**（完整内容 + 原文摘录 + 定位按钮），并平滑滚动高亮到原文对应内容单元；
  - 点击**原文内容单元** → 图中居中聚焦并闪烁对应节点。
  - 图中节点只展示前 4 行（超出以 `…` 省略），**完整内容随时可在详情卡片中查看**；
  - 锚点以 AI 直接输出**内容单元编号**为主（确定性索引，长自然段会按句子边界切分成多个编号单元），quote 精确匹配与 token 重合度兜底；无法回链的节点不猜测偏移，统一进入诊断列表。
- **图渲染**：SVG 画布 + 7 类配色 / **4 种可切换布局形态**（图右上角下拉，选择记忆）：**力导向**（d3-force 开源引擎内嵌零依赖：碰撞防节点重叠、边-节点排斥防箭头穿节点）、**圆形**、**放射**（中心枢纽 + BFS 环，边走**折线**：径向出线 → 外环弧 → 径向进线）、**分层**（边走**直角正交折线**：行间空通道 + 逐行避障走廊，线段保证不穿节点）/ 关系边带类型标签，且**同源边按目标角度扇形弯曲**（二次贝塞尔）/ 拖拽平移 / Ctrl+滚轮缩放 / 工具栏 `− 100% +`（50%–200% 步进 10%）/ 长按节点查看原文摘录 / 键盘可达。
- **验证与质疑知识图**：生成图后可以检查它是否忠于原文——
  - **⚡ 快速体检**：本地规则即时检查（自环/悬空边、quote 能否在原文定位、段落编号与摘录位置是否一致、类型-关系语义规则、重复/疑似矛盾节点、孤立节点、覆盖统计），0 秒返回问题报告；
  - **🤖 AI 深度审校**：异步调用 LLM 逐节点/逐边**找茬**，所有 issue 必须以原文摘录为证据，标准档还会二次复核过滤误报；
  - **人工闭环**：问题按「错误 / 警告 / 建议」列出，点击问题 → 图中相关节点/边按严重度着色高亮并滚动定位原文；每条问题可**采纳修复**（改动立即应用并写入审计记录）或**忽略**；面板顶部提供**一键修复**，批量应用全部可自动修复的问题；修复记录逐条显示**旧值 → 新值**的具体差异；
  - **主动质疑**：节点详情卡可点「质疑此节点」，选中边后出现关系详情卡可点「质疑此关系」，也可在验证面板直接向整张图提问/质疑，AI 给出「图成立 / 质疑成立 / 证据不足 / 超出范围」判定与原文证据；
  - **🔎 外部事实核查原文**：把知识图中的 fact/inference/rule/definition/counter_example 节点转为**可核查断言**，用 Wikipedia 等外部证据裁决原文是否可靠；面板支持**粘贴领域规则来源**（法条、制度、教材、标准），规则文本与 Wikipedia 证据共同参与裁决；判定为「支持 / 矛盾 / 部分支持 / 证据不足 / 无法核查 / 超出范围」，每条结论绑定证据链接与证据引文（引文必须能在检索结果中定位，编造引文会被自动降级）；点击断言可回链图中节点与原文段落；
  - **追加拆分后自动标记验证/核查结果过期**，可重新验证或核查；轨迹知识图支持同样的全部验证/质疑/外部核查能力。
- **浮动工作台**：窗口可拖动、可调整大小；原文与知识图的**宽度比例**、**结果区高度**均可拖拽调整并记忆。
- **划线拆分**：**在聊天消息里**用鼠标选中任意一段文字，选区上方浮出「拆成知识图」按钮，点击即自动打开工作台并拆分所选文字；在结果页原文里划线选中可拆成子图；输入框里选中部分文字也可「拆分所选」。
- **追加拆分（增量合并）**：已有拆分结果后，输入区主按钮变为「追加拆分」——粘贴下一段/下一份资料，AI 只抽取新增内容，并自动与已有图建立**跨段关系边**（同一概念不重复建节点，直接连线到已有节点）；结果原地合并、全文段落统一编号、历史记录原地更新。聊天划线选中文字时也会自动追加到当前图。
- **历史记录**：每次成功拆分自动记录（最多 20 条、同文去重、可单删 / 清空）；浏览器只保存 `documentId`、标题、计数等轻量索引，回看时从 Host/SQLite 重新载入正文与 canonical graph，避免把书级正文复制进 `localStorage`。
- **章节过滤与候选审核**：结果区按章节筛选图节点和原文段落；候选实体 / 声明面板展示 evidence，可一键标记「待审核 / 已接受 / 已驳回」，状态通过 Host 同步到 SQLite（动态插件在 Host 会话中保留，失败时回退浏览器 localStorage），并可点击候选回链原文。
- **知识图导出**：结果工具栏可导出当前渲染图为高清 PNG 图片，也可导出完整 JSON（保留 source、chunk、evidence、验证报告和审计记录）以及节点 CSV、关系 CSV；数据导出的是完整图，不受当前章节筛选影响。轨迹知识图也支持相同导出。
- **常驻入口**：每个对话的标题右侧常驻「知识图」按钮，一键打开；运行卡片内也有启动条。
- **轨迹知识图（会话视图标签页）**：对话区新增第三个标签页「轨迹知识图」（位于 对话 / 轨迹 旁），一键把**当前会话的完整执行轨迹**（用户消息、工具调用、工具结果、AI 回复）拆成知识图——可视化这个 Agent **查到了什么事实、做出了什么推论、用了什么方法**，并在图与轨迹事件之间**双向定位**（点击节点滚动到对应事件，点击事件在图中聚焦对应节点）。结果按会话自动保存：**切换标签页或刷新页面后原样恢复**，拆分进行中切走再切回会自动续接轮询；会话继续产生新事件后，可点 **追加新事件** 只拆解新增部分并增量合并（跨事件建立关系边）；轨迹事件列与图列的宽度、结果区高度均可拖拽调整并记忆。

## 界面一览

<img width="1538" height="945" alt="image" src="https://github.com/user-attachments/assets/824ab99b-d291-4d06-8eb7-b91e947b1af4" />

```
┌─────────────────────────────── 浮动工作台 ───────────────────────────────┐
│ ● 知识库 · 资料 ⇄ 知识图                                      [ × ]        │
│ 知识库                                                                      │
│ 把任意资料用 AI 拆成「事实/推论/概念/定义/例子/反例/规则」知识图… [历史][重新开始]│
│ [输入资料 ─────────── 收起 ▴]                                                │
│ [原文 ⇄ 知识图]                                                             │
│ 一句话总结：…                                                              │
│ N 节点 · M 关系 · 可回链 X/Y ─────────────────────────┐                    │
│ [原文段落…带类型徽标]  ‖  [知识图 SVG…]  [− 100% +]  │ ← 可拖宽竖条         │
│ ─────────────── 可拖高横条 ────────────────           │                    │
└─────────────────────────────────────────────────────────────────────────┘
```

对话区「轨迹知识图」标签页：

<img width="3377" height="1720" alt="image" src="https://github.com/user-attachments/assets/5dfef153-25a0-431e-970c-dc344eef53d5" />


```
┌────────────────────────── 轨迹 ⇄ 知识图 ──────────────────────────┐
│ 拆解本会话轨迹：用户消息 / 工具调用 / 工具结果 / AI 回复            │
│ 一句话总结：…                                                     │
│ [轨迹事件…带类型徽章]  ‖  [知识图 SVG…]  [− 100% +]  ← 可拖宽竖条  │
│ ──────────── 可拖高横条 ────────────                              │
│ （切换标签页 / 刷新页面后结果自动恢复）                            │
└────────────────────────────────────────────────────────────────────┘
```

## 安装

这是一个 **DSH 动态 Cordis 插件**：一份 Host 代码（Node 进程）+ 一份 Client 代码（浏览器），纯 JS、零依赖、无需构建。通过 DSH Web 界面的 Cordis 插件机制加载，步骤适用于任何 DSH Web 会话。

### 0. 前置条件

- 已启动 **DSH Web**（`dsh web`）并进入任意会话；
- 环境中已配置 **AI 模型提供方**（设置 → 模型，或 `agentDefaultModel`）。插件默认跟随系统当前模型；工作台与「轨迹知识图」顶部均提供模型下拉框，可手动指定拆分、追加、AI 审校、质疑与外部核查使用的模型（选择会保存在浏览器本地）；未配置时会给出明确的中文错误提示。

### 1. 获取源码

```bash
git clone https://github.com/cwbcheng/dsh-knowledge-graph.git
cd dsh-knowledge-graph
```

| 文件 | 作用 |
| --- | --- |
| [`src/index.host.js`](src/index.host.js) | Host 半：异步 AI 拆分任务引擎（段落编号、分批、schema 校验、typed 诊断、模型路由、会话轨迹序列化）+ 知识图验证/质疑引擎（本地体检、LLM 审校、二次复核） |
| [`src/index.client.js`](src/index.client.js) | Client 半：浮动工作台 UI、图渲染、双向定位、验证与质疑面板、修复应用/审计、历史、宽高调节、轨迹知识图标签页 |
| [`src/kg-store.mjs`](src/kg-store.mjs) | SQLite 持久化层：文档、内容块、节点、关系、证据、候选实体/声明与抽取 checkpoint |

### 2. 安装（二选一）

**方式 A：让 Agent 帮你安装（推荐）**

在任意会话中把下面这句话发给 Agent（把路径换成你 clone 的位置）：

> 请读取 `dsh-knowledge-graph` 仓库的 `src/index.host.js` 和 `src/index.client.js`，把这两个文件定义为 Cordis 插件的 Host 半和 Client 半，然后运行它。

Agent 会依次调用 `cordis_define`（定义）→ `cordis_run`（运行），并在界面上弹出**运行审批卡片**。

**方式 B：自己复制源码定义**

1. 在任意会话中发起一次 `cordis_define`（由 Agent 执行，或按你环境的 Cordis 工具流程操作）；
2. **Host 半**粘贴 `src/index.host.js` 的内容，**Client 半**粘贴 `src/index.client.js` 的内容；
3. 注意粘贴的是**函数体**：去掉文件里的 `export default function hostPlugin() {` / `export default function clientPlugin() {` 这一行和文件末尾对应的 `}`，保留中间的 `return { ... };` 部分（文件头部注释可保留也可删掉）。

> 不熟悉 `cordis_define` 工具的话直接用方式 A，Agent 会自动处理好上面的取函数体步骤。

**方式 C：常驻安装（推荐，重启不丢）**

把本仓库安装为 web profile 的组合插件（与 `dsh-hud` 相同的社区插件包形态）：Host 半走 `webServer` 路由、Client 半是 `__ModuleLoader__` 浏览器模块，随 `dsh web` 启动自动加载，**不需要每次重启后重新定义**，也无需审批。

```bash
# 1. 在 profile 目录添加依赖与 bundle（$DSH_HOME 默认 ~/.dsh）
cd ~/.dsh/profiles/web
#    在 package.json 的 dependencies 中加：
#    "dsh-knowledge-graph": "github:cwbcheng/dsh-knowledge-graph#main"
#    在 package.json 的 dsh.profile.bundles 中加：
#    "dsh-knowledge-graph"
pnpm install

# 2. 重启 dsh web（Ctrl+C 后重新 `dsh web`）
```

重启后：对话标题右侧出现「知识图」按钮。窗口位置、筛选和历史索引等轻量 UI 状态保存在浏览器 `localStorage`；正文、图、checkpoint 与 revision 由 Host/SQLite 持久化。

| 文件 | 作用（常驻包） |
| --- | --- |
| [`lib/index.js`](lib/index.js) | Host 半：任务引擎 + `/api/dsh-knowledge-graph` 路由（抽取/追加、task status、`document-load`/`document-export`、revisioned `graph-commit`、安全 `resume-extract`、验证/质疑等）+ 自动 SQLite canonical graph / checkpoint 持久化 |
| [`lib/client.js`](lib/client.js) | Client 半：`__ModuleLoader__` 浏览器模块（fetch RPC + 手动样式注入） |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle patch：向组合插入 `dsh-knowledge-graph` 行 |

> `src/` 与 `lib/` 是同一插件的两种部署形态：`src/` 供动态插件（方式 A/B）使用，`lib/` 供常驻组合（方式 C）使用，逻辑保持一致。

### 3. 批准运行

定义成功后运行会进入 **awaiting approval（等待批准）** 状态：

- 插件面板（左下角 **Cordis Plugin** 按钮）会自动弹出并高亮待批准的行；
- 点 **✓（单勾）**：仅授权本次运行；点 **✓✓（双勾）**：同时授权该插件后续版本的自动运行（推荐）；
- 批准后插件在浏览器中激活，面板状态变为 **running**。

### 4. 验证安装

- 任意对话的**标题右侧**（对话头部操作行）出现「知识图」按钮；
- 点击弹出**浮动工作台**，粘贴一段正文 → **AI 拆分**，约 15–40 秒后得到知识图；
- 对话区顶部出现第三个标签页「轨迹知识图」（对话 / 轨迹 / 轨迹知识图），点击 → **拆解本会话轨迹**，约 15–40 秒后得到该会话的轨迹知识图。

### 5. SQLite 持久化与 CLI

CLI 使用 Node `node:sqlite`，当前要求 Node 22.5+；不需要额外 npm 依赖。它适合把浏览器或 Host 导出的 `KnowledgeGraphDto` 落盘，再进行候选实体 / 声明的人工审核。

```bash
# 初始化数据库
npm run kg -- init --db ./data/knowledge.sqlite

# 导入抽取结果（JSON 文件可直接来自 task.result）
npm run kg -- import-graph --db ./data/knowledge.sqlite --input ./graph.json

# 查看候选实体或声明
npm run kg -- list-candidates --db ./data/knowledge.sqlite --kind entity --status candidate
npm run kg -- list-candidates --db ./data/knowledge.sqlite --kind claim --status candidate

# 接受 / 驳回候选
npm run kg -- set-candidate --db ./data/knowledge.sqlite --kind entity --id ent_xxx --status accepted
npm run kg -- set-candidate --db ./data/knowledge.sqlite --kind claim --id clm_xxx --status rejected

# 查看已持久化文档与 checkpoint
npm run kg -- list-documents --db ./data/knowledge.sqlite
npm run kg -- show-document --db ./data/knowledge.sqlite --id document_xxx
npm run kg -- save-checkpoint --db ./data/knowledge.sqlite --input checkpoint.json --run-id run_xxx
npm run kg -- load-checkpoint --db ./data/knowledge.sqlite --run-id run_xxx
```

常驻包的 `lib/index.js` 会在每个成功 chunk 和任务完成时自动写入 SQLite；数据库路径由 `DSH_KG_DB` 指定，未指定时为当前工作目录的 `.dsh-knowledge-graph.sqlite`。`npm run test:kg` 会在内存 SQLite 中验证文档、chunk、evidence、候选状态变更、checkpoint 保存与恢复；`npm run test:kg-candidates` 额外验证动态 Host RPC 与常驻 HTTP/SQLite 的候选列表和状态更新。常驻包构建时会同步生成 [`lib/kg-store.mjs`](lib/kg-store.mjs)。

## 更新插件

- **动态安装（方式 A/B）**：仓库有更新后重复方式 A——让 Agent 重新读取两个源文件并 `cordis_define`（在同一个插件下追加新 Package），再 `cordis_run`（update 模式）切换到新版本；若你之前点了双勾，新版本会自动运行。
- **常驻安装（方式 C）**：更新后重新 `pnpm install`（拉取最新 `#main`）并重启 `dsh web` 即可。

## 卸载插件

- **动态安装**：打开 **Cordis Plugin** 面板 → 在插件行点击 **停止（Stop）** 暂停使用；需要彻底删除定义时使用 `cordis_undefine`。
- **常驻安装**：从 profile 的 `package.json` 移除依赖与 bundles 条目，`pnpm install` 后重启。

窗口布局、历史索引等轻量 UI 数据保存在浏览器 `localStorage`；书级正文、canonical graph、checkpoint 与 graph revision 在常驻模式保存在 Host/SQLite。卸载前如需长期保留知识内容，请保留对应 SQLite 数据库或先导出 JSON/CSV。

## 注意事项

- 动态插件运行在 DSH **进程内**：进程重启后插件会消失，需要重新安装（方式 A 或改用常驻方式 C，历史数据仍保留在浏览器里）；常驻插件随服务启动自动加载，不受重启影响；
- Host 半依赖可用的 LLM（见前置条件）；AI 调用只发生在你自己的 DSH 环境内，是否外传取决于你配置的模型提供方；
- 本项目**不含**付费 / 配额功能：拆分、历史、双向定位全部在本地完成。

## 使用

1. 点击对话标题右侧的「知识图」按钮，打开浮动工作台；
2. 在「输入资料」粘贴正文（可选填标题），点 **AI 拆分**（输入区可收起；结果区高度、原文/图宽度比例均可拖拽调整并记忆）；
3. 摘要 / 图出现后，**点图中节点查看详情卡片（完整内容）并定位原文**，或**点原文段落聚焦图中节点**；
4. 点 **⚡ 快速体检** 立即拿到确定性问题报告，或点 **🤖 AI 深度审校** 让 LLM 以原文为证据逐节点找茬；点 **🔎 外部事实核查** 则用外部证据核查原文本身；点击问题/断言行高亮图中相关节点/边并定位原文，**采纳修复**或**忽略**；在节点详情卡「质疑此节点」、选中边后「质疑此关系」，或在验证面板底部直接向整张图提问/质疑；
5. 在「章节与候选审核」面板选择章节，只查看该章节的图和原文；对候选实体 / 声明点「已接受」或「已驳回」，点击候选卡可回链原文证据；
6. 想继续扩展图：在输入区粘贴下一段资料，点 **追加拆分**（或直接选中聊天消息里的文字自动追加）——新增节点与已有节点自动建立跨段关系，全文段落统一编号，历史记录原地更新；此前验证结果会自动标记为过期，可重新验证；
7. 用「历史」回看之前的拆分（自动保存最近 20 条，可单删 / 清空）；任务进行中关窗或刷新，重开窗口会自动恢复轮询；
8. 对话区切换到「轨迹知识图」标签页，点 **拆解本会话轨迹** 生成会话轨迹知识图；点击轨迹事件在图中聚焦节点，点击节点查看完整内容并滚动到对应事件；结果在切换标签页 / 刷新后自动恢复，拖拽中间竖条调两列宽度、拖拽下方横条调结果区高度。

## Chrome 扩展（划线拆图）

在**任意网页**上选中文字，点浮动按钮「拆成知识图」，一键调用本机 DSH 服务生成知识图（弹窗内可直接拆分、看图、回链原文）。

- 源码在仓库 `extension/` 目录，零依赖打包：`viewer.js` 由 `scripts/build-viewer.mjs` 从 `src/index.client.js` 切片生成（`d3/*.js` 为内嵌 d3 模块的独立文件——MV3 扩展页禁止 eval，popup 用 `<script src>` 预载后 viewer 自动走全局 d3 快速路径），修改源文件后运行 `node scripts/build-viewer.mjs` 重新生成。
- **安装（二选一）**：
  1. **拖一个文件（推荐）**：Chrome 打开 `chrome://extensions` → 开启右上角「开发者模式」→ 把 `dist/dsh-knowledge-graph.crx` **直接拖进页面** → 点「添加扩展程序」。首次会提示"Chromium 无法验证此扩展程序的来源"，属正常（未上架商店），照常使用。
  2. **加载文件夹**：「加载已解压的扩展程序」→ 选择本仓库 `extension/` 目录。
  - 注意 Chrome 137+ 品牌版**不支持 `--load-extension` 命令行加载**（Chrome for Testing / Chromium 等未品牌化构建仍支持）。
- **重新打包**（源码更新后想继续用 crx 分发）：扩展私钥**不能放在仓库里**。将它保存在仓库外（默认建议 `~/.config/dsh-knowledge-graph/extension-signing.pem`，权限 `0600`），然后通过环境变量传给打包脚本：
  ```bash
  npm ci --prefix scripts/signing --ignore-scripts
  export DSH_KG_EXTENSION_KEY="$HOME/.config/dsh-knowledge-graph/extension-signing.pem"
  npm run pack:extension
  ```
  首次运行会生成新私钥；扩展 ID 由它派生，换密钥 = 换 ID = 旧安装失效。不要把私钥复制到 `dist/` 或提交到 Git。脚本会把新的 CRX 写入 `dist/dsh-knowledge-graph.crx`。
- **依赖**：本机需运行 `dsh web` 且插件版本包含 `/dsh-kg` 扩展端点（常驻安装需先更新插件并重启 dsh web）。端点默认只接受本项目新 CRX 的扩展来源 `chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof`；若使用「加载已解压」导致扩展 ID 不同，启动 dsh web 前设置 `DSH_KG_EXTENSION_ORIGINS=chrome-extension://你的扩展ID`。只有显式设置 `DSH_KG_ALLOW_LOCAL_ORIGIN=1` 时才额外允许 localhost/127.0.0.1 来源，并返回 PNA 预检头；空 Origin 和任意其他扩展来源都会被拒绝。
- **数据流**：内容脚本（任意页面）→ `chrome.runtime.sendMessage` → Service Worker 写入 `chrome.storage.session` 并 `chrome.action.openPopup()`（Chrome 127+）；弹窗读取选中文本后调用 `http://127.0.0.1:3080/dsh-kg/extract`，轮询 `task-status` 渲染知识图。DSH 服务地址可在弹窗底部修改并记忆（`chrome.storage.local` 的 `kgBase`）。

## 架构

```
┌─────────────── Host（Node 进程） ───────────────┐   ┌────────── Client（浏览器）──────────┐
│ extract / append-extract / task-status /        │   │                                      │
│   trajectory-extract / trajectory-status        │   │  浮动窗口（shell.overlay）           │
│   verify-graph (quick/standard)                 │   │    输入区（可收起）                  │
│   question-graph (node/edge/graph)              │   │    原文 ⇄ 知识图（宽高可拖）         │
│   fact-check (quick/deep, wikipedia evidence)   │   │    验证与质疑面板 / 修复应用 / 审计   │
│   split paragraphs (numbered)  ───────────────►│   │    外部事实核查面板                  │
│   serializeTrace(会话事件) ───────────────────►│   │    历史 / 诊断 / toast(悬浮)         │
│   append: 已有图节点清单注入提示词 ────────────►│   │  对话头部「知识图」按钮 + run 卡片启动条│
│   batches → llm.stream (typed retry ×2)        │   │  会话标签页「轨迹知识图」                 │
│   schema validate → merge (dedupe/warnings)    │   │    轨迹 ⇄ 知识图双向定位            │
│   task Map; busy lock; 2h purge                │   └──────────────────────────────────────┘
└────────────────────────────────────────────────┘
```

### 关键设计

- **内容单元编号即锚点**：Host 与 Client 用同一算法先把每个空行块做结构分类（标题 / 列表 / 对话 / 表格 / 代码 / 引用 / 普通叙述），再按结构切分编号单元——标题与列表项各自成单元、对话每轮成单元、引用与代码按行组织；普通叙述按话题转换标记（但是/因此/例如…）与词汇话题漂移分组，组满约 120 字、单句超 180 字时按句边界/软标点继续拆，避免一个长单元挂太多节点标签。提示词要求每个节点直接汇报出处的单元编号；客户端据此**确定性映射内容单元**，不再依赖 LLM 逐字复述原文。
- **多批次全局重编号**：每个批次的 AI 都从 `n1` 开始命名节点，Host 在合并前无条件重编号冲突 id 并同步重写边，避免长文档后续批次的节点被当成重复 id 丢弃。
- **关系证据必须证明关系本身**：每条 edge 必须由模型直接给出 `evidence[{ paragraph, quote }]`；Host 会验证 quote 确实存在于对应原文单元。仅仅证明两个端点分别出现过，不足以证明 `supports / causes / infers` 等关系；缺少可定位 relation evidence 的边会被丢弃并写入 warning。
- **typed 失败、不静默**：CLI/进程失败、非 JSON、schema 不合法（先 typed 重试 2 次）、队列忙碌、无模型等情况都有明确原因码与中文文案；无效节点/边丢弃但写入 warnings。
- **不猜偏移**：锚点解析失败时节点在图/原文间不可回链，但绝不臆造偏移，统一暴露在诊断列表（`anchor_unresolved:node:...`）中。
- **轨迹事件即内容单元**：会话执行轨迹序列化为编号内容单元（用户消息 / 工具调用 / 工具结果 / AI 回复）；每个事件记录自身在轨迹文本中的 `[start, end)` 偏移，超长事件被切分成多个单元后仍能确定性映射回原事件，复用同一套「内容单元编号即锚点」机制做图与事件的确定性双向回链。
- **增量合并（追加拆分）**：追加时把已有图的节点清单注入提示词，AI 只产出新节点、并通过引用已有节点 id 建立**跨段关系边**；宿主负责新 id 重编号（避开已有）、单元号偏移（对齐全文编号）与边去重，客户端原地合并视图。
- **验证以原文为唯一事实源**：快速体检在 Host 本地执行（与 Client 同一套锚点匹配算法）；深度审校按内容单元分批、每批只审相关子图，标准档先产生候选问题再由复核员二次过滤；无原文证据、置信度不足或目标不存在的 issue 在 Host 层直接丢弃；验证/质疑输入限制最多 800 个节点，避免恶意大图拖垮 Host。
- **修复不静默、可审计**：AI 只提建议，用户点「采纳」才应用补丁；一键修复批量应用全部可自动修复项；每次应用写 `graph.verification.auditLog`，并通过 `expectedRevision + baseline window` 提交到 canonical graph；冲突会显式返回 `revision_conflict`，不会让浏览器与 SQLite 各自形成一份“真相”。追加拆分后旧报告自动标记 `stale`。
- **任务可观测、可取消，而非超时即失败**：模型任务跑到完成或由用户取消为止；进度实时可见（阶段 / 已运行时长 / 已接收字符 / 警告），所有长任务都有取消按钮，慢流不会被静默判死。
- **逐内容块无损 checkpoint**：每个成功 chunk 都保存 `nextBatchIndex`、截至当前的完整语义图、staging chunk 摘要和来源身份；checkpoint v2 不按 800 节点截断，并由 Host/SQLite 持久化。浏览器不保存 checkpoint；只有 `task-status=not_found` 且 SQLite 中仍是 `running` 的任务才允许恢复，确定性失败不会自动续跑。
- **800 是视图预算，不是知识上限**：Host/SQLite 保存全量 canonical graph；浏览器一次只加载最多 800 个节点的工作窗口。工作台会显示「当前节点区间 / 全量节点数」，提供上一页 / 下一页 / 指定页跳转，并支持按节点 ID、文本、类型或章节查询有界子图；查询结果优先返回直接命中的节点，再补一跳邻居以恢复跨窗口关系上下文。JSON/CSV 导出遇到截断视图时会向 Host 请求完整 canonical graph；布局、双向定位和交互仍在浏览器完成。
- **章节 / 候选审核视图**：章节筛选只改变当前浏览器结果视图，不修改原始图；候选状态以 `documentId | kind | nodeId` 稳定键保存，保留原文 evidence 和回链能力。
- **SQLite 候选层**：`src/kg-store.mjs` 把图结果写入文档 / chunk / node / edge 表，并按节点类型生成带 evidence 的候选实体与候选声明；canonical revision 提交时会删除已经失效的候选，同时用稳定 candidate id 保留仍存在候选的 accepted/rejected 状态。用户也可以通过 CLI 更新审核状态。
- **可插拔声明抽取器**：Host 可选读取 `kgExtractor` 服务；它实现 `extractChunk(input)`，输入一个自有 JSON 内容块和已有节点 id，返回标准图对象或 JSON 文本。未提供时自动回退到当前 LLM 路径，因此动态插件和常驻包都不增加硬依赖。

## 数据契约

```
KnowledgeGraphDto { summary: string, source?, staging?, nodes[], edges[], warnings[], verification? }
Source { id, documentId, title, chars, paragraphCount, chunkCount, sectionCount, sections[] }
Staging { sourceId, documentId, chunkCount, chunks[] }
Checkpoint { version: 2, taskKind, sourceId, documentId, nextBatchIndex, totalBatches, graph /* 无损 */, staging }
GraphView { nodes[<=800], edges[], view: { kind: 'window' | 'query', nodeOffset, nodeLimit, totalNodes, totalEdges, truncated, query?, matchedNodes? } }
EntityCandidate { id, documentId, nodeId?, text, type, status: 'candidate' | 'accepted' | 'rejected', evidence[] }
ClaimCandidate { id, documentId, nodeId?, text, type, status: 'candidate' | 'accepted' | 'rejected', confidence?, evidence[] }
ExtractionRun { runId, documentId?, sourceId?, status, nextBatchIndex, totalBatches, checkpoint }
GraphExtractorService { extractChunk({ title, chunk, paragraphOffset, existingNodeIds, prompt, attempt }) -> KnowledgeGraphBatch | JSON }
Node  { id, type, typeLabel?, text, quote?, paragraph?, evidence?, documentId?, sourceId?, chunkId?, sectionId?, sectionTitle? }
Edge  { fromNodeId, toNodeId, relation, relationLabel?, evidence?, documentId?, sourceId?, chunkId? }

GraphVerification {
  lastReport?: VerificationReport,
  stale?: boolean,
  auditLog?: [{ ts, action, targetId, detail, reportId, before?, after? }]
}
VerificationReport {
  reportId, mode: 'quick' | 'standard' | 'question',
  createdAt, model?, scope: { kind: 'full' | 'node' | 'edge' | 'graph', ids[] },
  summary, metrics: { checkedNodes, checkedEdges, errorCount, warningCount,
                     suggestionCount, evidenceCoverage, paragraphCoverage },
  issues: Issue[]
}
Issue {
  id, source: 'local' | 'ai' | 'question',
  severity: 'error' | 'warning' | 'suggestion',
  category: 'grounding' | 'type' | 'relation' | 'duplicate' | 'contradiction'
          | 'completeness' | 'summary' | 'other',
  targetKind: 'node' | 'edge' | 'graph', targetId: string | null,
  title, detail, evidence: [{ paragraph?, quote? }],
  confidence: 0..1,
  proposedFix: { action: 'none' | 'update_node' | 'delete_node' | 'add_node'
               | 'update_edge' | 'delete_edge' | 'add_edge' | 'merge_nodes'
               | 'update_summary', nodePatch?, edgePatch?, mergeIntoId?, summaryPatch? },
  status: 'open' | 'accepted' | 'rejected' | 'applied'
}

FactCheckState { lastReport?: ExternalFactCheckReport, stale?: boolean }
ExternalFactCheckReport {
  reportId, mode: 'quick' | 'deep', createdAt, model?,
  summary, metrics: { totalClaims, supported, contradicted,
                     partially_supported, insufficient, unverifiable,
                     out_of_scope, supportedRate },
  claims: ExternalClaim[], warnings?
}
ExternalClaim {
  id, nodeId?, kind, paragraph?, quote, claim,
  checkworthy: 0..1,
  verdict: 'supported' | 'contradicted' | 'partially_supported'
         | 'insufficient' | 'unverifiable' | 'out_of_scope',
  confidence: 0..1, rationale?, correction?,
  evidence: [{ id, provider: 'wikipedia' | 'rules', url?, title?,
               snippet, domainAuthority }],
  evidenceQuote?, status: 'open' | 'accepted' | 'rejected'
}
```

- 7 类节点 wire 类型见上文；6 类关系边见上文。
- 每节点优先携带 `paragraph`（段落编号，确定性回链）与 `quote`（原文逐字摘录）。
- `verification` / `factCheck` 可选，旧版本生成的历史数据没有这些字段时按未验证/未核查处理，完全向后兼容。

## 许可

[MIT](LICENSE) © cwbcheng
