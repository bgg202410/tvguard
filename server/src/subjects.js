'use strict';

/**
 * 学科定义 + 非数学学科的预置题库。
 *
 * 学科是「按年级独立一套」的：一年级可以有「拼音」，三年级可以有「英语」「科学」，
 * 家长在管理端可以给自己年级的学科改名、改颜色、增删自定义学科。
 * 配置落在 data/subjects.json（不随代码升级覆盖），首次启动按内置 4 科各复制一份。
 * 题目上只带 grade + subject 两个字段，题库页按「年级 → 学科」两级筛选。
 *
 * 内置 4 科的 key 全局通用（math/chinese/pinyin/english），保证老题和老策略不动；
 * 自定义学科的 key 带年级前缀（如 g3_science），只在自己年级里有效。
 *
 * 后面 BANKS 是语文/拼音/英语的预置题库，格式 [题干, 答案, [干扰项], 提示]。
 */

const fs = require('fs');
const path = require('path');

const SUBJECTS = [
  { key: 'math', name: '数学', short: '数', color: '#4C8DFF', desc: '口算 · 竖式 · 应用题' },
  { key: 'chinese', name: '语文', short: '语', color: '#F5CE6B', desc: '识字 · 词语 · 古诗 · 成语' },
  { key: 'pinyin', name: '拼音', short: '拼', color: '#4ADE80', desc: '声母 · 韵母 · 声调 · 多音字' },
  { key: 'english', name: '英语', short: '英', color: '#A78BFA', desc: '单词 · 短语 · 简单语法' }
];

const SUBJECT_KEYS = SUBJECTS.map(s => s.key);
const GRADES = [1, 2, 3, 4, 5, 6];
const GRADE_NAMES = {
  0: '通用', 1: '一年级', 2: '二年级', 3: '三年级',
  4: '四年级', 5: '五年级', 6: '六年级'
};

/**
 * 「出题范围」的年级，和题目身上的 grade 不是一回事：
 *   -1 = 只出通用题，0 = 不限（全库随机），1~6 = 出这个年级的题 + 通用题。
 * 后台不选任何筛选时就是 0，题目上的 grade 仍然只有 0~6。
 */
const QUIZ_GRADES = [-1, 0, 1, 2, 3, 4, 5, 6];
const QUIZ_GRADE_NAMES = Object.assign({ '-1': '仅通用题', 0: '不限' }, GRADE_NAMES);

function normalizeQuizGrade(v) {
  const n = Number(v);
  return QUIZ_GRADES.includes(n) ? n : 0;
}

function quizGradeName(v) {
  return QUIZ_GRADE_NAMES[normalizeQuizGrade(v)] || '不限';
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SUBJECTS_FILE = path.join(DATA_DIR, 'subjects.json');

function defaultGradeSubjects() {
  const out = {};
  for (const g of GRADES) out[String(g)] = SUBJECTS.map(s => Object.assign({ builtin: true }, s));
  return out;
}

function readSubjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaultGradeSubjects();
    const out = {};
    for (const g of GRADES) {
      const list = Array.isArray(raw[String(g)]) ? raw[String(g)] : [];
      // 内置学科永远补齐，删不掉；自定义学科照单全收
      const seen = new Set(list.map(x => x && x.key));
      const merged = SUBJECTS.filter(s => !seen.has(s.key)).map(s => Object.assign({ builtin: true }, s));
      out[String(g)] = merged.concat(list.filter(x => x && x.key && x.name));
    }
    return out;
  } catch (e) {
    return defaultGradeSubjects();
  }
}

let gradeMap = readSubjects();

function saveSubjects() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SUBJECTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(gradeMap, null, 2), 'utf8');
  fs.renameSync(tmp, SUBJECTS_FILE);
}

/** 某个年级的学科列表；grade=0 / 不传 = 所有年级合并（按 key 去重，内置优先） */
function gradeSubjects(grade) {
  const g = Number(grade);
  if (GRADES.includes(g)) return gradeMap[String(g)] || [];
  const seen = new Set();
  const out = [];
  for (const s of SUBJECTS) { seen.add(s.key); out.push(Object.assign({ builtin: true }, s)); }
  for (const key of Object.keys(gradeMap)) {
    for (const s of (gradeMap[key] || [])) {
      if (!seen.has(s.key)) { seen.add(s.key); out.push(s); }
    }
  }
  return out;
}

function allGradeSubjects() {
  const out = {};
  for (const g of GRADES) out[String(g)] = gradeSubjects(g).map(s => Object.assign({}, s));
  return out;
}

/** 学科 key 或中文名 → key。认不出来返回 ''。带 grade 时只认这个年级的自定义学科 */
function normalizeSubject(v, grade) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (SUBJECT_KEYS.includes(lower)) return lower;
  const builtin = SUBJECTS.find(x => x.name === s || x.short === s);
  if (builtin) return builtin.key;
  const list = gradeSubjects(grade);
  const hit = list.find(x => x.key === s || x.name === s || x.short === s);
  return hit ? hit.key : '';
}

function subjectMetaOf(key, grade) {
  return gradeSubjects(grade).find(x => x.key === key) || null;
}

function subjectName(key, grade) {
  const b = SUBJECTS.find(x => x.key === key);
  if (b) return b.name;
  const m = subjectMetaOf(key, grade);
  return m ? m.name : key;
}

function subjectColor(key, grade) {
  const b = SUBJECTS.find(x => x.key === key);
  if (b) return b.color;
  const m = subjectMetaOf(key, grade);
  return (m && m.color) || '#7D8794';
}

/** 过滤出一组合法且不重复的学科，空则回落到全部（年级内） */
function normalizeSubjects(list, grade) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,，\s|]+/);
  const out = [];
  for (const item of arr) {
    const k = normalizeSubject(item, grade);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.length ? out : gradeSubjects(grade).map(s => s.key);
}

/** 按年级新增自定义学科。名字必填，颜色有默认值 */
function addGradeSubject(grade, input) {
  const g = Number(grade);
  if (!GRADES.includes(g)) return { error: '年级只能是 1~6' };
  const name = String((input && input.name) || '').trim();
  if (!name) return { error: '学科名称不能为空' };
  const list = gradeSubjects(g);
  if (list.some(s => s.name === name)) return { error: '这个年级已经有同名学科了' };
  const key = `g${g}_${Date.now().toString(36)}`;
  const item = {
    key, name,
    short: String((input && input.short) || name.slice(0, 1)).trim() || name.slice(0, 1),
    color: String((input && input.color) || '').trim() || '#5BC8B0',
    desc: String((input && input.desc) || '').trim(),
    builtin: false
  };
  gradeMap[String(g)] = list.concat([item]);
  saveSubjects();
  return { subject: item };
}

function updateGradeSubject(grade, key, patch) {
  const g = Number(grade);
  if (!GRADES.includes(g)) return { error: '年级只能是 1~6' };
  const list = gradeSubjects(g);
  const item = list.find(s => s.key === key);
  if (!item) return { error: '这个年级里没有这个学科' };
  if (item.builtin && patch && patch.key) return { error: '内置学科不能改标识' };
  for (const f of ['name', 'short', 'color', 'desc']) {
    if (patch && patch[f] !== undefined) item[f] = String(patch[f]).trim();
  }
  if (!item.name) return { error: '学科名称不能为空' };
  gradeMap[String(g)] = list.slice();
  saveSubjects();
  return { subject: item };
}

function removeGradeSubject(grade, key) {
  const g = Number(grade);
  if (!GRADES.includes(g)) return { error: '年级只能是 1~6' };
  const list = gradeSubjects(g);
  const item = list.find(s => s.key === key);
  if (!item) return { error: '这个年级里没有这个学科' };
  if (item.builtin) return { error: '内置学科不能删除，可以停用或改名' };
  gradeMap[String(g)] = list.filter(s => s.key !== key);
  saveSubjects();
  return { ok: true };
}

/** 题库缺失提示时的兜底思路，按学科给，不直接报答案 */
const FALLBACK_HINTS = {
  math: ['先看清是加还是减，再从个位算起', '把大数拆成整十数，算起来更快'],
  chinese: ['回想一下课文里是怎么说的', '把词放进句子里读一读，看哪个顺口'],
  pinyin: ['先在心里把字读一遍，再想声调', '注意是翘舌音还是平舌音'],
  english: ['先想中文意思，再回忆单词开头几个字母', '把选项默念一遍，听着像的那个通常是对的']
};

const BANKS = {
  // ============================================================ 语文
  chinese: {
    1: [
      ['「爸爸的爸爸」叫什么？', '爷爷', ['奶奶', '叔叔', '舅舅'], '爸爸的爸爸，比爸爸大一辈'],
      ['「一（ ）牛」中间填什么？', '头', ['只', '条', '匹'], '大牲口常用「头」'],
      ['「一（ ）马」中间填什么？', '匹', ['头', '只', '张'], '马用「匹」'],
      ['「大」的反义词是？', '小', ['多', '高', '长'], '大小是一对'],
      ['「上」的反义词是？', '下', ['左', '前', '里'], '上对下'],
      ['「白」的反义词是？', '黑', ['红', '亮', '灰'], '白天对黑夜'],
      ['「冷」的反义词是？', '热', ['暖', '凉', '冰'], '冷对热'],
      ['「小」的反义词是？', '大', ['多', '少', '短'], '小对大'],
      ['「河」字是什么偏旁？', '三点水', ['木字旁', '提手旁', '单人旁'], '河里有水'],
      ['「打」字是什么偏旁？', '提手旁', ['三点水', '木字旁', '口字旁'], '打要用到手'],
      ['「弯弯的（ ）」填哪个最合适？', '月亮', ['太阳', '大树', '石头'], '月亮是弯的'],
      ['「（ ）的太阳」填哪个最合适？', '红红', ['弯弯', '长长', '细细'], '太阳红彤彤'],
      ['「一（ ）书」中间填什么？', '本', ['张', '条', '片'], '书用「本」'],
      ['「一心一（ ）」填哪个字？', '意', ['义', '议', '艺'], '一心一意，表示专心'],
      ['下面哪个是水果？', '苹果', ['白菜', '土豆', '萝卜'], '苹果是长在树上的'],
      ['下面哪个是动物？', '老虎', ['白菜', '石头', '桌子'], '老虎会跑会叫'],
      ['哪个字是「看」的意思？', '瞧', ['听', '说', '走'], '瞧就是看'],
      ['「床前明月光」的下一句是？', '疑是地上霜', ['举头望明月', '低头思故乡', '春眠不觉晓'], '李白《静夜思》'],
      ['「春眠不觉晓」的下一句是？', '处处闻啼鸟', ['夜来风雨声', '花落知多少', '疑是地上霜'], '孟浩然《春晓》'],
      ['「云」通常是什么颜色？', '白色', ['黑色', '绿色', '黄色'], '晴天里的白云']
    ],
    2: [
      ['「高兴」的近义词是？', '快乐', ['难过', '生气', '害怕'], '高兴和快乐意思接近'],
      ['「美丽」的近义词是？', '漂亮', ['丑陋', '干净', '高大'], '美丽就是好看'],
      ['「骄傲」的反义词是？', '谦虚', ['自豪', '高兴', '勇敢'], '骄傲自满对谦虚'],
      ['「守株待（ ）」填哪个字？', '兔', ['虎', '羊', '鸟'], '成语「守株待兔」'],
      ['「画蛇添（ ）」填哪个字？', '足', ['手', '头', '尾'], '画蛇添足，多此一举'],
      ['「亡羊补（ ）」填哪个字？', '牢', ['门', '圈', '墙'], '羊丢了先修好羊圈'],
      ['「井底之（ ）」填哪个字？', '蛙', ['鱼', '龟', '虫'], '井底的青蛙只看得见一小片天'],
      ['「欲穷千里目」的下一句是？', '更上一层楼', ['白日依山尽', '黄河入海流', '处处闻啼鸟'], '王之涣《登鹳雀楼》'],
      ['「谁知盘中餐」的下一句是？', '粒粒皆辛苦', ['汗滴禾下土', '锄禾日当午', '春种一粒粟'], '《悯农》，讲爱惜粮食'],
      ['「小荷才露尖尖角」的下一句是？', '早有蜻蜓立上头', ['映日荷花别样红', '接天莲叶无穷碧', '疑是银河落九天'], '杨万里《小池》'],
      ['「长大」的「长」读什么？', 'zhǎng', ['cháng', 'zhàng', 'chāng'], '「长大」的「长」是第三声'],
      ['「银行」的「行」读什么？', 'háng', ['xíng', 'hàng', 'xìng'], '「银行」读 yín háng'],
      ['「睛」和「晴」哪个和眼睛有关？', '睛', ['晴', '请', '情'], '目字旁和眼睛有关'],
      ['「狐假虎威」是谁借谁的威风？', '狐狸借老虎', ['老虎借狐狸', '狼借狐狸', '兔子借老虎'], '「假」在这里是「借」的意思'],
      ['形容跑得很快的成语是？', '健步如飞', ['慢条斯理', '目瞪口呆', '三心二意'], '像飞一样快'],
      ['「病」字的偏旁是？', '病字旁', ['广字旁', '立字旁', '两点水'], '疒 叫病字旁'],
      ['「园」字的偏旁是？', '大口框', ['土字旁', '元字旁', '口字旁'], '「园」外面是囗，不是口'],
      ['「木」字下面加一横是什么字？', '本', ['术', '禾', '未'], '在「木」的下面加一短横']
    ],
    3: [
      ['「刻舟求剑」告诉我们什么道理？', '做事要随机应变', ['做事要坚持到底', '做人要诚实', '读书要用心'], '船一直在动，刻的记号没用了'],
      ['「揠苗助长」告诉我们什么道理？', '违背规律反而坏事', ['多帮忙总没坏处', '禾苗要天天看', '要早睡早起'], '把苗往上拔，苗反而死了'],
      ['「停车坐爱枫林晚」的「坐」是什么意思？', '因为', ['坐下', '座位', '乘坐'], '这里的「坐」是「因为」'],
      ['「两个黄鹂鸣翠柳」的下一句是？', '一行白鹭上青天', ['窗含西岭千秋雪', '门泊东吴万里船', '春风送暖入屠苏'], '杜甫《绝句》'],
      ['「（ ）而不舍」填哪个字？', '锲', ['弃', '刻', '契'], '锲而不舍，坚持不放弃'],
      ['「（ ）竽充数」填哪个字？', '滥', ['烂', '乱', '蓝'], '滥竽充数，混在里面凑数'],
      ['「缓慢」的反义词是？', '迅速', ['拖拉', '慢慢', '迟延'], '缓慢对迅速'],
      ['「徘徊」是什么意思？', '来回走动', ['飞快奔跑', '站着不动', '悄悄离开'], '走来走去，拿不定主意'],
      ['「（ ）明天下雨，我们（ ）不去公园」用哪组关联词？', '如果……就', ['因为……所以', '虽然……但是', '不但……而且'], '前面是假设，后面是结果'],
      ['「小明在教室里读书。」这句话的主语是？', '小明', ['读书', '教室', '在'], '谁在读书？'],
      ['问句的末尾应该用什么标点？', '问号', ['句号', '逗号', '感叹号'], '提问用问号'],
      ['「月亮像一只小船」用了什么修辞？', '比喻', ['拟人', '夸张', '排比'], '把月亮比作小船'],
      ['「明」是什么结构的字？', '左右结构', ['上下结构', '独体字', '包围结构'], '日 + 月，左右并排'],
      ['「春风又绿江南岸」的「绿」在这里是什么用法？', '动词，吹绿了', ['形容词，绿色的', '名词，绿叶', '副词，很绿'], '一个「绿」字让整句活起来'],
      ['「（ ）的夜空」填哪个最合适？', '深蓝', ['热闹', '香甜', '坚硬'], '夜空是深蓝色的'],
      ['「三心二（ ）」填哪个字？', '意', ['义', '议', '艺'], '三心二意，不专心']
    ]
  },

  // ============================================================ 拼音
  pinyin: {
    1: [
      ['「妈」的拼音是？', 'mā', ['má', 'mǎ', 'mà'], '第一声，又高又平'],
      ['「爸」的拼音是？', 'bà', ['bā', 'bá', 'bǎ'], '第四声，往下走'],
      ['「大」的拼音是？', 'dà', ['dā', 'dá', 'dǎ'], '第四声'],
      ['「水」的拼音是？', 'shuǐ', ['shuī', 'shuí', 'shuì'], '第三声，先降后升'],
      ['「天」的拼音是？', 'tiān', ['tián', 'tiǎn', 'tiàn'], '第一声'],
      ['「花」的拼音是？', 'huā', ['huá', 'huǎ', 'huà'], '第一声'],
      ['「鸟」的拼音是？', 'niǎo', ['niāo', 'niáo', 'niào'], '第三声'],
      ['「手」的拼音是？', 'shǒu', ['shōu', 'shóu', 'shòu'], '第三声'],
      ['「口」的拼音是？', 'kǒu', ['kōu', 'kóu', 'kòu'], '第三声'],
      ['「日」的拼音是？', 'rì', ['rī', 'rí', 'rǐ'], '第四声'],
      ['「月」的拼音是？', 'yuè', ['yuē', 'yué', 'yè'], '第四声，ü 后面跟 e'],
      ['「雨」的拼音是？', 'yǔ', ['yū', 'yú', 'yù'], '第三声'],
      ['「上」的拼音是？', 'shàng', ['shāng', 'shǎng', 'shà'], '第四声，后鼻音'],
      ['「一」单独读时拼音是？', 'yī', ['yí', 'yì', 'yǐ'], '单字念第一声'],
      ['「ā á ǎ à」里第三声是哪个？', 'ǎ', ['ā', 'á', 'à'], '第三声有个小勾，先降后升'],
      ['「bā」是第几声？', '第一声', ['第二声', '第三声', '第四声'], 'ā 上面是一道平平的横'],
      ['下面哪个是声母？', 'b', ['a', 'o', 'e'], 'a o e 都是韵母'],
      ['下面哪个是韵母？', 'a', ['b', 'p', 'm'], 'b p m 都是声母']
    ],
    2: [
      ['「绿」的拼音是？', 'lǜ', ['lù', 'lǔ', 'lǘ'], 'ü 遇到 l 要保留两点'],
      ['「女」的拼音是？', 'nǚ', ['nǔ', 'nù', 'lǚ'], 'n 加 ü，第三声'],
      ['「去」的拼音是？', 'qù', ['qū', 'qú', 'qǔ'], 'q 加 ü，两点去掉，第四声'],
      ['「雪」的拼音是？', 'xuě', ['xuē', 'xué', 'xuè'], '第三声'],
      ['「圆」的拼音是？', 'yuán', ['yuǎn', 'yuān', 'yàn'], '第二声'],
      ['「熊」的拼音是？', 'xióng', ['xōng', 'xiōng', 'xóng'], 'x 加 iong，第二声'],
      ['「云」的拼音是？', 'yún', ['yūn', 'yǔn', 'yùn'], '第二声'],
      ['「春」的拼音是？', 'chūn', ['cūn', 'chuān', 'chún'], '翘舌音 ch，第一声'],
      ['「吃」的拼音是？', 'chī', ['cī', 'chí', 'chǐ'], '翘舌音 ch，第一声'],
      ['「桌子」的「子」读什么？', 'zi（轻声）', ['zǐ', 'zì', 'zī'], '词尾的「子」读轻声'],
      ['「xue」里的韵母是？', 'üe', ['ue', 'e', 'u'], '和 j q x 相拼，ü 上两点去掉'],
      ['和 j q x 相拼时，ü 上的两点要？', '去掉', ['保留', '改成 u 但不发音', '不能相拼'], 'j q x 见 ü 就摘帽'],
      ['「an」属于哪一类韵母？', '前鼻韵母', ['后鼻韵母', '复韵母', '声母'], 'an 结尾是 n，前鼻音'],
      ['「ang」属于哪一类韵母？', '后鼻韵母', ['前鼻韵母', '单韵母', '声母'], 'ang 结尾是 ng，后鼻音'],
      ['「ai」属于哪一类韵母？', '复韵母', ['单韵母', '声母', '鼻韵母'], 'a 和 i 两个音合成'],
      ['「zhi chi shi ri」叫什么？', '整体认读音节', ['声母', '韵母', '三拼音节'], '看到就整体读出来，不用拼']
    ],
    3: [
      ['「旅」的拼音是？', 'lǚ', ['lǔ', 'lù', 'lǘ'], 'l 加 ü，第三声'],
      ['「略」的拼音是？', 'lüè', ['luè', 'lüě', 'lüē'], 'l 加 üe，第四声'],
      ['「翁」的拼音是？', 'wēng', ['wōng', 'wéng', 'wěng'], 'w 加 eng，第一声'],
      ['「鹅」的拼音是？', 'é', ['è', 'ě', 'ē'], '第二声，这个字没有声母'],
      ['「爱」的拼音是？', 'ài', ['āi', 'ái', 'ǎi'], '第四声'],
      ['「队」的拼音是？', 'duì', ['duī', 'duǐ', 'duèi'], '第四声'],
      ['「开会」的「会」读什么？', 'huì', ['kuài', 'huǐ', 'huī'], '第四声'],
      ['「重要」的「重」读什么？', 'zhòng', ['chóng', 'zhōng', 'zhǒng'], '「重复」才读 chóng'],
      ['「少年」的「少」读什么？', 'shào', ['shǎo', 'shāo', 'sháo'], '「多少」才读 shǎo'],
      ['「数学」的「数」读什么？', 'shù', ['shǔ', 'shuò', 'shū'], '「数一数」才读 shǔ'],
      ['「长处」的「长」读什么？', 'cháng', ['zhǎng', 'chǎng', 'zhàng'], '「长大」才读 zhǎng'],
      ['「跑得快」的「得」读什么？', 'de（轻声）', ['dé', 'děi', 'dē'], '跟在动词后面读轻声'],
      ['「家」的拼音 jiā 由哪几部分组成？', '声母+介母+韵母', ['声母+韵母', '两个韵母', '只有声母'], 'j + i + a，i 是介母'],
      ['汉语拼音里声母一共有多少个？', '23 个', ['21 个', '24 个', '26 个'], 'b 到 w，一共 23 个'],
      ['汉语拼音里韵母一共有多少个？', '24 个', ['23 个', '26 个', '21 个'], '单韵母 6 + 复韵母 9 + 鼻韵母 9']
    ]
  },

  // ============================================================ 英语
  english: {
    1: [
      ['「苹果」用英语怎么说？', 'apple', ['banana', 'orange', 'pear'], 'a-p-p-l-e'],
      ['「香蕉」用英语怎么说？', 'banana', ['apple', 'orange', 'pear'], 'ba-na-na'],
      ['「红色」用英语怎么说？', 'red', ['blue', 'green', 'yellow'], '红灯是 red light'],
      ['「蓝色」用英语怎么说？', 'blue', ['red', 'green', 'black'], '天空是 blue'],
      ['「一」用英语怎么说？', 'one', ['two', 'three', 'ten'], '1 → one'],
      ['「三」用英语怎么说？', 'three', ['one', 'two', 'five'], 'th 开头要咬舌尖'],
      ['「猫」用英语怎么说？', 'cat', ['dog', 'pig', 'duck'], 'cat 喵喵叫'],
      ['「狗」用英语怎么说？', 'dog', ['cat', 'pig', 'cow'], 'dog 汪汪叫'],
      ['「你好」用英语怎么说？', 'hello', ['goodbye', 'sorry', 'thanks'], '见面打招呼用 hello'],
      ['「谢谢」用英语怎么说？', 'thank you', ['sorry', 'hello', 'please'], 'th 开头要咬舌尖'],
      ['「书」用英语怎么说？', 'book', ['bag', 'pen', 'desk'], 'oo 读 /ʊ/'],
      ['「书包」用英语怎么说？', 'bag', ['book', 'box', 'ball'], 'school bag 就是书包'],
      ['「妈妈」用英语怎么说？', 'mother', ['father', 'sister', 'brother'], 'mum 的正式说法'],
      ['「爸爸」用英语怎么说？', 'father', ['mother', 'brother', 'uncle'], 'dad 的正式说法'],
      ['「大」用英语怎么说？', 'big', ['small', 'tall', 'long'], 'big 对 small'],
      ['「小」用英语怎么说？', 'small', ['big', 'tall', 'short'], 'small 对 big'],
      ['「水」用英语怎么说？', 'water', ['milk', 'juice', 'tea'], '口渴要喝 water'],
      ['「牛奶」用英语怎么说？', 'milk', ['water', 'juice', 'tea'], 'm-i-l-k']
    ],
    2: [
      ['「学校」用英语怎么说？', 'school', ['home', 'park', 'shop'], 's-c-h-oo-l'],
      ['「老师」用英语怎么说？', 'teacher', ['student', 'doctor', 'driver'], 'teach 加 er'],
      ['「学生」用英语怎么说？', 'student', ['teacher', 'doctor', 'farmer'], 's-t-u-d-e-n-t'],
      ['「星期一」用英语怎么说？', 'Monday', ['Sunday', 'Friday', 'Saturday'], 'Mon 和月亮 Moon 同源'],
      ['「星期天」用英语怎么说？', 'Sunday', ['Monday', 'Saturday', 'Tuesday'], 'Sun 是太阳'],
      ['「十二」用英语怎么说？', 'twelve', ['twenty', 'two', 'ten'], 'tw 开头，但不是 twenty'],
      ['「二十」用英语怎么说？', 'twenty', ['twelve', 'two', 'ten'], 'twenty 里有个 y'],
      ['「橙色」用英语怎么说？', 'orange', ['pink', 'purple', 'brown'], 'orange 也是橘子'],
      ['「紫色」用英语怎么说？', 'purple', ['orange', 'pink', 'grey'], 'p-u-r-p-l-e'],
      ['「早上好」用英语怎么说？', 'Good morning', ['Good night', 'Good afternoon', 'Good evening'], 'morning 是上午'],
      ['「晚安」用英语怎么说？', 'Good night', ['Good morning', 'Good afternoon', 'Good bye'], '睡觉前说 night'],
      ['「铅笔」用英语怎么说？', 'pencil', ['ruler', 'eraser', 'crayon'], 'pen 是钢笔，铅笔多一个 cil'],
      ['「尺子」用英语怎么说？', 'ruler', ['pencil', 'eraser', 'rubber'], 'r-u-l-e-r'],
      ['「跑」用英语怎么说？', 'run', ['jump', 'swim', 'walk'], 'run 是跑'],
      ['「游泳」用英语怎么说？', 'swim', ['run', 'jump', 'sing'], 'swim 在水里'],
      ['「高」用英语怎么说？', 'tall', ['short', 'big', 'heavy'], 'tall 形容个子高'],
      ['「热」用英语怎么说？', 'hot', ['cold', 'warm', 'cool'], 'hot 对 cold'],
      ['「鸡蛋」用英语怎么说？', 'egg', ['rice', 'bread', 'meat'], '两个 g']
    ],
    3: [
      ['「图书馆」用英语怎么说？', 'library', ['classroom', 'playground', 'office'], '借书的地方'],
      ['「医院」用英语怎么说？', 'hospital', ['school', 'library', 'hotel'], '看病的地方'],
      ['「What time is it?」是什么意思？', '现在几点了？', ['你几岁了？', '你在哪里？', '这是什么？'], 'time 是时间'],
      ['「你几岁了？」用英语怎么说？', 'How old are you?', ['How are you?', 'What time is it?', 'Where are you?'], 'old 在这里指年龄'],
      ['one box, two ___', 'boxes', ['boxs', 'box', 'boxies'], '以 x 结尾要加 es'],
      ['one child, two ___', 'children', ['childs', 'childes', 'child'], 'child 的复数是不规则变化'],
      ['「go」的过去式是？', 'went', ['goed', 'gone', 'going'], '不规则动词，要单独背'],
      ['「eat」的过去式是？', 'ate', ['eated', 'eaten', 'eating'], 'eat - ate - eaten'],
      ['「big」的比较级是？', 'bigger', ['biger', 'more big', 'biggest'], '双写 g 再加 er'],
      ['「good」的比较级是？', 'better', ['gooder', 'best', 'more good'], 'good - better - best'],
      ['I ___ a student.', 'am', ['is', 'are', 'be'], 'I 后面用 am'],
      ['She ___ my sister.', 'is', ['am', 'are', 'be'], '第三人称单数用 is'],
      ['They ___ playing football.', 'are', ['is', 'am', 'be'], 'they 是复数，用 are'],
      ['「I\'m」是哪两个词的缩写？', 'I am', ['I is', 'I are', 'I be'], '撇号代替了被省略的字母'],
      ['字母表中 K 后面是哪个字母？', 'L', ['J', 'M', 'I'], 'H I J K L M N'],
      ['「don\'t」是哪两个词的缩写？', 'do not', ['does not', 'did not', 'is not'], 'do 加 not'],
      ['「apple」有几个音节？', '2 个', ['1 个', '3 个', '4 个'], 'ap-ple，拍两下手']
    ]
  }
};

module.exports = {
  SUBJECTS,
  SUBJECT_KEYS,
  GRADES,
  GRADE_NAMES,
  QUIZ_GRADES,
  QUIZ_GRADE_NAMES,
  normalizeQuizGrade,
  quizGradeName,
  BANKS,
  FALLBACK_HINTS,
  normalizeSubject,
  normalizeSubjects,
  subjectName,
  subjectColor,
  gradeSubjects,
  allGradeSubjects,
  addGradeSubject,
  updateGradeSubject,
  removeGradeSubject
};
