# dsh-knowledge-graph

**DSH（DeepSeek Harness）Cordis 插件**：把任意一段资料正文用 AI 拆解成一张**知识图**，并在**知识图与原文之间双向定位**。

<img width="1538" height="945" alt="image" src="https://github.com/user-attachments/assets/824ab99b-d291-4d06-8eb7-b91e947b1af4" />


> 贴原文 → AI 异步拆图 → 双向锚点定位。是 NovelStudio「资料 ⇄ 知识图」落地为独立、可复用插件的形态。

---

## 它能做什么

- **AI 异步拆分**：输入任意正文（章节、技术文档、学习笔记…），后台任务模式调用 LLM，约 15–40 秒返回一张知识图。长文档自动分批处理，刷新 / 重开窗口后自动恢复轮询结果。
- **7 类节点 / 6 类关系**：
  - 节点：`fact` 事实 · `inference` 推论 · `concept` 概念 · `definition` 定义 · `example` 例子 · `counter_example` 反例 · `rule` 规则。
  - 关系：`supports` 支持 · `example` 例子 · `counter_example` 反例 · `defines` 定义 · `infers` 推断 · `causes` 因果。
- **双向定位**：
  - 点击**图中节点** → 平滑滚动并高亮到原文对应段落；
  - 点击**原文段落** → 图中居中聚焦并闪烁对应节点。
  - 锚点以 AI 直接输出**段落编号**为主（确定性索引），quote 精确匹配与 token 重合度兜底；无法回链的节点不猜测偏移，统一进入诊断列表。
- **图渲染**：SVG 画布 + 7 类配色 / 环形 + 力导向布局（带重叠消解）/ 拖拽平移 / Ctrl+滚轮缩放 / 工具栏 `− 100% +`（50%–200% 步进 10%）/ 长按节点查看原文摘录 / 键盘可达。
- **浮动工作台**：窗口可拖动、可调整大小；原文与知识图的**宽度比例**、**结果区高度**均可拖拽调整并记忆。
- **历史记录**：每次成功拆分自动入库（最多 20 条、同文去重、可单删 / 清空），随时回看加载。
- **常驻入口**：每个对话的标题右侧常驻「知识图」按钮，一键打开；运行卡片内也有启动条。

## 界面一览

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

## 安装

这是一个 **DSH 动态 Cordis 插件**：一份 Host 代码（Node 进程）+ 一份 Client 代码（浏览器），纯 JS、零依赖、无需构建。通过 DSH Web 界面的 Cordis 插件机制加载，步骤适用于任何 DSH Web 会话。

### 0. 前置条件

- 已启动 **DSH Web**（`dsh web`）并进入任意会话；
- 环境中已配置 **AI 模型提供方**（设置 → 模型，或 `agentDefaultModel`）。插件会自动选用当前默认模型；未配置时会给出明确的中文错误提示。

### 1. 获取源码

```bash
git clone https://github.com/cwbcheng/dsh-knowledge-graph.git
cd dsh-knowledge-graph
```

| 文件 | 作用 |
| --- | --- |
| [`src/index.host.js`](src/index.host.js) | Host 半：异步 AI 拆分任务引擎（段落编号、分批、schema 校验、typed 诊断、模型路由） |
| [`src/index.client.js`](src/index.client.js) | Client 半：浮动工作台 UI、图渲染、双向定位、历史、宽高调节 |

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

重启后：对话标题右侧出现「知识图」按钮，历史记录、窗口位置等（浏览器 localStorage）原样保留。

| 文件 | 作用（常驻包） |
| --- | --- |
| [`lib/index.js`](lib/index.js) | Host 半：任务引擎 + `/api/dsh-knowledge-graph` 路由（POST extract / GET task-status） |
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
- 点击弹出**浮动工作台**，粘贴一段正文 → **AI 拆分**，约 15–40 秒后得到知识图。

## 更新插件

- **动态安装（方式 A/B）**：仓库有更新后重复方式 A——让 Agent 重新读取两个源文件并 `cordis_define`（在同一个插件下追加新 Package），再 `cordis_run`（update 模式）切换到新版本；若你之前点了双勾，新版本会自动运行。
- **常驻安装（方式 C）**：更新后重新 `pnpm install`（拉取最新 `#main`）并重启 `dsh web` 即可。

## 卸载插件

- **动态安装**：打开 **Cordis Plugin** 面板 → 在插件行点击 **停止（Stop）** 暂停使用；需要彻底删除定义时使用 `cordis_undefine`。
- **常驻安装**：从 profile 的 `package.json` 移除依赖与 bundles 条目，`pnpm install` 后重启。

历史记录等数据保存在浏览器 `localStorage`，卸载不会丢失。

## 注意事项

- 动态插件运行在 DSH **进程内**：进程重启后插件会消失，需要重新安装（方式 A 或改用常驻方式 C，历史数据仍保留在浏览器里）；常驻插件随服务启动自动加载，不受重启影响；
- Host 半依赖可用的 LLM（见前置条件）；AI 调用只发生在你自己的 DSH 环境内，是否外传取决于你配置的模型提供方；
- 本项目**不含**付费 / 配额功能：拆分、历史、双向定位全部在本地完成。

## 使用

1. 点击对话标题右侧的「知识图」按钮，打开浮动工作台；
2. 在「输入资料」粘贴正文（可选填标题），点 **AI 拆分**（输入区可收起；结果区高度、原文/图宽度比例均可拖拽调整并记忆）；
3. 摘要 / 图出现后，**点图中节点定位原文**，或**点原文段落聚焦图中节点**；
4. 用「历史」回看之前的拆分（自动保存最近 20 条，可单删 / 清空）；任务进行中关窗或刷新，重开窗口会自动恢复轮询。

## 架构

```
┌─────────────── Host（Node 进程） ───────────────┐   ┌────────── Client（浏览器）──────────┐
│ extract / task-status（Package-private RPC）   │   │                                      │
│   split paragraphs (numbered)  ───────────────►│   │  浮动窗口（shell.overlay）           │
│   batches → llm.stream (typed retry ×2)        │   │    输入区（可收起）                  │
│   schema validate → merge (dedupe/warnings)    │   │    原文 ⇄ 知识图（宽高可拖）         │
│   task Map; busy lock; 2h purge                │   │    历史 / 诊断 / toast(悬浮)         │
└────────────────────────────────────────────────┘   │  对话头部「知识图」按钮 + run 卡片启动条│
                                                     └──────────────────────────────────────┘
```

### 关键设计

- **段落编号即锚点**：Host 与 Client 用同一算法把正文切成段落并编号，提示词要求每个节点直接汇报出处的段落编号；客户端据此**确定性映射段落**，不再依赖 LLM 逐字复述原文。
- **typed 失败、不静默**：CLI/进程失败、非 JSON、schema 不合法（先 typed 重试 2 次）、队列忙碌、无模型等情况都有明确原因码与中文文案；无效节点/边丢弃但写入 warnings。
- **不猜偏移**：锚点解析失败时节点在图/原文间不可回链，但绝不臆造偏移，统一暴露在诊断列表（`anchor_unresolved:node:...`）中。
- **前端自包含**：布局、力导向、双向定位、历史均在浏览器完成，Host 只做最薄的异步任务管理。

## 数据契约

```
KnowledgeGraphDto { summary: string, nodes[], edges[], warnings[] }
Node  { id, type, typeLabel?, text, quote?, paragraph?, offsetHint? }
Edge  { fromNodeId, toNodeId, relation, relationLabel? }
```

- 7 类节点 wire 类型见上文；6 类关系边见上文。
- 每节点优先携带 `paragraph`（段落编号，确定性回链）与 `quote`（原文逐字摘录）。

## 许可

[MIT](LICENSE) © cwbcheng
