# PDF 识别与排版

使用 PaddleOCR 3.7.0 的 PP-StructureV3 完整文档流程。进入阅读器不会自动加载模型；点击“识别与排版”→“开始全文识别”后，在本机逐页处理整个 PDF，无需 API Key。

## 安装与 GPU

需要 Node.js 20+ 和 Python 3.12。执行：

```powershell
npm install
npm run setup:ocr
npm start
```

安装脚本检测到 NVIDIA 显卡时自动创建独立的 `.venv-gpu`，安装官方 CUDA 12.6 的 PaddlePaddle GPU 3.2.2；显卡驱动必须支持相应 CUDA 运行时。可明确指定 `npm run setup:ocr -- --gpu` 或 `--cpu`。CPU 环境保存在 `.venv`，两个环境不混装。安装脚本实际检查 CUDA 和 GPU 张量运算后，才在 `.cache/ocr-runtime.json` 标记就绪；应用随后自动使用 `gpu:0`。无需单独安装完整 CUDA 开发工具包。

Windows 固定 PaddlePaddle 3.2.2，避开 3.3.x 的 CPU oneDNN/PIR 回归。Python 依赖由 `ocr/requirements*.txt` 和 `ocr/constraints.txt` 固定。不要跨电脑复制虚拟环境，应在目标电脑重新安装并运行真实识别验证。

## 完整识别流程

以下模块默认全部启用：页面方向分类、页面曲面校正、文字行方向分类、印章识别、表格识别、公式识别、图表识别和区域检测。文字检测/识别、版面分类、阅读顺序恢复始终参与。每页输出会检查模块实际设置；缺失模块会报错，不会静默关闭公式或图表等能力。

主要模型：PP-DocLayout_plus-L、PP-DocBlockLayout、PP-OCRv5_server_det/rec、PP-FormulaNet_plus-L、PP-Chart2Table、UVDoc，以及表格分类、SLANeXt/SLANet、RT-DETR 单元格检测、方向与印章检测模型。表格内部互斥的推理算法保留官方选择逻辑，并非把相互替代的算法同时堆叠运行。

- PDFium 以 144 DPI 逐页渲染，扫描 PDF 同样执行真实识别，没有隐藏的页数上限。
- 独立公式转为 LaTeX，正文中的已检测公式以行内 LaTeX 排版；支持复制、校对后即时重新渲染，并保留原图核对。
- 表格显示经过安全过滤的 HTML 结构，支持复制 HTML；图表保留原图，同时展示模型提取的数据表并支持复制 CSV。印章识别文字也进入阅读视图。没有检测到某类内容时，其对应模块仍保持启用。
- 识别结果支持导出带段落锚点的 Markdown/LaTeX 和结构化 JSON。
- 保存实际参与识别的校正页面 PNG。并排视图左侧显示并标明“识别校正页面”，编号、裁剪和高亮均使用同一坐标系；点击“返回原文”恢复原 PDF 和其文字层、链接。
- 阅读视图对可见块生成跨页连续编号。页眉、页脚、纯页码、公式号、页边行号保留在原始数据中，不消耗阅读编号。公式号出现在相应公式和原图附近。
- 对图旁正文误分类、章节标题晚于下方正文的情况修复双栏阅读顺序；原块 ID、原始类型和模型顺序仍保留。
- OCR 的文字置信度仅为模型打分，不等于实际准确率。公式、图表、表格不使用普通文字置信度冒充结构准确率；复杂数学和图表数值应对照原图校对。

## 运行与恢复

同一项目只运行一个 OCR 进程，多篇论文排队；每页完成即保存。取消会结束推理，保留完整页面；继续时只处理缺失页。默认空闲 30 秒释放模型内存。公式与图表批量大小为 1，以控制显存占用，同时保留全部模块。

可配置 `HELIOS_OCR_DEVICE`、`HELIOS_OCR_PYTHON`、`HELIOS_OCR_THREADS`（1–8）、`HELIOS_OCR_IDLE_SECONDS`。`HELIOS_OCR_DIAGNOSTICS=1` 输出模型诊断；`PADDLE_PDX_MODEL_SOURCE=bos` 选择官方 BOS 下载源。模型下载不会上传 PDF。Windows 子进程统一使用 UTF-8，支持中文路径、希腊字母和数学字符。

连续 30 分钟无阶段/页面进展才超时；任务持续推进时不因全文耗时过长而中止。升级识别配置时，旧状态及校对保存为 `state-before-*.json`。结果在 `data/translations/<论文ID>/state.json`；`pages/` 保存校正 PNG 和完整模型 JSON。目录名称沿用预留翻译结构，独立识别不会调用语言模型。

## 接口与验证

| 接口 | 功能 |
| --- | --- |
| `GET /api/papers/:id/recognition` | 状态、进度、阅读顺序、文本、结构化内容 |
| `POST /api/papers/:id/recognition` | 启动/继续，请求体 `{}` |
| `POST /api/papers/:id/recognition/cancel` | 停止并保留已完成页 |
| `PATCH /api/papers/:id/recognition` | `{revision, texts: {块ID: 校对内容}}`，版本冲突返回 409 |
| `GET /api/papers/:id/recognition/pages/:page/image` | 校正页面 PNG |
| `GET /api/papers/:id/recognition/pages/:page/raw` | 该页完整模型 JSON |

```powershell
npm test
.venv-gpu\Scripts\python.exe ocr\test_worker.py
npm run test:ocr -- "C:\path\paper.pdf" 1,2
npm run test:ocr -- "C:\path\paper.pdf"
```

轻量测试检查上传下载、协议、进度/取消/恢复、阅读顺序、LaTeX 排版、图表解析、导出、校正图像接口与坐标验证，不加载模型。真实识别会加载全部模型，可通过 `HELIOS_OCR_REPORT` 和 `HELIOS_OCR_ASSETS` 指定报告和页面资源输出位置。机器测试证据和人工核对结论见 `output/ocr-audit/audit-status.md`。文字层坐标不能直接用来评价经过非线性校正后的框，准确率测试必须核对实际识别图像或独立对齐文本。
