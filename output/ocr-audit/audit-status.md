# OCR 与前端验收记录（2026-10-26）

## 已完成

- 使用用户指定的 Subspace GNN-2.1 (3).pdf（27 页）与 PI Control for GCN-3.0-WWW (1).pdf（12 页）。原文件未修改。
- 通过前端实际上传文件，复现文件已保存但阅读器打不开的问题：PDF 下载接口返回 `400 {"error":"Not Found"}`。
- 根因：独立测试服务的 `MOON_DATA_DIR` 位于项目 `.cache/ocr-audit-data`，Express 默认拒绝发送隐藏目录中的文件。默认 `data/` 目录不满足这一触发条件。
- 修复：PDF 下载限定到已存在的文献库记录及配置数据目录，同时允许读取该目录下的已知 PDF 文件。
- 新增隐藏数据目录回归覆盖；修复 Windows 测试退出时删除当前工作目录导致的 EPERM。
- `npm test` 全部通过。
- 浏览器确认两篇 PDF 分别渲染出 27 和 12 个页面；识别与排版入口可正常打开，没有观察到浏览器错误日志。
- 安装项目固定版本依赖，PaddlePaddle CPU 自检成功。尚未加载 PP-StructureV3 模型。
- 准备 `scripts/audit-ocr-quality.py`：以 OCR 块坐标截取 PDF 文字层，记录逐块文本、编辑距离及可见编号间断；编辑距离实现与普通动态规划在 200 组随机字符串上对照通过。

## 尚未完成

实际 OCR 推理、逐块错漏字比对、公式及表格区域裁剪检查、真实双栏阅读顺序与编号双向定位，均尚未验收，不能给出识别准确率。

电脑共有约 14.9 GB 内存；检查时可用约 0.4–0.5 GB。已请用户释放内存后继续，尚未在此状态下加载完整模型。

## 已核实的实现边界

- PaddleOCR 返回的 `parsing_res_list` 已按阅读顺序排列。当前代码按这个列表编号符合该接口约定，不能把人为打乱列表的测试当作真实排序缺陷。
- 服务按页码汇总，并按全部块生成跨页编号；前端随后过滤页眉、页脚和数字块，因此可见编号可能间断。编号连续并不能证明双栏顺序正确，编号间断也不等于漏识别。
- 原有 `test:ocr` 检查请求页覆盖、ID 唯一和归一化坐标，不计算文字准确率，也不自动验证语义阅读顺序。
- 逐块文字层比较仍需人工复核：公式字形与 LaTeX 的表达方式不同，PDF 文字层也可能错误；OCR 框外的遗漏需要另行检查。

## 测试服务和证据

- 地址：http://127.0.0.1:3211
- 文献库：项目 `.cache/ocr-audit-data`，与默认文献库隔离。
- `upload-fixed.png`：PI Control 阅读器及识别面板。
- `subspace-opened.png`：Subspace 阅读器。
- 原始页面渲染与文字层对照准备文件保存在 `.cache/ocr-audit-evidence`。

## 官方接口约定

PaddleOCR 文档说明解析结果列表本身为阅读顺序：
https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PP-StructureV3.en.md
