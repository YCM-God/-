# CXM 英语真题机器可读版

本目录由 `convert_cxm.py` 自动生成，原始文件仍保留在 `E:\CXM`，未做任何修改。

## 目录

- `pdf-text/`：每份 PDF 的纯文本（UTF-8），用于全文检索或喂给 AI。
- `data/reading/`：单篇阅读理解 JSON（文章 + 5 道四选一 + 答案/解析）。
- `data/full-papers/`：整卷 JSON（Part I–IV、听力 1–25、阅读 46–55、答案、翻译参考、写作范文、解析全文）。
- `data/translation/`：翻译预测 50 篇 JSON。
- `data/vocabulary/`：四级高频词汇 TXT、CSV、JSON。
- `manifest.json`：所有文件的转换状态、题目/答案数量、重复文件与质量说明。
- `convert_cxm.py`：可重复运行的转换脚本。

## 数据约定

- 所有文本均为 UTF-8。
- `questions[].answer` 为 `null` 表示原 PDF 没有答案键，不是解析失败。
- 整卷 `questions[]` 覆盖听力 1–25 和阅读四选一 46–55；完形填空与信息匹配保留在 `sections[].raw` 中。
- `duplicates[]` 记录内容完全相同的副本；重复文件不重复生成 JSON。
- 翻译 PDF 的中文提示语存在字库缺字，`quality_note` 已标注；英文参考译文完整。
- 词汇 CSV 使用 UTF-8 with BOM，Excel 直接打开中文不乱码。

## 本次统计

- PDF 文件：43 份（去重后 38 份）
- 整卷：26 份
- 整卷听力+阅读题：685 道
- 整卷答案条目：780 条（已关联到听力/阅读题：445 道）
- 说明：部分“第 3 套”整卷的原 PDF 不含听力题目，`notes` 已标注；阅读 46–55 仍完整。
- 单篇阅读：11 份 / 55 道
- 翻译篇目：50 篇
- 词汇条目：690 条
- 重复 PDF：5 份
- 失败：0 个
- 跳过：2 个

## 重新生成

```bash
python "E:\cxm\convert_cxm.py"
```
