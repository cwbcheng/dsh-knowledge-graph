/**
 * Ontology profiles — the single source of truth for node types, relation
 * types and their presentation.
 *
 * Two profiles ship today:
 *
 *   proposition-v1     the original extraction ontology (fact/claim/…, 8 node
 *                      types, 12 relations). Frozen: every literal here must
 *                      keep matching what src/index.host.js and
 *                      src/index.client.js hardcoded before this module
 *                      existed, otherwise existing graphs re-render differently.
 *
 *   learning-view-v1   《学习观》ontology. A knowledge graph is still a
 *                      knowledge graph; only the node and relation types change.
 *                      Spec: docs/learning-view-ontology.md
 *
 * Both halves of the plugin (persistent lib/index.js and dynamic
 * src/index.host.js) read profiles from here, so a type is declared once. The
 * presentation face travels with the graph payload so the client can never
 * disagree with the host about what a type is called.
 *
 * Pure data + pure functions: no I/O, deterministic.
 */

export const ONTOLOGY_PROPOSITION = 'proposition-v1'
export const ONTOLOGY_LEARNING_VIEW = 'learning-view-v1'
export const DEFAULT_ONTOLOGY_ID = ONTOLOGY_PROPOSITION

// Layout families. The client turns these into its relation-aware ranking:
// `backbone` relations form the visual chain, `satellite` relations hang off
// it as nearby branches, `directional` ones get a bounded pull without
// redefining the backbone, and `neutral` ones are in none of those sets — they
// keep the default weight and the plain BFS behaviour.
const FAMILY_BACKBONE = 'backbone'
const FAMILY_SATELLITE = 'satellite'
const FAMILY_DIRECTIONAL = 'directional'
const FAMILY_NEUTRAL = 'neutral'

/**
 * proposition-v1 — frozen copy of the pre-existing constants.
 * Sources: src/index.host.js TYPE_ALIASES/REL_ALIASES and the evidence
 * requirement sets; src/index.client.js TYPE_META/REL_LABEL and the layout sets.
 */
const PROPOSITION = {
  id: ONTOLOGY_PROPOSITION,
  label: '命题知识图',
  summary: '把资料拆成命题与关系的通用抽取本体。',
  nodeTypes: [
    { id: 'fact', zh: '事实', label: '事实', color: '#3b82f6', fill: 'rgba(59,130,246,0.15)', aliases: ['事实'] },
    { id: 'claim', zh: '主张', label: '主张', color: '#0f766e', fill: 'rgba(15,118,110,0.15)', aliases: ['观点', '主张'] },
    { id: 'inference', zh: '推论', label: '推论', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)', aliases: ['推论'] },
    { id: 'concept', zh: '概念', label: '概念', color: '#10b981', fill: 'rgba(16,185,129,0.15)', aliases: ['概念'] },
    { id: 'definition', zh: '定义', label: '定义', color: '#f59e0b', fill: 'rgba(245,158,11,0.16)', aliases: ['定义'] },
    { id: 'example', zh: '例子', label: '例子', color: '#06b6d4', fill: 'rgba(6,182,212,0.15)', aliases: ['例子'] },
    {
      id: 'counter_example', zh: '反例', label: '反例', color: '#ef4444', fill: 'rgba(239,68,68,0.15)',
      aliases: ['反例', 'counterexample', 'counter-example'],
    },
    { id: 'rule', zh: '规则', label: '规则', color: '#7c3aed', fill: 'rgba(124,58,237,0.16)', aliases: ['规则'] },
  ],
  relationTypes: [
    { id: 'supports', zh: '支持', aliases: ['support', '支持'], family: FAMILY_DIRECTIONAL, weight: 4 },
    { id: 'example', zh: '例子', aliases: ['example_of', '例子'], family: FAMILY_SATELLITE, weight: 6 },
    { id: 'counter_example', zh: '反例', aliases: ['counterexample', '反例'], family: FAMILY_SATELLITE, weight: 6 },
    { id: 'defines', zh: '定义', aliases: ['define', '定义'], family: FAMILY_SATELLITE, weight: 7 },
    { id: 'infers', zh: '推断', aliases: ['infer', 'implies', '推断'], family: FAMILY_BACKBONE, weight: 9 },
    { id: 'causes', zh: '因果', aliases: ['cause', '导致', 'drives', 'drive', '驱动', '因果'], family: FAMILY_BACKBONE, weight: 9 },
    { id: 'is_a', zh: '属于', aliases: ['isa', '属于'], family: FAMILY_SATELLITE, weight: 7 },
    { id: 'contains', zh: '包含', aliases: ['contain', '包含'], family: FAMILY_SATELLITE, weight: 7 },
    { id: 'driven_by', zh: '受驱动于', aliases: ['drivenby', '受驱动于'], family: FAMILY_DIRECTIONAL, weight: 4 },
    { id: 'not_is', zh: '不是', aliases: ['notis', '不等于', '不是'], family: FAMILY_NEUTRAL, weight: 7 },
    { id: 'analogy', zh: '类比说明', aliases: ['analogizes', '类比', '类比说明'], family: FAMILY_SATELLITE, weight: 5 },
    { id: 'aims_at', zh: '旨在', aliases: ['aim_at', '旨在'], family: FAMILY_DIRECTIONAL, weight: 4 },
  ],
  // "example" edges must start at an example node, etc. Relation → node type.
  sourceRules: { example: 'example', counter_example: 'counter_example', defines: 'definition' },
  // Node types whose candidates may be reviewed as entity candidates.
  entityCandidateTypes: ['concept', 'definition'],
  claimCandidateTypes: ['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'],
  // Node types that cannot be accepted without a locatable quote.
  evidenceRequiredTypes: ['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'],
  // Node types that get the semantic-drift guard.
  semanticGuardTypes: ['fact', 'claim', 'inference', 'rule', 'definition'],
  consumptionTypes: ['fact', 'claim', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule'],
  // Node types that assert something, so a long one is probably non-atomic and
  // two similar-but-opposite ones are probably a contradiction.
  assertionTypes: ['fact', 'claim', 'inference', 'rule'],
  // External fact-checking: which types are checkable, and how worthwhile.
  factCheckTypes: ['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'],
  factCheckWeights: { fact: 0.9, counter_example: 0.9, rule: 0.85, definition: 0.75, claim: 0.7, inference: 0.6 },
  // Relation weaver: attach orphan `sources` to their best `targets` using
  // `relations` as the existing-link test.
  relationWeave: {
    relations: ['example', 'analogy'],
    sources: ['example'],
    targets: ['fact', 'claim', 'inference', 'concept', 'definition', 'rule'],
  },
  diagnostics: [],
  renderOrder: ['fact', 'claim', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule'],
}

/**
 * learning-view-v1 — 《学习观》ontology.
 *
 * Two orthogonal coordinates on every material node:
 *   modelKind  discrimination 判别 / connection 联结
 *   layer      upper 上料 / lower 下料 / none
 *
 * The layer/modelKind values are declared per node type so the host can copy
 * them onto extracted nodes without asking the model to repeat them — the model
 * classifying a node as `positive_example` already decides 判别下料.
 *
 * Spec: docs/learning-view-ontology.md (§2 node types, §3 relations, §4 diagnostics)
 */
const LEARNING_VIEW = {
  id: ONTOLOGY_LEARNING_VIEW,
  label: '《学习观》知识图',
  summary: '按《学习观》的靶图本体抽取：知识（概念/特征/规律/判别模型/联结模型）与学习材料（判别材料/联结材料 × 上料/下料）。',
  // Attributes this ontology defines relations THROUGH. Normalization copies
  // exactly these onto extracted elements and drops everything else, so without
  // this list the meanings they carry are lost at the parse boundary: which end
  // of maps_between is the input, which side of a contrast is positive, whether
  // compares_* means contrast or analogy. The proposition ontology declares none,
  // so its graphs are byte-for-byte unchanged. See docs §3.
  edgeAttributes: ['role', 'mode'],
  nodeAttributes: ['stage', 'relKind'],
  // Presentation of those attribute values. Kept beside the vocabulary it
  // describes so the edge label and the prompt cannot drift apart; a profile
  // that declares no attributes renders none.
  edgeAttributeLabels: {
    role: { input: '入', output: '出', positive: '正', negative: '负' },
    mode: { contrast: '对比', analogy: '类比' },
  },
  nodeTypes: [
    // ---- 知识结构（5）----
    {
      id: 'concept', zh: '概念', label: '概念', color: '#10b981', fill: 'rgba(16,185,129,0.15)',
      layer: 'upper', modelKind: 'none', aliases: ['概念', '范畴'],
      hint: '代表一群特定现象的类别。',
    },
    {
      id: 'feature', zh: '特征', label: '特征', color: '#14b8a6', fill: 'rgba(20,184,166,0.15)',
      layer: 'upper', modelKind: 'discrimination', aliases: ['特征', '判别依据'],
      hint: '内涵中的单个判别依据（判别依据本身，不是描述它的文字）。',
    },
    {
      id: 'rule', zh: '规律', label: '规律', color: '#7c3aed', fill: 'rgba(124,58,237,0.16)',
      layer: 'upper', modelKind: 'connection', aliases: ['规律', '映射规律'],
      hint: '可被下层所有对应关系共享的映射规律。',
    },
    {
      id: 'discrimination_model', zh: '判别模型', label: '判别模型', color: '#f59e0b', fill: 'rgba(245,158,11,0.16)',
      layer: 'none', modelKind: 'discrimination', aliases: ['判别模型', '判模'],
      hint: '对现象进行类别划分的模型。',
    },
    {
      id: 'connection_model', zh: '联结模型', label: '联结模型', color: '#3b82f6', fill: 'rgba(59,130,246,0.15)',
      layer: 'none', modelKind: 'connection', aliases: ['联结模型', '联模'],
      hint: '已划分出的类别之间的映射。',
    },
    // ---- 判别上料 ----
    {
      id: 'intension_description', zh: '内涵描述', label: '内涵描述', color: '#0ea5e9', fill: 'rgba(14,165,233,0.15)',
      layer: 'upper', modelKind: 'discrimination', aliases: ['内涵描述', '内涵表述'],
      hint: '直接表述共有属性（内涵）的上层材料。具备此内涵就一定是对应概念。',
    },
    {
      id: 'feature_description', zh: '特征描述', label: '特征描述', color: '#06b6d4', fill: 'rgba(6,182,212,0.15)',
      layer: 'upper', modelKind: 'discrimination', aliases: ['特征描述', '特述'],
      hint: '直接描述特征的上层材料。满足不一定是对应概念，不满足则一定不是。',
    },
    // ---- 判别下料 ----
    {
      id: 'positive_example', zh: '正例', label: '正例', color: '#22c55e', fill: 'rgba(34,197,94,0.15)',
      layer: 'lower', modelKind: 'discrimination', aliases: ['正例'],
      hint: '展示的输出结果是正概念的判别例述。',
    },
    {
      id: 'negative_example', zh: '负例', label: '负例', color: '#ef4444', fill: 'rgba(239,68,68,0.15)',
      layer: 'lower', modelKind: 'discrimination', aliases: ['负例', '反例'],
      hint: '展示的输出结果是负概念的判别例述。',
    },
    {
      id: 'contrast_group', zh: '对比例组', label: '对比例组', color: '#f97316', fill: 'rgba(249,115,22,0.15)',
      layer: 'lower', modelKind: 'discrimination', aliases: ['对比例组', '例组'],
      hint: '一组例子：一个既是 A 的正例又是 B 的负例，另一个反之。',
    },
    {
      id: 'extension_contrast', zh: '外延对比', label: '外延对比', color: '#eab308', fill: 'rgba(234,179,8,0.16)',
      layer: 'lower', modelKind: 'discrimination', aliases: ['外延对比'],
      hint: '对比概念外延的判别下料，extKind 取 相等/包含/相交/互斥。',
    },
    // ---- 联结上料 ----
    {
      id: 'relation_material', zh: '关系材料', label: '关系材料', color: '#6366f1', fill: 'rgba(99,102,241,0.15)',
      layer: 'upper', modelKind: 'connection', aliases: ['关系材料'],
      hint: '交代输出变量如何随输入变量改变。relKind 取 常量映射/基本关系/关系组合。',
    },
    {
      id: 'factor_material', zh: '因素材料', label: '因素材料', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)',
      layer: 'upper', modelKind: 'connection', aliases: ['因素材料'],
      hint: '交代输入变量、输出变量和中介变量是什么。',
    },
    {
      id: 'property_material', zh: '性质材料', label: '性质材料', color: '#a855f7', fill: 'rgba(168,85,247,0.15)',
      layer: 'upper', modelKind: 'connection', aliases: ['性质材料'],
      hint: '交代特定类别（概念）具有的性质的材料。',
    },
    // ---- 联结下料 ----
    {
      id: 'segment_example_group', zh: '分段例组', label: '分段例组', color: '#ec4899', fill: 'rgba(236,72,153,0.15)',
      layer: 'lower', modelKind: 'connection', aliases: ['分段例组'],
      hint: '一组例子，分别展现复合关系中每个子关系的联结下料。',
    },
    // ---- 通用材料 ----
    {
      id: 'verification_material', zh: '验证材料', label: '验证材料', color: '#dc2626', fill: 'rgba(220,38,38,0.15)',
      layer: 'lower', modelKind: 'none', aliases: ['验证材料', '习题'],
      hint: '先给输入要求推测输出、再呈现实际输出的下层材料；必须在靶图下层之外。',
    },
    {
      id: 'data_or_experience', zh: '数据/经验', label: '数据/经验', color: '#64748b', fill: 'rgba(100,116,139,0.15)',
      layer: 'lower', modelKind: 'none', aliases: ['数据', '经验', '原始材料'],
      hint: 'stage 取 data（尚未明确推测任务）/ experience（已明确但未必要体现规律）。',
    },
    {
      id: 'memory_material', zh: '记忆材料', label: '记忆材料', color: '#94a3b8', fill: 'rgba(148,163,184,0.16)',
      layer: 'none', modelKind: 'none', aliases: ['记忆材料', '信息'],
      hint: '被用于原封不动保存的材料（信息，不是知识）。',
    },
  ],
  relationTypes: [
    // ---- 下上结构 ----
    {
      id: 'exemplifies', zh: '例证', family: FAMILY_SATELLITE, weight: 7,
      aliases: ['例证', '例述例证规述', '举例说明'],
      from: ['positive_example', 'negative_example', 'contrast_group', 'segment_example_group', 'data_or_experience'],
      to: ['intension_description', 'feature_description', 'relation_material', 'factor_material', 'property_material', 'rule'],
      hint: '下层材料具体例证某个上层材料或规律。方向：下料 → 上料。',
    },
    {
      id: 'aligns_upper_lower', zh: '下上对齐', family: FAMILY_SATELLITE, weight: 8,
      aliases: ['下上对齐', '对齐', '下上结合'],
      from: ['intension_description', 'feature_description', 'relation_material', 'factor_material', 'property_material'],
      to: ['positive_example', 'negative_example', 'contrast_group', 'extension_contrast', 'segment_example_group'],
      hint: '同一知识的上料与下料互相对应。不对齐则两层仍是分离的。',
    },
    {
      id: 'is_recycled_as', zh: '例习互转', family: FAMILY_DIRECTIONAL, weight: 4,
      aliases: ['例习互转', '遗例转习', '例习循环'],
      from: ['positive_example', 'negative_example', 'contrast_group', 'segment_example_group', 'data_or_experience'],
      to: ['verification_material'],
      hint: '例子被转用作验证材料——这正是「验证复用旧例」缺陷的来源。',
    },
    // ---- 模型与概念 ----
    {
      id: 'classifies', zh: '划分', family: FAMILY_DIRECTIONAL, weight: 6,
      aliases: ['划分', '判别', '归类'],
      from: ['discrimination_model'],
      to: ['concept', 'feature'],
      hint: '判别模型把现象划分到某个概念。',
    },
    {
      id: 'maps_between', zh: '联结映射', family: FAMILY_DIRECTIONAL, weight: 6,
      aliases: ['联结映射', '映射', '联结'],
      from: ['connection_model'],
      to: ['concept'],
      hint: '联结模型在输入概念与输出概念之间映射；边的 role 取 input / output。',
    },
    {
      id: 'has_feature', zh: '特征', family: FAMILY_BACKBONE, weight: 7,
      aliases: ['特征', '具有特征'],
      from: ['concept'],
      to: ['feature'],
      hint: '概念具有某个判别依据（知识层，不是描述它的文字）。',
    },
    {
      id: 'has_rule', zh: '规律', family: FAMILY_BACKBONE, weight: 8,
      aliases: ['规律', '依赖规律'],
      from: ['concept', 'connection_model'],
      to: ['rule'],
      hint: '概念或联结模型所依赖的映射规律。',
    },
    {
      id: 'states_intension', zh: '表述内涵', family: FAMILY_SATELLITE, weight: 6,
      aliases: ['表述内涵', '内涵描述表述内涵'],
      from: ['intension_description'],
      to: ['concept'],
      hint: '内涵描述表述某概念的内涵（材料 → 知识）。',
    },
    {
      id: 'states_feature', zh: '描述特征', family: FAMILY_SATELLITE, weight: 6,
      aliases: ['描述特征', '特征描述表述特征'],
      from: ['feature_description'],
      to: ['feature'],
      hint: '特征描述表述某特征（材料 → 知识）。',
    },
    {
      id: 'feature_split', zh: '特征拆分', family: FAMILY_DIRECTIONAL, weight: 4,
      aliases: ['特征拆分'],
      from: ['intension_description'],
      to: ['feature_description'],
      hint: '从内涵描述中拆解出特征描述（原书给出的改进技法）。',
    },
    {
      id: 'prerequisite', zh: '前提', family: FAMILY_DIRECTIONAL, weight: 5,
      aliases: ['前提', '是前提'],
      from: ['discrimination_model'],
      to: ['connection_model'],
      hint: '判别模型是联结模型的前提。',
    },
    // ---- 材料与模型 ----
    {
      id: 'builds', zh: '渐构', family: FAMILY_DIRECTIONAL, weight: 5,
      aliases: ['渐构', '用于渐构'],
      from: [
        'intension_description', 'feature_description', 'positive_example', 'negative_example',
        'contrast_group', 'extension_contrast', 'relation_material', 'factor_material',
        'property_material', 'segment_example_group', 'data_or_experience',
      ],
      to: ['discrimination_model', 'connection_model'],
      hint: '材料用于渐构某个模型。',
    },
    {
      id: 'states_variable', zh: '交代变量', family: FAMILY_BACKBONE, weight: 7,
      aliases: ['交代变量', '指明变量'],
      from: ['factor_material'],
      to: ['concept'],
      hint: '因素材料交代输入/输出/中介变量。',
    },
    {
      id: 'states_mapping', zh: '交代映射', family: FAMILY_BACKBONE, weight: 8,
      aliases: ['交代映射', '关系材料交代映射'],
      from: ['relation_material'],
      to: ['rule', 'connection_model'],
      hint: '关系材料交代输出如何随输入改变。',
    },
    {
      id: 'verifies', zh: '验证', family: FAMILY_SATELLITE, weight: 5,
      aliases: ['验证', '验证模型'],
      from: ['verification_material'],
      to: ['discrimination_model', 'connection_model', 'concept', 'rule'],
      hint: '验证材料验证模型或知识的可泛化性。',
    },
    // ---- 对比、复合与迁移 ----
    {
      id: 'contrasts', zh: '外延对比', family: FAMILY_SATELLITE, weight: 5,
      aliases: ['外延对比', '对比'],
      from: ['contrast_group'],
      to: ['concept'],
      hint: '对比例组同时对比两个概念；两条边，边的 role 取 positive / negative。',
    },
    {
      id: 'extension_relation', zh: '外延关系', family: FAMILY_SATELLITE, weight: 5,
      aliases: ['外延关系', '外延对比关系'],
      from: ['extension_contrast'],
      to: ['concept'],
      hint: '外延对比材料所指出的外延间关系；边的 extKind 取 相等/包含/相交/互斥。',
    },
    {
      id: 'compares_feature', zh: '特征对比/类比', family: FAMILY_SATELLITE, weight: 5,
      aliases: ['特征对比', '特征类比'],
      from: ['feature'],
      to: ['feature'],
      hint: '对比或类比两个概念的特征；边的 mode 取 contrast / analogy。',
    },
    {
      id: 'compares_relation', zh: '关系对比/类比', family: FAMILY_SATELLITE, weight: 5,
      aliases: ['关系对比', '关系类比'],
      from: ['connection_model', 'rule'],
      to: ['connection_model', 'rule'],
      hint: '对比或类比两个知识的映射关系；边的 mode 取 contrast / analogy。',
    },
    {
      id: 'composes', zh: '复合', family: FAMILY_BACKBONE, weight: 7,
      aliases: ['复合', '子关系组成复合关系', '关系组合'],
      from: ['rule', 'connection_model'],
      to: ['rule', 'connection_model'],
      hint: '子关系组成复合关系。',
    },
    {
      id: 'transfers_from', zh: '迁移', family: FAMILY_DIRECTIONAL, weight: 4,
      aliases: ['迁移', '正迁移', '负迁移', '复用'],
      from: ['concept', 'memory_material', 'rule'],
      to: ['rule', 'connection_model', 'concept'],
      hint: '复用既有模型。必须给出显式复用语义（基于/沿用/套用）才建边。',
    },
  ],
  sourceRules: {},
  entityCandidateTypes: ['concept', 'feature', 'rule'],
  claimCandidateTypes: ['concept', 'feature', 'rule', 'discrimination_model', 'connection_model'],
  // Knowledge nodes may be induction products without a verbatim quote; every
  // material node is a passage and must be locatable.
  evidenceRequiredTypes: [
    'intension_description', 'feature_description', 'positive_example', 'negative_example',
    'contrast_group', 'extension_contrast', 'relation_material', 'factor_material',
    'property_material', 'segment_example_group', 'verification_material',
    'data_or_experience', 'memory_material',
  ],
  semanticGuardTypes: ['intension_description', 'feature_description', 'relation_material', 'factor_material', 'property_material'],
  consumptionTypes: [
    'concept', 'feature', 'rule', 'discrimination_model', 'connection_model',
    'intension_description', 'feature_description', 'positive_example', 'negative_example',
    'contrast_group', 'extension_contrast', 'relation_material', 'factor_material',
    'property_material', 'segment_example_group', 'verification_material',
    'data_or_experience', 'memory_material',
  ],
  diagnostics: [
    { id: 'lower_missing', zh: '下层丢失', definition: '只有上料，没有支撑它的下料；只能自上而下背。' },
    { id: 'upper_missing', zh: '上层丢失', definition: '只有例子，没有从中提炼的规律。' },
    { id: 'layer_mismatch', zh: '下上错配', definition: '上层材料与下层材料不对应同一知识。' },
    { id: 'model_mismatch', zh: '判联错配', definition: '有判别模型无联结模型，或反之。' },
    { id: 'mapping_missing', zh: '联结空载', definition: '联结模型没有交代它在什么与什么之间映射，映射只写在文字里。' },
    { id: 'memorize_words', zh: '记言代学', definition: '只记住名称或描述，未建模型。' },
    { id: 'words_without_meaning', zh: '言存义空', definition: '记住了表述，未获得其指涉的义。' },
    { id: 'meaning_without_words', zh: '义存言空', definition: '有义但无法用语言表述。' },
    { id: 'verification_recycled', zh: '验证复用旧例', definition: '验证材料取自已有下料，未验证泛化。' },
    { id: 'verification_missing', zh: '缺验证', definition: '有学习材料但无验证材料。' },
    { id: 'material_as_memory', zh: '学习材料当记忆材料', definition: '可泛化的材料被原封不动背下来。' },
  ],
  // 《学习观》analogues of the proposition heuristics. These are declared
  // explicitly rather than inherited: a proposition-flavoured heuristic run
  // against the learning-view ontology would produce confident nonsense.
  assertionTypes: ['concept', 'feature', 'rule', 'discrimination_model', 'connection_model'],
  factCheckTypes: ['concept', 'feature', 'rule', 'discrimination_model', 'connection_model'],
  factCheckWeights: { rule: 0.9, connection_model: 0.85, discrimination_model: 0.8, concept: 0.7, feature: 0.6 },
  // Attach orphan 下料 to the 上料/知识 it should exemplify.
  relationWeave: {
    relations: ['exemplifies', 'builds', 'aligns_upper_lower'],
    sources: ['positive_example', 'negative_example', 'contrast_group', 'segment_example_group', 'data_or_experience'],
    targets: [
      'intension_description', 'feature_description', 'relation_material', 'factor_material',
      'property_material', 'concept', 'feature', 'rule', 'discrimination_model', 'connection_model',
    ],
  },
  renderOrder: [
    'concept', 'feature', 'rule', 'discrimination_model', 'connection_model',
    'intension_description', 'feature_description', 'positive_example', 'negative_example',
    'contrast_group', 'extension_contrast', 'relation_material', 'factor_material',
    'property_material', 'segment_example_group', 'verification_material',
    'data_or_experience', 'memory_material',
  ],
}

const PROFILES = Object.freeze({
  [ONTOLOGY_PROPOSITION]: PROPOSITION,
  [ONTOLOGY_LEARNING_VIEW]: LEARNING_VIEW,
})

/** All profile ids, in a stable order. */
export function ontologyIds() {
  return [ONTOLOGY_PROPOSITION, ONTOLOGY_LEARNING_VIEW]
}

/**
 * Raw profile data, keyed by id. This is what `scripts/gen-ontology-inline.mjs`
 * serialises into src/index.host.js: the dynamic-package sandbox provides no
 * `import`/`require`, so the host half cannot load this module at runtime and
 * must carry the data inline.
 */
export function rawProfiles() {
  return {
    [ONTOLOGY_PROPOSITION]: PROPOSITION,
    [ONTOLOGY_LEARNING_VIEW]: LEARNING_VIEW,
  }
}

/** True when `id` names a known profile. */
export function hasOntology(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, id)
}

/**
 * Resolve a profile by id, falling back to the default for unknown/absent ids.
 * Accepts alias spellings that may arrive from settings or a stored document.
 */
export function getOntology(id) {
  if (hasOntology(id)) return PROFILES[id]
  if (id === 'learning-view' || id === 'xuexiguan') return LEARNING_VIEW
  return PROFILES[DEFAULT_ONTOLOGY_ID]
}

/**
 * Resolve strictly: returns undefined for an unknown id instead of silently
 * falling back. Use when the caller must not guess (e.g. reading a stored
 * document's ontology before an append extraction).
 */
export function findOntology(id) {
  if (hasOntology(id)) return PROFILES[id]
  if (id === 'learning-view' || id === 'xuexiguan') return LEARNING_VIEW
  return undefined
}

/** Node type ids, in render order. */
export function nodeTypeIds(ontology) {
  return getOntology(ontology).renderOrder.slice()
}

/** Relation type ids. */
export function relationTypeIds(ontology) {
  return getOntology(ontology).relationTypes.map((relation) => relation.id)
}

/** Node type record by id, or undefined. */
export function nodeType(ontology, id) {
  return getOntology(ontology).nodeTypes.find((type) => type.id === id)
}

/** Relation type record by id, or undefined. */
export function relationType(ontology, id) {
  return getOntology(ontology).relationTypes.find((relation) => relation.id === id)
}

/**
 * Flat type-alias → canonical id map, e.g. { '事实': 'fact', fact: 'fact' }.
 * Mirrors the pre-existing TYPE_ALIASES lookup used to normalise model output.
 */
export function typeAliases(ontology) {
  const out = Object.create(null)
  for (const type of getOntology(ontology).nodeTypes) {
    out[type.id] = type.id
    for (const alias of type.aliases || []) out[alias] = type.id
  }
  return out
}

/** Flat relation-alias → canonical id map. */
export function relationAliases(ontology) {
  const out = Object.create(null)
  for (const relation of getOntology(ontology).relationTypes) {
    out[relation.id] = relation.id
    for (const alias of relation.aliases || []) out[alias] = relation.id
  }
  return out
}

/**
 * Relations that are allowed to start at `nodeTypeId`, as a Set. Used to reject
 * direction-reversed edges (e.g. a 正例 cannot be the target of `exemplifies`).
 * Returns undefined when the relation declares no endpoint constraint.
 */
export function allowedRelationsFrom(ontology, nodeTypeId) {
  const out = new Set()
  for (const relation of getOntology(ontology).relationTypes) {
    if (!relation.from || relation.from.includes(nodeTypeId)) out.add(relation.id)
  }
  return out
}

/** True when `relationId` may connect `fromTypeId` → `toTypeId` per the profile. */
export function relationAllows(ontology, relationId, fromTypeId, toTypeId) {
  const relation = relationType(ontology, relationId)
  if (!relation) return false
  if (Array.isArray(relation.from) && !relation.from.includes(fromTypeId)) return false
  if (Array.isArray(relation.to) && !relation.to.includes(toTypeId)) return false
  return true
}

/**
 * The presentation face sent to the client with a graph payload. Deliberately
 * carries only what the UI needs to draw: ids, labels, colours and layout
 * families. Prompts, aliases and validation sets stay host-side.
 */
/**
 * The material/knowledge split, straight from `evidenceRequiredTypes`.
 *
 * A node type either demands source evidence (it is 学习材料) or it does not (it
 * is 知识). Callers should ask this rather than infer the split from `layer` /
 * `modelKind`, which describe a different, orthogonal thing.
 */
export function materialTypeIds(ontology) {
  return new Set(getOntology(ontology).evidenceRequiredTypes || [])
}

/**
 * Whether a profile reads its node types as 知识 vs 学习材料.
 *
 * This is true exactly when the profile declares the 判别/联结 × 上料/下料
 * coordinates — the same condition under which the client draws the coordinate
 * grid. `evidenceRequiredTypes` alone is NOT that split: for the proposition
 * profile it means "must be quote-anchored", which makes `claim` and `rule`
 * evidence-bearing and `example` not, the opposite of the material reading.
 * Emitting `kind` there would mislabel every proposition type.
 */
export function hasMaterialCoordinates(profile) {
  return (profile.nodeTypes || []).some((type) => (type.layer && type.layer !== 'none') || (type.modelKind && type.modelKind !== 'none'))
}

export function describeOntology(ontology) {
  const profile = getOntology(ontology)
  const coordinates = hasMaterialCoordinates(profile)
  const materialIds = coordinates ? materialTypeIds(profile.id) : null
  return {
    id: profile.id,
    label: profile.label,
    summary: profile.summary,
    nodeTypes: profile.nodeTypes.map((type) => ({
      id: type.id,
      zh: type.zh,
      label: type.label,
      color: type.color,
      fill: type.fill,
      layer: type.layer || 'none',
      modelKind: type.modelKind || 'none',
      hint: type.hint || '',
      // 学习材料 vs 知识, surfaced so a consumer never has to re-infer the split
      // from the coordinates — the two are independent, and a material such as
      // memory_material has neither. Omitted entirely for a profile that does
      // not have this distinction (see hasMaterialCoordinates).
      ...(coordinates ? { kind: materialIds.has(type.id) ? 'material' : 'knowledge' } : {}),
    })),
    relationTypes: profile.relationTypes.map((relation) => ({
      id: relation.id,
      zh: relation.zh,
      family: relation.family,
      weight: relation.weight,
      hint: relation.hint || '',
    })),
    diagnostics: profile.diagnostics.map((diagnostic) => ({ id: diagnostic.id, zh: diagnostic.zh, definition: diagnostic.definition })),
  }
}

/**
 * Prompt fragments for the extraction contract. Kept here (rather than inline
 * in the host) so a new ontology only has to be declared once.
 */
export function promptLines(ontology) {
  const profile = getOntology(ontology)
  const nodeLine = profile.nodeTypes.map((type) => type.id + ' ' + type.zh).join(' / ')
  const relationLine = profile.relationTypes.map((relation) => relation.id + ' ' + relation.zh).join(' / ')
  return { nodeLine, relationLine }
}

// ---------------------------------------------------------------------------
// Memoised derived tables
//
// The host resolves these at many call sites, several of them inside per-node
// loops. Rebuilding a flat map or a Set on every call would be wasteful, so
// each derived table is built once per ontology id and reused.
// ---------------------------------------------------------------------------

const TABLE_CACHE = new Map()

function cached(ontology, key, build) {
  const profile = getOntology(ontology)
  const cacheKey = profile.id + '\u0000' + key
  let value = TABLE_CACHE.get(cacheKey)
  if (value === undefined) {
    value = build(profile)
    TABLE_CACHE.set(cacheKey, value)
  }
  return value
}

/** Memoised type-alias → canonical id map. */
export function typeAliasMap(ontology) {
  return cached(ontology, 'typeAliases', (profile) => {
    const out = Object.create(null)
    for (const type of profile.nodeTypes) {
      out[type.id] = type.id
      for (const alias of type.aliases || []) out[alias] = type.id
    }
    return out
  })
}

/** Memoised relation-alias → canonical id map. */
export function relationAliasMap(ontology) {
  return cached(ontology, 'relationAliases', (profile) => {
    const out = Object.create(null)
    for (const relation of profile.relationTypes) {
      out[relation.id] = relation.id
      for (const alias of relation.aliases || []) out[alias] = relation.id
    }
    return out
  })
}

/** Memoised Set of node type ids. */
export function nodeTypeSet(ontology) {
  return cached(ontology, 'nodeTypes', (profile) => new Set(profile.nodeTypes.map((type) => type.id)))
}

/** Memoised Set of relation type ids. */
export function relationTypeSet(ontology) {
  return cached(ontology, 'relationTypes', (profile) => new Set(profile.relationTypes.map((relation) => relation.id)))
}

function subsetSet(ontology, key, field) {
  return cached(ontology, key, (profile) => new Set(profile[field]))
}

export function entityCandidateSet(ontology) { return subsetSet(ontology, 'entityCandidates', 'entityCandidateTypes') }
export function claimCandidateSet(ontology) { return subsetSet(ontology, 'claimCandidates', 'claimCandidateTypes') }
export function evidenceRequiredSet(ontology) { return subsetSet(ontology, 'evidenceRequired', 'evidenceRequiredTypes') }
export function semanticGuardSet(ontology) { return subsetSet(ontology, 'semanticGuard', 'semanticGuardTypes') }
export function consumptionTypeSet(ontology) { return subsetSet(ontology, 'consumptionTypes', 'consumptionTypes') }

/** Consumption relations mirror every declared relation in the profile. */
export function consumptionRelationSet(ontology) {
  return cached(ontology, 'consumptionRelations', (profile) => new Set(profile.relationTypes.map((relation) => relation.id)))
}

/** Relation → required source node type, e.g. { example: 'example' }. */
export function sourceRuleMap(ontology) {
  return cached(ontology, 'sourceRules', (profile) => ({ ...profile.sourceRules }))
}

/** Memoised relation id → { family, weight } for the client layout. */
export function relationLayoutMap(ontology) {
  return cached(ontology, 'relationLayout', (profile) => {
    const out = Object.create(null)
    for (const relation of profile.relationTypes) out[relation.id] = { family: relation.family, weight: relation.weight }
    return out
  })
}

/**
 * 《学习观》graph diagnostics — what the ontology can CONCLUDE about a graph,
 * as opposed to what it can label.
 *
 * These are the reason the learning-view ontology exists at all: a graph whose
 * nodes are typed by coordinate (判别/联结 × 上料/下料) can be checked for the
 * specific collapses the book names — 上层丢失, 下层丢失, 记言代学, 言存义空,
 * 义存言空, 验证复用旧例. Labelling without diagnosing would be the same
 * "structure without meaning" the local re-cut mode was rejected for.
 *
 * Written as ONE self-contained function with no free variables so that
 * `scripts/gen-ontology-inline.mjs` can inline it into the sandboxed host via
 * `Function.prototype.toString()`. The host cannot `import`, so this is how the
 * implementation is shared instead of duplicated. Keep every dependency in the
 * parameter list; a closure reference here becomes a ReferenceError in the host.
 *
 * @param graph    a knowledge graph ({ nodes, edges })
 * @param profile  an ontology profile (nodeTypes carry layer / modelKind)
 * @returns        one entry per firing diagnostic, each with the node ids to blame
 */
export function diagnoseLearningView(graph, profile) {
  const findings = []
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes.filter((node) => node && typeof node.id === 'string' && node.id) : []
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : []
  const types = Array.isArray(profile && profile.nodeTypes) ? profile.nodeTypes : []
  const declared = Array.isArray(profile && profile.diagnostics) ? profile.diagnostics : []
  if (nodes.length === 0 || declared.length === 0) return findings

  const byId = new Map()
  for (const node of nodes) byId.set(node.id, node)

  // A material is a type that cannot stand alone: the profile lists exactly the
  // material types as the ones requiring evidence, so knowledge is the rest.
  // Deriving it beats hardcoding a second list that could drift from the profile.
  const materials = new Set(Array.isArray(profile.evidenceRequiredTypes) ? profile.evidenceRequiredTypes : [])
  const layerOf = new Map()
  const kindOf = new Map()
  for (const type of types) {
    layerOf.set(type.id, type.layer || 'none')
    kindOf.set(type.id, type.modelKind || 'none')
  }
  const layer = (node) => layerOf.get(node.type) || 'none'
  const kind = (node) => kindOf.get(node.type) || 'none'
  const isKnowledge = (node) => typeof node.type === 'string' && !materials.has(node.type)
  const isMaterial = (node) => typeof node.type === 'string' && materials.has(node.type)

  // Undirected adjacency: 上料 and 下料 are two sides of one knowledge, and the
  // extraction contract does not fix which way the edge points.
  const adj = new Map()
  for (const edge of edges) {
    const from = edge && edge.fromNodeId
    const to = edge && edge.toNodeId
    if (!from || !to || from === to || !byId.has(from) || !byId.has(to)) continue
    if (!adj.has(from)) adj.set(from, new Set())
    if (!adj.has(to)) adj.set(to, new Set())
    adj.get(from).add(to)
    adj.get(to).add(from)
  }
  const around = (id) => {
    const out = []
    const seen = adj.get(id)
    if (!seen) return out
    for (const other of seen) { const node = byId.get(other); if (node) out.push(node) }
    return out
  }
  const hasAround = (node, predicate) => around(node.id).some(predicate)
  // 上料/下料 tests look at MATERIAL neighbours only. Knowledge nodes carry
  // layer 'upper' as well, so counting them would let a knowledge node act as
  // its own 上料 and hide a genuine 下层丢失.
  const anyMaterial = (node, want) => hasAround(node, (other) => isMaterial(other) && layer(other) === want)

  const fire = (id, targets, detail) => {
    const declaredDiag = declared.find((diag) => diag.id === id)
    if (!declaredDiag) return
    const unique = [...new Set(targets.filter(Boolean))]
    if (unique.length === 0) return
    findings.push({ id, zh: declaredDiag.zh, severity: 'warning', count: unique.length, targets: unique.slice(0, 200), detail: detail || declaredDiag.definition })
  }

  const knowledge = nodes.filter(isKnowledge)
  const lowerMaterials = nodes.filter((node) => isMaterial(node) && layer(node) === 'lower')
  const upperMaterials = nodes.filter((node) => isMaterial(node) && layer(node) === 'upper')
  const verificationType = 'verification_material'
  const memoryType = 'memory_material'
  const isVerification = (node) => node.type === verificationType
  const isMemory = (node) => node.type === memoryType

  const quoteOf = (node) => {
    const raw = typeof node.quote === 'string' && node.quote.trim() ? node.quote : (typeof node.text === 'string' ? node.text : '')
    return raw.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  // 下层丢失 — 上料 exists but nothing exemplifies it: only recallable top-down.
  fire('lower_missing', knowledge.filter((node) => anyMaterial(node, 'upper') && !anyMaterial(node, 'lower')).map((node) => node.id),
    '上层材料存在但其下无任何下料支撑')

  // 上层丢失 — an example that was never abstracted into anything.
  fire('upper_missing', lowerMaterials.filter((node) => !hasAround(node, isKnowledge) && !anyMaterial(node, 'upper')).map((node) => node.id),
    '下料未挂到任何知识或上料')

  // 下上错配 — 上料 and 下料 joined directly across model kinds.
  const mismatched = []
  for (const lower of lowerMaterials) {
    for (const other of around(lower.id)) {
      if (!isMaterial(other) || layer(other) !== 'upper') continue
      const a = kind(lower)
      const b = kind(other)
      if (a !== 'none' && b !== 'none' && a !== b) mismatched.push(lower.id, other.id)
    }
  }
  fire('layer_mismatch', mismatched, '上料与下料直接相连但分属判别/联结不同模型')

  // 判联错配 — a model built from the other model's materials. A cluster that
  // only ever built a 判别模型 is not a mismatch: most single concepts legitimately
  // are discrimination-only. What IS wrong is a 联结模型 standing on 判别 下料.
  const modelNodes = knowledge.filter((node) => layer(node) === 'none' && kind(node) !== 'none')
  const wrongModel = []
  for (const model of modelNodes) {
    for (const other of around(model.id)) {
      if (!isMaterial(other)) continue
      const otherKind = kind(other)
      if (otherKind !== 'none' && otherKind !== kind(model)) wrongModel.push(model.id, other.id)
    }
  }
  fire('model_mismatch', wrongModel, '模型与其材料的判别/联结归属不一致')

  // 联结空载 — a 联结模型 that never says what it maps between. The book builds one
  // from 因素材料 (输入/输出/表征); a model carrying only its rules has the mapping
  // written inside its own text, where nothing can be checked against it. Verified
  // against the source book: this fires on real 联结模型 whose text states the
  // input and output but whose graph has no material for either.
  const mappedModels = new Set()
  for (const edge of edges) {
    if (edge && edge.relation === 'maps_between' && edge.fromNodeId) mappedModels.add(edge.fromNodeId)
  }
  fire('mapping_missing', knowledge.filter((node) => node.type === 'connection_model' &&
    !mappedModels.has(node.id) &&
    !hasAround(node, (other) => other.type === 'factor_material')).map((node) => node.id),
    '联结模型既无输入输出因素材料，也无映射关系')

  // 记言代学 — a description was stored but no feature/model was derived from it.
  const descriptions = upperMaterials.filter((node) => kind(node) === 'discrimination')
  fire('memorize_words', descriptions.filter((node) => !hasAround(node, isKnowledge) && !hasAround(node, isMemory)).map((node) => node.id),
    '只有描述，未从中提炼出特征或模型')

  // 言存义空 — the name is there and nothing else is.
  fire('words_without_meaning', knowledge.filter((node) => around(node.id).length === 0).map((node) => node.id),
    '知识节点没有任何材料或关系，只剩名称本身')

  // 义存言空 — examples are there but no statement of what they share.
  fire('meaning_without_words', knowledge.filter((node) => anyMaterial(node, 'lower') && !anyMaterial(node, 'upper')).map((node) => node.id),
    '有下料却无任何上料表述')

  // 验证复用旧例 — "verification" drawn from the same examples it should test.
  const lowerQuotes = new Set()
  for (const node of lowerMaterials) {
    if (isVerification(node)) continue
    const quote = quoteOf(node)
    if (quote) lowerQuotes.add(quote)
  }
  fire('verification_recycled', nodes.filter((node) => isVerification(node) && lowerQuotes.has(quoteOf(node))).map((node) => node.id),
    '验证材料的原文与已有下料重复，只验证了记忆而非泛化')

  // Connected components, used by 缺验证 below.
  const component = new Map()
  let componentId = 0
  for (const node of nodes) {
    if (component.has(node.id)) continue
    componentId += 1
    const queue = [node.id]
    component.set(node.id, componentId)
    while (queue.length > 0) {
      const current = queue.pop()
      for (const other of around(current)) {
        if (component.has(other.id)) continue
        component.set(other.id, componentId)
        queue.push(other.id)
      }
    }
  }

  // 缺验证 — materials were built but never tested. Judged per connected
  // component: verification of a cluster is a property of the cluster, and a
  // knowledge node whose verification hangs off its parent is not untested.
  const verifiedComponents = new Set()
  const materialComponents = new Set()
  for (const node of nodes) {
    if (!isMaterial(node) || isMemory(node)) continue
    const id = component.get(node.id)
    if (isVerification(node)) verifiedComponents.add(id)
    else materialComponents.add(id)
  }
  const untested = []
  for (const id of materialComponents) {
    if (verifiedComponents.has(id)) continue
    for (const node of knowledge) if (component.get(node.id) === id) untested.push(node.id)
  }
  fire('verification_missing', untested, '有学习材料但无验证材料')

  // 学习材料当记忆材料 — memorisation content used as if it were material.
  fire('material_as_memory', nodes.filter((node) => isMemory(node) && hasAround(node, isKnowledge)).map((node) => node.id),
    '记忆材料被当作学习材料挂到知识上')

  return findings
}

/** Node type id → { layer, modelKind }: the two coordinates of a material. */
export function nodeCoordinatesMap(ontology) {
  return cached(ontology, 'coordinates', (profile) => {
    const out = Object.create(null)
    for (const type of profile.nodeTypes) out[type.id] = { layer: type.layer || 'none', modelKind: type.modelKind || 'none' }
    return out
  })
}

export function assertionTypeSet(ontology) { return subsetSet(ontology, 'assertionTypes', 'assertionTypes') }
export function factCheckTypeSet(ontology) { return subsetSet(ontology, 'factCheckTypes', 'factCheckTypes') }

/** Fact-check type → worthiness weight; types absent from it are not checkable. */
export function factCheckWeights(ontology) {
  return cached(ontology, 'factCheckWeights', (profile) => ({ ...profile.factCheckWeights }))
}

/** Relation-weaver configuration: which orphan types attach to which targets. */
export function relationWeave(ontology) {
  return cached(ontology, 'relationWeave', (profile) => ({
    relations: new Set(profile.relationWeave.relations),
    sources: new Set(profile.relationWeave.sources),
    targets: new Set(profile.relationWeave.targets),
  }))
}

/**
 * Resolve an ontology id from an arbitrary carrier — a graph, a document row,
 * a task, or a bare `{ ontology }` object. Falls back to the default profile so
 * documents extracted before ontologies existed keep rendering untouched.
 */
export function ontologyIdOf(carrier) {
  const canonical = (value) => {
    const profile = typeof value === 'string' && value ? findOntology(value) : undefined
    return profile ? profile.id : ''
  }
  if (typeof carrier === 'string') return canonical(carrier) || DEFAULT_ONTOLOGY_ID
  if (!carrier || typeof carrier !== 'object') return DEFAULT_ONTOLOGY_ID
  const direct = canonical(carrier.ontology)
  if (direct) return direct
  const source = carrier.source && typeof carrier.source === 'object' ? carrier.source : null
  if (source) {
    const fromSource = canonical(source.ontology)
    if (fromSource) return fromSource
  }
  const meta = carrier.graphMeta && typeof carrier.graphMeta === 'object' ? carrier.graphMeta : null
  if (meta) {
    const fromMeta = canonical(meta.ontology)
    if (fromMeta) return fromMeta
  }
  return DEFAULT_ONTOLOGY_ID
}
