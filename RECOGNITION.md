# PDF 识别与排版

OCR 支持两种方式：本地部署 PaddleOCR 3.7.0 的 PP-StructureV3，或调用硅基流动 API。识别与重排阅读位于独立调试前端 `http://localhost:3210/ocr-debug/`，主应用保留原有阅读和覆盖式翻译界面。选择识别方式后，点击“开始全文识别”才执行任务。

## 硅基流动 API

仅需 `npm install` 和 `npm start`，无需安装 Python、Paddle 或下载本地 OCR 模型。在 `/ocr-debug/` 中选择“API · 硅基流动”，填写 API Key。默认地址为 `https://api.siliconflow.cn/v1`，默认模型为 `PaddlePaddle/PaddleOCR-VL-1.5`；模型名称可修改，是否可用以硅基流动账号实际支持为准。浏览器保存的旧 DeepSeek-OCR 配置会自动迁移为该模型。

- 通过 Node/PDF.js 将 PDF 按 144 DPI 逐页渲染，使用 `/chat/completions` 的图像输入接口。只有明确点击开始后才把页面图像发送到配置的 API 地址。
- PaddleOCR-VL-1.5 使用 `OCR:` 提示词识别页面。可选的 DeepSeek-OCR 仍兼容官方 grounding 提示词，解析 `<|ref|>` / `<|det|>` 标记，保留阅读顺序、块类型和一个块覆盖的多个坐标区域。位置范围依照模型参考实现的 0–999 坐标归一化；不会把坐标内容作为代码执行。
- 若模型只返回 Markdown 或纯文本，则保留完整页面文字并标注“仅页级定位”，不伪造文字框或置信度。API 不承诺具备本地 PP-StructureV3 的全部识别模块。
- API 使用原始渲染页面作为坐标底图，本地使用实际校正后的页面；各自的底图和坐标保持一致。接口输出统一为 `pages[].blocks[]`，供后续断句、翻译和定位使用。
- 每页完成后保存；取消或失败保留完整页面，再次开始只处理缺失页。截断的输出不会当作完成页面保存，可提高“最大输出 Token”后继续。API 错误不会自动切换到本地引擎。
- API Key 只保留在当前页面和执行任务的内存中，不写入 localStorage、识别状态、导出或原始结果文件。也可在服务端配置 `SILICONFLOW_API_KEY`。
- 切换本地/API、接口地址或模型时，当前结果与校对会备份为 `state-before-*.json`，并使用独立资源目录重新识别，避免混用不同引擎的文本与坐标。更新 Key 或最大输出长度不会清除已完成页面。

命令行验证也支持 API（会真实调用服务）：

```powershell
$env:HELIOS_OCR_MODE = 'api'
$env:SILICONFLOW_API_KEY = '<你的 API Key>'
# 可选：HELIOS_OCR_API_URL、HELIOS_OCR_API_MODEL
npm run test:ocr -- 'C:\path\paper.pdf' 1
```

接口协议参考：[硅基流动多模态输入](https://api-docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)、[DeepSeek-OCR 官方示例](https://github.com/deepseek-ai/DeepSeek-OCR)。

## 本地部署与 GPU

需要 Node.js 20+ 和 Python 3.12。执行：

```powershell
npm install
npm run setup:ocr
npm start
```

安装脚本检测到 NVIDIA 显卡时自动创建独立的 `.venv-gpu`，安装官方 CUDA 12.6 的 PaddlePaddle GPU 3.2.2；显卡驱动必须支持相应 CUDA 运行时。可明确指定 `npm run setup:ocr -- --gpu` 或 `--cpu`。CPU 环境保存在 `.venv`，两个环境不混装。安装脚本实际检查 CUDA 和 GPU 张量运算后，才在 `.cache/ocr-runtime.json` 标记就绪；应用随后自动使用 `gpu:0`。无需单独安装完整 CUDA 开发工具包。

Windows 固定 PaddlePaddle 3.2.2，避开 3.3.x 的 CPU oneDNN/PIR 回归。Python 依赖由 `ocr/requirements*.txt` 和 `ocr/constraints.txt` 固定。不要跨电脑复制虚拟环境，应在目标电脑重新安装并运行真实识别验证。

访问 `/ocr-debug/`，选择文献库中已有的 PDF 或上传新文件，再点击“开始全文识别”。调试页与主应用共享文献库和后端，也可通过 `/ocr-debug/?paper=<论文ID>` 直接打开文档。

## 本地完整识别流程

以下模块默认全部启用：页面方向分类、页面曲面校正、文字行方向分类、印章识别、表格识别、公式识别、图表识别和区域检测。文字检测/识别、版面分类、阅读顺序恢复始终参与。每页输出会检查模块实际设置；缺失模块会报错，不会静默关闭公式或图表等能力。

主要模型：PP-DocLayout_plus-L、PP-DocBlockLayout、PP-OCRv5_server_det/rec、PP-FormulaNet_plus-L、PP-Chart2Table、UVDoc，以及表格分类、SLANeXt/SLANet、RT-DETR 单元格检测、方向与印章检测模型。表格内部互斥的推理算法保留官方选择逻辑，并非把相互替代的算法同时堆叠运行。

- PDFium 以 144 DPI 逐页渲染，扫描 PDF 同样执行真实识别，没有隐藏的页数上限。
- 独立公式转为 LaTeX，正文中的已检测公式以行内 LaTeX 排版；支持复制、校对后即时重新渲染，并保留原图核对。
- 表格显示经过安全过滤的 HTML 结构，支持复制 HTML；图表保留原图，同时展示模型提取的数据表并支持复制 CSV。印章识别文字也进入阅读视图。没有检测到某类内容时，其对应模块仍保持启用。
- 识别结果支持导出带段落锚点的 Markdown/LaTeX 和结构化 JSON。
- 保存实际参与识别的校正页面 PNG。并排视图左侧显示并标明“识别校正页面”，编号、裁剪和高亮均使用同一坐标系；原始 PDF 可在主应用中阅读并使用其文字层和链接。
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
| `POST /api/papers/:id/recognition` | 启动/继续；`ocr.mode` 为 `local` 或 `api`，省略时延续已选引擎，首次默认本地 |
| `POST /api/papers/:id/recognition/cancel` | 停止并保留已完成页 |
| `PATCH /api/papers/:id/recognition` | `{revision, texts: {块ID: 校对内容}}`，版本冲突返回 409 |
| `GET /api/papers/:id/recognition/pages/:page/image` | 校正页面 PNG |
| `GET /api/papers/:id/recognition/pages/:page/raw` | 该页完整模型 JSON |

本地请求：`{"ocr":{"mode":"local"}}`。API 请求：

```json
{"ocr":{"mode":"api","strategy":"hybrid","concurrency":8,"baseUrl":"https://api.siliconflow.cn/v1","model":"PaddlePaddle/PaddleOCR-VL-1.5","key":"<API Key>","maxTokens":4096}}
```

翻译后台的 `POST /api/papers/:id/translation` 接受同样的 `ocr` 配置；OCR 配置与语言模型翻译配置相互独立。`npm test` 使用模拟硅基流动接口验证请求、缓存隔离、续跑、取消和密钥保护，不调用真实云 API。

```powershell
npm test
.venv-gpu\Scripts\python.exe ocr\test_worker.py
npm run test:ocr -- "C:\path\paper.pdf" 1,2
npm run test:ocr -- "C:\path\paper.pdf"
```

轻量测试检查上传下载、协议、进度/取消/恢复、阅读顺序、LaTeX 排版、图表解析、导出、校正图像接口与坐标验证，不加载模型。真实识别会加载全部模型，可通过 `HELIOS_OCR_REPORT` 和 `HELIOS_OCR_ASSETS` 指定报告和页面资源输出位置。机器测试证据和人工核对结论见 `output/ocr-audit/audit-status.md`。文字层坐标不能直接用来评价经过非线性校正后的框，准确率测试必须核对实际识别图像或独立对齐文本。

## API 混合解析与延迟

`strategy: hybrid` 是 API 默认策略；`full` 保留逐页整页识别兼容方式。本地模式继续执行完整 PP-StructureV3，不受该策略影响。

- 原生文字与行位置直接提取；保留 `originalText`、行内文本范围和坐标。公式结果按原文范围替换，`mathReplacements` 保留对应关系。图像原图保留，API 文字另存 `ocrText`。
- 根据 PDF 字体、文字位置、位图和包含图形的 Form 定位候选区域。简单 Unicode 变量和表格数值直接保留；扫描页或文字层不可用的页回退整页。此步骤是几何启发式，未接入学习式版面检测；特殊字体公式、未封装的矢量图和复杂阅读顺序仍可能遗漏或误分，不能把候选处理完成当作准确率保证。
- 布局解析、本地准备和 API 请求分开推进，一页候选准备好即进入跨页请求池，同时继续解析后续页面。`concurrency` 为 1–32，默认 8，仅限制单任务；多个任务仍共享供应商配额。提高并发可能受到云端限流影响，不能保证全文耗时等于最慢单页。
- 多区域页复用同页位图；仅图片候选的页面可按联合区域渲染。公式页保留原先的像素网格，公式检测、提示词、区域坐标与 PNG 输入不变。对满足单张不透明图片、无裁剪/叠字/矢量绘制等保守条件的图片区域直接取解码图像；其余保留渲染外观。
- OCR 缓存按模型、接口、任务类型、准备版本、PDF 内容和区域坐标先查询，命中即可跳过区域裁剪；同时兼容旧 PNG 内容哈希缓存。429、截断、空响应和超时不写成功缓存。更改 Token 上限或 API 并发不会清除成功结果。切换策略会备份旧状态。
- 原生文字即刻保存为草稿，所有候选成功后页面才 `complete: true`。失败页为 `partial`，继续时补缺；全部 OCR 完成前不启动后续翻译。没有 Key 时仍可提取原生文字和复用已有缓存，缺失区域会明确报错。Markdown 导出也标注未完成页。
- 调试页按需绘制可见 PDF 页，不再等待全文画布渲染才显示识别状态。显示实际总耗时、解析耗时、区域成功/失败/缓存数；不会将文字就绪称为全文 OCR 完成。

本地准备耗时可复现（不调用 API，也不修改文献库）：

```powershell
node scripts/benchmark-ocr-native.cjs "C:\path\paper.pdf" report.json
```

2026-10-27 开发机冷启动测试：24 页文字型论文，105 个候选区域，裁剪 PNG 总计约 1.53 MB；一次测量中，打开与布局解析约 2.39 秒，全部裁剪约 3.22 秒，合计约 5.61 秒。这是本地串联阶段基准，实际任务会让解析、裁剪和云请求重叠；没有测量该文档的真实云端完整耗时，尚未达到或验证全文 2 秒目标。纯文字提取的既有约 0.42 秒测量不包含这些步骤，不能与完整 OCR 混用。

公式提示词采用模型官方 `Formula Recognition:`，图像文字采用 `OCR:`，参考 [PaddleOCR-VL-1.5 模型说明](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5)。`npm test` 增加真实 PDF 原生提取/裁剪、区域替换范围、流水线重叠、并发上限、失败续跑、扫描回退及取消的模拟接口验证；没有以模拟耗时冒充云端性能。

## 本地准备预热、线程池与缓存

`npm start` 在监听端口之前预热 PDF.js 与 worker 模块。常驻 `worker_threads` 池默认最多 4 个线程；本地解析、渲染、裁剪和 PNG 编码均在池内执行，不占用 Web 服务线程。页面首次分配给负载较低的线程，后续同页操作保持线程归属，复用已打开文档、字体、绘图指令和位图。空闲线程保留模块用于下次任务，文档关闭时释放文档和页面画布。可通过 `HELIOS_PDF_WORKERS` 设置 1–8 个线程；API 的 `concurrency` 控制网络请求，两者独立。常驻池会增加空闲内存占用。

准备缓存默认在 `.cache/pdf-preparation/<PDF内容哈希>/<准备版本>/`，可通过 `HELIOS_PDF_CACHE` 指定根目录。缓存保存文档页数、原生布局和裁剪 PNG；准备版本包含解析/渲染代码、PDF.js 版本和像素设置。布局及图片数据有校验和，损坏时重新计算，写入通过临时文件原子替换。缓存命中可以完全跳过 worker 调用；不把 API Key 写入准备缓存。模型或接口变化只影响 OCR 结果缓存，原生布局和相同裁剪图仍可复用。

本地准备最多同时推进 4 页，每页最多 16 个区域组成一次 worker RPC；PNG 与各自校验和打包进 `page-N.crops`，避免每个区域单独往返和写元数据文件。旧的逐区域缓存仍可读取并迁移，一项损坏只重算该项。已解析的待准备页面按 PDF 绘图指令数量排序，线程在空闲时优先执行排队中的解析任务；正在执行的绘制不会被抢占，不依赖特定页码。页面裁剪完成后立即释放 worker 画布，不等云端返回。

准备完成的结果队列最多暂存 128 个区域、32 MiB PNG；单个超限图片允许独占队列，保持公式分辨率。该限制仅针对等待 API 的队列，API 在途图片、本地进行中的批次、页位图与 PDF.js 文档内存另计。缓存初次扫描形成文件名索引，缺失结果不逐区域触发同步文件读取；中间页面状态最多约每 100 ms 发布一次，初始、终态及任务退出时立即保存。取消或致命错误会唤醒阻塞队列，并等待各阶段退出后关闭文档；单个区域失败保留其余成功结果。

新旧实现按同样的“解析完再裁剪”本地工作量对照，排除 API 与流水线重叠因素：

```powershell
node scripts/benchmark-ocr-preparation.cjs "C:\path\paper.pdf" report.json
```

2026-10-30 的一次 24 页实测：旧实现约 3.276 秒，启动预热完成后、准备缓存为空的新实现约 2.425 秒，准备缓存命中约 0.066 秒。启动预热另计约 0.156 秒。105 个候选区域和坐标一致，86 个公式 PNG 与旧实现逐字节一致；这份文档没有命中保守的图片直接提取条件。线程数、机器负载和缓存会影响测量，以上不是云端 OCR 完整耗时，也没有宣称首次全文处理已达到 2 秒。

`npm test` 额外覆盖真实双线程执行、公式裁剪一致、跨文档打开复用持久缓存、缓存损坏恢复、同路径 PDF 内容变化失效、调用方修改隔离、取消对其他文档无影响和保守图片提取条件。准备对照脚本还会核对真实文档全部公式输入，发现改变时直接失败。

生产流水线也可独立测量本地部分：

```powershell
node scripts/benchmark-ocr-pipeline.cjs "C:\path\paper.pdf" pipeline.json report.json
```

最后的 `report.json` 为上面准备对照脚本的输出，用于核对全部公式 PNG 摘要，可省略。脚本使用模拟接口，把响应一直暂停到本地准备完成；不会访问云端，输出的模拟请求总耗时不能当作真实 OCR 延迟。每轮使用空布局/图片/OCR 缓存，计时前仅已知文档页数。

2026-10-31 最终复测，同一份 24 页 PDF：解析后裁剪的相同工作量，主线程参照 3.777 秒，新实现空准备缓存 2.886 秒，缓存命中 0.062 秒；105 个区域只需 20 次裁剪批量 RPC，准备文件由逐区域 PNG/元数据变为 17 个页包，连同 24 份布局和文档信息共 42 个文件。86 个公式输入逐字节一致，摘要为 `223c837015d85092ffb859feea4e513329ffd3d5055c6634c5e6806cf3848d29`。生产流水线两轮空缓存本地准备分别约 3.310、2.464 秒，峰值排队 97 个区域、约 1.13 MB PNG。此前轮次曾测到 2.35 秒，但尚未稳定达到 2 秒；不能用最短一轮代表常态。完整真实 API 耗时本次未测。原始结果见 `.cache/ocr-preparation-optimized.json` 和 `.cache/ocr-pipeline-optimized.json`。
