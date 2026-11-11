# 本地 PP-DocLayoutV3 版面分析

模型版面分析已作为可选路径接入 API 混合识别。普通 `npm start` 默认仍使用现有 `heuristic`；模型路径通过独立启动命令启用。主应用的覆盖式翻译与本地完整 PP-StructureV3 流程暂时保留原实现。

## 安装与启动

```powershell
npm install
npm run setup:layout -- --provider=cpu
npm run start:layout
```

`setup:layout` 下载约 134 MB ONNX 权重到 `.cache/models/pp-doclayout-v3/`，固定仓库 revision 和 SHA-256，校验后加载并执行一次预热。在 `.cache/layout-runtime.json` 记录已测试的执行后端。应用运行和模型安装命令均使用 Node，不要求 Python。网络代理从 `HTTPS_PROXY` / `HTTP_PROXY` 读取，不把代理凭据写入配置或输出。

可用环境变量：

| 变量 | 含义 |
| --- | --- |
| `HELIOS_LAYOUT=model` | 启用模型布局，可代替 `start:layout` |
| `HELIOS_LAYOUT=heuristic` | 使用原布局实现，也是普通启动的默认值 |
| `HELIOS_LAYOUT_PROVIDER=cpu` | CPU；未保存后端时默认选择 |
| `HELIOS_LAYOUT_PROVIDER=dml` | Windows DirectML，需自行检查驱动和结果 |
| `HELIOS_LAYOUT_THREADS=4` | CPU 推理线程数，限制为 1–8 |

DirectML 可通过 `npm run setup:layout -- --provider=dml` 检查并保存。`GET /api/layout/status` 返回当前模式、模型版本、后端及文件安装状态。模型未安装、校验失败或检测异常时明确报错；不会静默改回字体定位。

## 模型和处理契约

- 导出来源：`phungpx/PP-DocLayoutV3-ONNX`，revision `9dedaf7180045648d81929099a1391ef5d9b443c`。
- 模型 SHA-256：`29193c815d2d9a9db42cdebe400862fbdbf64e7e14c06f8b1f5064657c769b88`。
- 输入：RGB、800×800、NCHW float32、范围 0–1。PDF Workers 执行渲染、bicubic 缩放及 Tensor 构造。
- 一个独立 Layout Worker 持有一个 Session；有界队列、取消和文档关闭相互配合。原生推理完成后丢弃已取消请求的结果，活跃计算期间不额外加载另一个实例。
- 输出：读取 `logits`、`pred_boxes`、`order_logits` 三个头；Mask 不传回主线程。当前使用原始完整图，尚未发布裁掉 Mask 分支的独立模型。
- 后处理采用 sigmoid、全局 top-300 和 pointer votes；25 类 ID 按官方 Paddle `inference.yml` 映射，保留行内/独立公式及页眉/页脚图像的区别。
- 每个原生 Text Run 归属一个区域；未匹配的原文保留为额外文本块。记录匹配率及保留字符数，检测置信度与文字识别置信度分开保存。
- 行内公式只在原文范围完整、连续且不跨越其他 Runs 时原位替换。混合 Run 无法可靠定位时，保留原文、单独展示公式结果，并附警告。
- 检测到同栏上下倒置时，记录 `layout.readingOrder=geometric-fallback`，使用已有几何排序恢复顺序。区域语义和公式候选仍来自模型。
- 正文复用文字层；扫描文字按区域 OCR。公式、表格、图表分别使用 `Formula Recognition:`、`Table Recognition:`、`Chart Recognition:`。特殊区域原生文字作为 `originalText` / `nativeText` 保留。

模型 SHA、布局源码及执行后端进入缓存标识。切换布局模式后，用户再次启动识别时会备份旧状态并重新分析。普通启发式模式的已保存状态不会仅因安装模型而被清空。公式候选和裁剪图在模型模式中会变化，旧公式 PNG 一致性结论只适用于原启发式路径。

## 已完成的验证

`npm test` 包含纯 Tensor 后处理、固定类别 ID、阅读顺序、行内公式原文范围、混合 Run 保留、未匹配文字、扫描区域路由、重复框及推理队列取消检查，不需要下载权重。

真实 PDF 与模型检查：

```powershell
node scripts/verify-layout-model-real.cjs paper.pdf 2,8,16
$env:HELIOS_LAYOUT='model'
node scripts/verify-layout-pipeline-real.cjs paper.pdf 2,8,16
```

第二条验证真实 PDF Workers、共享 Session、裁剪、缓存与模拟识别 API 的组合，不调用真实云服务。设置 `HELIOS_LAYOUT_VALIDATION_DIR` 可导出原始 f32 输入、检测结果与报告。

官方参考对照使用隔离 Python 环境中的 Transformers 5.4.0 和官方 safetensors 权重，仅用于开发验证：

```powershell
python scripts/verify-layout-reference.py --model official-weight-directory --inputs validation-directory
```

2026-11-02：TOIS_MRAG 第 2、8、16 页，以及 14636-HuangL 第 1、4 页，共 5 页的 CPU ONNX 与官方 Transformers 类别、阅读顺序一致，最小区域 IoU >0.9999。前 3 页的 DirectML 类别集合一致、最小 IoU >0.99，但第 2 页有相邻块顺序差异；原始一致性验证会如实失败，该页应用层排序检查会触发并记录几何回退。没有把回退结果算作原始模型完全一致。

同机 RTX 3070 上预热后 DirectML 检测约 55–72 ms/页，CPU 约 1.0–1.3 秒/页。这些仅为该样本上的检测耗时；渲染、输入准备、云端识别、首次模型加载另计。第 8 页有 11 处行内公式成功对齐。另一份双栏论文第 4 页有 32 处对齐、8 处无法可靠对齐；后者保留原文并单独展示。样本不能证明总体公式召回率或全文 2 秒延迟。

## 仍需验收

尚未将模型设为普通启动的默认路径。跨页段落重建、主阅读器布局统一、本地 PP-StructureV3 的区域化执行留在后续阶段。表格/图表提示词已经过模拟接口合同测试，本次没有花费云 API 额度进行供应商实测。小字号公式漏检、混合 Run 精确到字形的对齐和复杂版式阅读顺序仍需标注样本验收。
