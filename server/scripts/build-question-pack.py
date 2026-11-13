#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「按年级配套」的题库包 JSON，给管理端「导入题库包」一次上传。

数据源与许可（署名会写进题库包的 sources 字段，请一并保留）：
  1. CMATH                 iskybear/cmath            小学数学应用题 1~6 年级，CC BY 4.0
  2. cn-math-taxonomy      xiaoyang111222            小学语文/英语/科学/道法/数学题，CC BY-NC 4.0
  3. pep-english-words     cyforkk                   人教小学英语 3~6 年级词汇，MIT（可选）

第 2 份数据是 CC BY-NC：仅可自用 / 教学 / 研究，**不可商用**；作者也声明
题目是 AI 生成的初稿、未经一线教师审核，家长可在后台停用或删掉不合适的题。

零第三方依赖，只用标准库。源数据缓存在 scripts/.cache/（不进 git）：
  python scripts/build-question-pack.py <输出路径.json>

换机器重新准备源数据（.cache 不在版本库里）：
  cmath_dev.jsonl           <- github.com/iskybear/cmath 的 dev 集 jsonl（600 条）
  taxonomy_questions.json   <- github.com/xiaoyang111222/cn-math-taxonomy 的 data/questions.json
  taxonomy_topics.json      <- 同仓 data/topics.json
  这两份大文件 raw 下载容易 SSL 中断，改用 Git Blob API 拉：
  先 GET /repos/<owner>/<repo>/contents/<path> 拿 sha，
  再 GET /repos/<owner>/<repo>/git/blobs/<sha>，带 Header
  Accept: application/vnd.github.raw+json
  pep-primary-g{3..6}-s{1,2}.json 脚本会自己从 PEP_BASE 下载，拿不到就跳过（英语题
  已由知识图谱覆盖），不必手工准备。

导入时服务端按「年级 + 学科 + 题干」去重，重复上传不会刷出重复题；
遇到中文学科名（如「科学」）会自动在该年级建一个自定义学科。
"""

import json
import os
import random
import re
import sys
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

CACHE = Path(__file__).resolve().parent / '.cache'
rng = random.Random(20261108)

# 每个「年级 × 学科」最多导多少道，避免题库膨胀把出题池稀释掉
CAP = {
    'math': 60, 'chinese': 80, 'english': 80,
    '科学': 50, '道德与法治': 30,
}
CMATH_CAP = 100          # CMATH 每个年级最多 100 道（本身各 100）
PEP_PER_BOOK = 20        # 每册英语生成多少组词汇题（一组 = 英译汉 + 汉译英）

SOURCES = [
    {'name': 'CMATH', 'repo': 'github.com/iskybear/cmath',
     'license': 'CC BY 4.0', 'use': '小学数学应用题 1~6 年级'},
    {'name': 'cn-math-taxonomy', 'repo': 'github.com/xiaoyang111222/cn-math-taxonomy',
     'license': 'CC BY-NC 4.0（非商用）', 'use': '小学语文 / 英语 / 科学 / 道德与法治 / 数学'},
    {'name': 'pep-english-words', 'repo': 'github.com/cyforkk/pep-english-words',
     'license': 'MIT', 'use': '人教版小学英语 3~6 年级词汇'},
]

SUBJECT_MAP = {
    None: 'math', 'math': 'math', 'chinese': 'chinese', 'english': 'english',
    'science': '科学', 'morality': '道德与法治',
}
SUBJECT_STYLE = {
    '科学': ('科', '#5BC8B0'),
    '道德与法治': ('道', '#FF9F6B'),
}
LEVEL_MAP = {'basic': 1, 'standard': 2, 'challenge': 3, 'advanced': 3}

items = []
seen = set()
count = Counter()          # 总统计（输出用）
cm_count = Counter()       # CMATH 每年级配额
tax_count = Counter()      # 知识图谱每「年级 × 学科」配额


def add(item):
    """统一入口：去重 + 字段兜底"""
    prompt = str(item.get('prompt') or '').strip()
    answer = str(item.get('answer') or '').strip()
    opts = [str(o).strip() for o in item.get('options') or [] if str(o).strip()]
    if not prompt or not answer or len(opts) < 2 or len(opts) > 6:
        return False
    # 正确答案必须在选项里，且不能被后续截断挤掉
    opts = ([answer] + [o for o in opts if o != answer])[:6]
    key = (item.get('grade'), item.get('subject'), prompt)
    if key in seen:
        return False
    seen.add(key)
    item.update({
        'prompt': prompt, 'answer': answer, 'options': opts,
        'type': 'choice', 'enabled': True,
        'level': item.get('level') or 2,
        'hint': item.get('hint') or '',
        'explanation': item.get('explanation') or '',
    })
    items.append(item)
    count[(item['grade'], item['subject'])] += 1
    return True


def numeric_options(ans):
    """整数答案自动造 3 个相近干扰项；非整数返回 None（这题就跳过）。
    按数量级给偏差，避免 3600 的干扰项写成 3601/3602/3603 那种一眼能猜的。"""
    if not re.fullmatch(r'-?\d+', str(ans)):
        return None
    n = int(ans)
    base = max(1, abs(n) // 12)
    cand = []
    for d in (base, 2 * base, -base, -2 * base, 3 * base,
              1, 2, -1, -2, 5, 10, 4, -4, 20, -20):
        v = n + d
        if v >= 0 and v != n and str(v) not in cand:
            cand.append(str(v))
        if len(cand) >= 3:
            break
    if len(cand) < 3:
        return None
    opts = [str(n)] + cand[:3]
    rng.shuffle(opts)
    return opts


# 依赖课文/配图才能答的题一律不要：电视上孩子面前没有课本也没有图
DEPENDENT = re.compile(
    r'如图|图中|下图|上图|看图|节选|这段|这篇|文中|课文|自然段|上文|下文|'
    r'哪一句|下列句子|原文|画线|最不一样|根据.{0,8}(短文|材料|内容)|读完|读了')

# 语文只保留「不看着课本也能答」的知识题（字词 / 古诗 / 成语 / 标点 / 修辞…），
# 阅读理解类的课文内容题一律不要
CHINESE_INDEPENDENT = re.compile(
    r'成语|反义词|近义词|量词|拼音|读音|多音|声调|偏旁|部首|笔画|笔顺|'
    r'修辞|比喻|拟人|夸张|排比|标点|病句|句式|词语|意思|《|古诗|诗句|朝代|'
    r'组词|同音|形近|错别字|关联词|把字句|被字句|查字典|音序|音节|'
    r'汉字结构|四字|歇后语|谚语|对联|量词|叠词')


def load(name):
    p = CACHE / name
    if not p.exists():
        raise SystemExit(f'缺源数据 {p}\n请先把三份数据放到 scripts/.cache/（见文件头说明）')
    return p


# ---------------------------------------------------------------- 1) CMATH 数学应用题
for line in load('cmath_dev.jsonl').read_text(encoding='utf-8').splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    g = int(r.get('grade', 0))
    if g not in range(1, 7):
        continue
    if cm_count[g] >= CMATH_CAP:
        continue
    ans = str(r.get('golden', '')).strip()
    opts = numeric_options(ans)      # 分数答案（如 2/6）自动跳过
    if not opts:
        continue
    step = int(r.get('reasoning_step') or 1)
    if add({
        'grade': g, 'subject': 'math',
        'level': 1 if step <= 1 else (2 if step == 2 else 3),
        'prompt': r['input'].strip(),
        'answer': ans, 'options': opts,
        'explanation': f'这是一道 {step} 步计算的应用题。',
        'source': 'CMATH·CC BY 4.0',
    }):
        cm_count[g] += 1

# ---------------------------------------------------------------- 2) 知识图谱：全学科
topics = {t['id']: t for t in json.loads(
    load('taxonomy_topics.json').read_text(encoding='utf-8'))}
questions = json.loads(load('taxonomy_questions.json').read_text(encoding='utf-8'))
if isinstance(questions, dict):
    questions = next(v for v in questions.values() if isinstance(v, list))

for q in questions:
    t = topics.get(q.get('topicId'))
    if not t:
        continue
    g = int(t.get('grade') or 0)
    if g not in range(1, 7):
        continue
    raw_subject = t.get('subject')
    if raw_subject is None and not str(t['id']).startswith('cnm_'):
        continue
    subject = SUBJECT_MAP.get(raw_subject)
    if not subject:
        continue                      # 物理 / 历史等初中学科本期不要
    if tax_count[(g, subject)] >= CAP.get(subject, 50):
        continue
    prompt = str(q.get('prompt') or '').strip()
    # 太长 / 必须看着课文或插图才答得出的一律跳过
    if len(prompt) > 160 or DEPENDENT.search(prompt):
        continue
    if subject == 'chinese' and not CHINESE_INDEPENDENT.search(prompt):
        continue
    qtype = q.get('type')
    if qtype == 'choice':
        choices = q.get('choices') or []
        texts = [str(c.get('text', '')).strip() for c in choices]
        letter = str(q.get('answer', '')).strip()
        hit = next((c for c in choices if str(c.get('key', '')).strip() == letter), None)
        if not hit or len(texts) < 2 or len(texts) > 6:
            continue
        answer = str(hit.get('text', '')).strip()
        options = texts
    elif qtype == 'numeric':
        answer = str(q.get('answer', '')).strip()
        options = numeric_options(answer)
        if not options:
            continue
    else:
        continue                      # short / self 要人工批改，跳过
    if len(answer) > 24 or any(len(o) > 24 for o in options):
        continue                      # 选项太长：电视上放不下，也多半是阅读理解题

    style = SUBJECT_STYLE.get(subject)
    item = {
        'grade': g, 'subject': subject,
        'level': LEVEL_MAP.get(q.get('difficulty'), 2),
        'prompt': prompt, 'answer': answer, 'options': options,
        'explanation': str(q.get('explanation') or '').strip()[:160],
        'source': 'cn-math-taxonomy·CC BY-NC 4.0',
    }
    if style:
        item['subjectShort'], item['subjectColor'] = style
    if add(item):
        tax_count[(g, subject)] += 1

# ---------------------------------------------------------------- 3) 人教英语词汇（可选）
PEP_BASE = 'https://raw.githubusercontent.com/cyforkk/pep-english-words/main/public/data/textbooks/'


def clean_zh(zh):
    s = re.sub(r'^[a-z]+\.\s*', '', str(zh or '').strip())
    s = re.split(r'[；;，,。]', s)[0].strip()
    return s[:14]


for grade in (3, 4, 5, 6):
    for sem in (1, 2):
        name = f'pep-primary-g{grade}-s{sem}.json'
        p = CACHE / name
        if not p.exists():
            try:
                req = urllib.request.Request(PEP_BASE + name, headers={'User-Agent': 'tvguard'})
                with urllib.request.urlopen(req, timeout=12) as resp:
                    p.write_bytes(resp.read())
            except Exception:
                continue              # 拿不到就跳过，英语题已由知识图谱覆盖
        try:
            book = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        words = []
        for unit in book.get('units', []):
            for w in unit.get('words', []):
                en = str(w.get('en') or '').strip()
                zh = clean_zh(w.get('zh'))
                if en and zh and len(en) <= 18:
                    words.append((en, zh))
        rng.shuffle(words)
        made = 0
        for en, zh in words:
            if made >= PEP_PER_BOOK:
                break
            others_zh = [z for _, z in words if z != zh][:3]
            others_en = [e for e, _ in words if e != en][:3]
            if len(others_zh) < 3 or len(others_en) < 3:
                continue
            add({'grade': grade, 'subject': 'english', 'level': 1,
                 'prompt': f'「{en}」的中文意思是？', 'answer': zh,
                 'options': [zh] + others_zh,
                 'explanation': f'{en}：{zh}', 'source': 'pep-english-words·MIT'})
            add({'grade': grade, 'subject': 'english', 'level': 1,
                 'prompt': f'「{zh}」对应的英文单词是？', 'answer': en,
                 'options': [en] + others_en,
                 'explanation': f'{en}：{zh}', 'source': 'pep-english-words·MIT'})
            made += 1

# ---------------------------------------------------------------- 输出
out = {
    'name': 'TvGuard 小学 1~6 年级配套题库包',
    'builtAt': datetime.now().isoformat(timespec='seconds'),
    'total': len(items),
    'sources': SOURCES,
    'note': '导入到管理端：题库管理 → 导入题库包。按年级+学科+题干去重，可重复上传。'
            '含 CC BY-NC 4.0 数据，仅限家庭自用/教学研究，不可商用。',
    'items': items,
}
dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('tvguard-questions.json')
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')

print('输出:', dest, f'({dest.stat().st_size / 1024 / 1024:.2f} MB)')
by_grade, by_subject = Counter(), Counter()
for (g, s), n in count.items():
    by_grade[g] += n
    by_subject[s] += n
print('总题数:', len(items))
print('按年级:', dict(sorted(by_grade.items())))
print('按学科:', dict(by_subject))
print('年级 × 学科:')
for g in range(1, 7):
    row = {s: count[(g, s)] for s in ('math', 'chinese', 'english', '科学', '道德与法治')}
    print(f'  {g}年级:', ' / '.join(f'{k} {v}' for k, v in row.items()))
