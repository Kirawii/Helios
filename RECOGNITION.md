# PDF 识别与排版

本轮重点是本机 PDF 识别和识别后的阅读排版。进入识别页面只展示结果；点击“开始全文识别”才加载 PaddleOCR，不要求模型 API Key。

## 在其他电脑运行

需要 Node.js 20+、Python 3.12，以及足够的内存运行 PP-StructureV3。先安装：

```sh
npm install
npm run setup:ocr
npm start
```

访问 http://localhost:3210，导入 PDF，点击“识别与排版”，再点击“开始全文识别”。初次运行会下载官方模型，缓存保存在项目 `.cache/`；下载和推理进度分别在界面和识别验证命令中显示。不要把其他操作系统的 `.venv/` 直接复制过去，应在目标电脑重新安装。

Python 依赖固定在 `ocr/requirements.txt` 和 `ocr/constraints.txt`。这组依赖已在 Apple Silicon / Python 3.12 上完成安装及真实单页推理；其他电脑的完整运行仍须执行下面的真实识别验证。

## 识别与排版

- 通过 PDFium 按 144 DPI 逐页渲染完整 PDF，包括扫描页，再调用 PP-StructureV3。没有前若干页的隐式截断。
- 保留解析器返回的阅读顺序、块 ID、原始类型、文本及可用置信度。界面显示跨页连续编号，低置信度内容提示校对。
- 原 PDF 与识别结果并排显示，也可单独阅读识别结果。正文自然换行，标题独立排版，图片、表格、独立公式和算法保留原文区域截图。
- 坐标归一化到原始页图像；关闭会改变坐标的图像方向校正和非线性矫正，避免裁剪区域与原 PDF 不一致。倾斜或方向错误的扫描件应先校正方向再导入。
- 编号支持双向定位与高亮，滚动按对应内容块跟随。校对文本后立即更新阅读结果，原始 OCR 内容仍保留。
- 页眉、页脚及纯页码默认不进入重排正文。OCR 偶尔会把版权说明识别成正文；可对照原图检查，不承诺模型能正确识别每一种版式。

## 资源与恢复

- 同一项目只允许一个 OCR 工作进程，包括应用和验证脚本；多个论文的识别在该进程中排队。
- 默认使用 CPU、2 个线程。空闲 30 秒后自动结束 Python 工作进程，释放模型内存；下一次明确启动时重新加载。
- 可通过 `HELIOS_OCR_THREADS`（1–8）、`HELIOS_OCR_IDLE_SECONDS` 和 `HELIOS_OCR_PYTHON` 调整线程、空闲释放时间和 Python 路径。
- `HELIOS_OCR_DEVICE` 默认为 `cpu`。使用 GPU 时，需先在目标电脑按 PaddlePaddle 官方说明安装与显卡及 CUDA 相符的推理包，再设置为如 `gpu:0`；本轮没有验证 GPU 推理。
- 停止识别会终止当前推理，保留已完成页面。服务重启后显示可继续状态；再次点击开始，只处理缺失页面。
- 结果保存在 `data/translations/<论文ID>/state.json`。目录沿用预留翻译数据结构，但独立识别接口不调用 LLM。

## 接口

| 接口 | 功能 |
| --- | --- |
| `GET /api/papers/:id/recognition` | 查看状态、页码进度、原始块和校对结果 |
| `POST /api/papers/:id/recognition` | 启动或继续识别；请求体 `{}`，无需密钥 |
| `POST /api/papers/:id/recognition/cancel` | 取消任务，保留已完成页面 |
| `PATCH /api/papers/:id/recognition` | 提交 `{revision, texts: {块ID: 校对文本}}`；版本冲突返回 409 |

翻译后台接口和模型预设已准备，但界面的本轮工作流只运行识别；全文翻译质量验收留待后续。

## 验证

轻量回归测试不会导入 Paddle、下载模型或运行本机推理：

```sh
npm test
python3 ocr/test_worker.py
```

目标电脑上明确执行真实识别，先验证一页，再验证整个文件：

```sh
npm run test:ocr -- scripts/citation-fixture.pdf 1
npm run test:ocr -- /absolute/path/to/paper.pdf
```

第三个参数可填逗号分隔页码，如 `1,2`。验证会检查请求页覆盖、块 ID 和归一化坐标。阅读顺序、识别准确率和裁剪质量还应对照原 PDF 人工检查。

当前证据：真实 PaddleOCR 已识别合成测试页及实际双栏论文第一页；实际论文整篇识别在用户要求降低 Mac 负载后停止，尚未完成跨页、实际表格与公式的完整验收。合成响应测试只用于验证接口、缓存和翻译预留逻辑，不证明真实翻译质量。
