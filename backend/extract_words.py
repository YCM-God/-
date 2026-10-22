# -*- coding: utf-8 -*-
"""
从上级目录的 index.html 中提取四级高频词汇（WORDS 数组），生成 words.json 供后端题库使用。

用法：在 backend/ 目录下运行  python extract_words.py
     （运行前请确保 ../index.html 存在）

输出：words.json  ->  [{"word": "...", "meaning": "..."}, ...]
说明：只提取 word 与 meaning 两个字段；音标、例句不进入后端题库（后端只需出题用）。
"""
import json
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "index.html")
OUT = os.path.join(HERE, "words.json")


def extract(src):
    start = src.index("const WORDS = [")
    end = src.index("const EXAMPLES =")
    block = src[start:end]

    # 每条目形如 { word: "...", phonetic: "...", meaning: "..." }
    # 兼容字段间空格与换行；meaning 中不应出现英文双引号（四级释义均为纯文本）
    pat = re.compile(
        r'\{\s*word:\s*"([^"]*)"\s*,\s*phonetic:\s*"([^"]*)"\s*,\s*meaning:\s*"([^"]*)"\s*\}'
    )
    words = []
    seen = set()
    for m in pat.finditer(block):
        w = m.group(1).strip()
        meaning = m.group(3).strip()
        if not w or not meaning or w in seen:
            continue
        seen.add(w)
        words.append({"word": w, "meaning": meaning})
    return words


def main():
    if not os.path.exists(INDEX):
        print("未找到 ../index.html，请确认脚本位于 backend/ 目录下。")
        sys.exit(1)
    with open(INDEX, encoding="utf-8") as f:
        src = f.read()
    words = extract(src)
    if not words:
        print("提取失败：未能从 index.html 解析出任何词汇。")
        sys.exit(1)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, indent=1)
    print("已生成 %s，共 %d 个词汇。" % (OUT, len(words)))


if __name__ == "__main__":
    main()
