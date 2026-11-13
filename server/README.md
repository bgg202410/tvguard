# TvGuard 管理端

电视上的「守时桌面」只管本地计时和弹题；**策略、题库、观看统计集中在服务端**，家长用手机或电脑的浏览器改，电视端每分钟拉一次，改完 1 分钟内生效，不用重装 App。

## 它负责什么

| 能力 | 说明 |
|---|---|
| 策略下发 | 每日额度 / 答题间隔 / 奖励 / 难度 / **出题学科** / **玩法** / **时段** / 总开关，可对单台电视覆盖 |
| 多学科题库 | 数学 / 语文 / 拼音 / 英语，后台可勾选出哪几科；支持增删改、批量导入（可整批混学科）、配提示与解析 |
| 题型 | 单选 / 判断 / 多选；判断题选项固定「对 / 错」，多选按集合判对错，顺序无关 |
| 服务端判题 | 下发题目时**不带答案**，答案只在服务端比对；答完才回正确答案与解析 |
| 观看统计 | 电视答题时把「上次上报后的观看时长」随判题一起带上来，网页上看今日已看 / 剩余 / 答题数 / 答对率 |
| **保活自动修复** | 电视上报「无障碍没开 / 设备管理员没激活」或刚升级完时，管理端自动通过电视的网络调试口（adb 5555）远程修复，不用再开电脑敲命令；设备卡上有「立即修复」，15 分钟冷却防白连 |
| **电视画面截屏** | 首页「电视画面」区：手动「立即截图」随时可点；开自动后每 10 秒一张、只留最近 5 分钟（超时即删），图片只存 `data/shots/`。1080p PNG（约 2.2MB）拉回后本地压成 960 宽 JPEG（约 95KB）再落盘，后台浏览快、磁盘占用小 |

#### 保活自动修复的原理与授权

- 实现在 `src/adb.js`：零依赖手写的 ADB over TCP 客户端（CNXN/AUTH/OPEN/OKAY/WRTE/CLSE），
  签名用 `RSA_sign(NID_sha1, token)` 语义 —— token 本身当摘要，**不能**用 `createSign('RSA-SHA1')`（会多哈希一次）。
- 修复命令：`settings put secure enabled_accessibility_services <组件>`、
  `settings put secure accessibility_enabled 1`、`dpm set-active-admin <组件>`。
  包名由 `TV_PACKAGE`（`src/config.js` / `.env.example`，默认与 app 的 `tvguard.appId` 一致）统一提供，
  组件名与 `pidof` 都从它派生。组件名是「包名/类名」拼接，两段前缀一致：`<TV_PACKAGE>/<TV_PACKAGE>.guard.*`。
  **升级注意**：旧版 APK 的源码包前缀与包名不同，组件完整类名也随之改变。服务端与电视端 APK 必须同批升级，
  否则新版服务端拉不活尚未升级的电视；且升级后电视上已激活的无障碍 / 设备管理员要重新授权一次。
- 电视 IP 从上报请求的来源地址自动记录（`devices.json` 的 `lastIp`），不用配置。
- 密钥：首次自动生成 `data/adb_key.json`。若电视开了调试授权，第一次连接会在电视上弹
  「允许 USB 调试」，点一次即可；也可以把电脑上已授权的 `~/.android/adbkey` 拷成
  `data/adb_key`（PEM 文本）直接复用，免弹窗。
- 截屏走 `exec:` 服务而不是 `shell:` —— 老安卓的 shell 会把 `\n` 改成 `\r\n`，PNG 会损坏。
- 压缩在 `src/img.js`：零依赖手写的 PNG 解码（8bit RGB/RGBA）+ 盒式缩放 + 基线 JPEG 编码
  （4:2:0、标准量化/霍夫曼表），不引 sharp/jimp 之类的三方包，保持容器零 npm install。
  电视在自己家里时 2.2MB 拉图走的是局域网，不占外网带宽；若以后服务端搬到公网云，
  再考虑改电视端用系统自带 `Bitmap.compress` 压完再传。

### 时长怎么算：答题不换时间，用完了才换

| 阶段 | 规则 |
|---|---|
| 额度内 | 每天能看多久**只看** `dailyLimitMin`（上网总时长）。答题只决定「能不能接着看」，不加时间 |
| 用完那一刻 | 开了 `rewardEnabled` → 电视进禁用页，页面上有「答题换时长」按钮；没开 → 直接禁用到明天 |
| 换时长中 | 答对 `rewardQuizCount` 题换 `rewardMin` 分钟，每天最多 `rewardTimes` 次 |
| 次数用尽 | 彻底禁用，显示「明天 0 点恢复」；跨天 0 点整块重置（含已换来的时长） |

| 字段 | 默认 | 说明 |
|---|---|---|
| `rewardEnabled` | `false` | 总开关，默认关 —— 不开就是"用完即锁" |
| `rewardQuizCount` | `10` | 答对几题换一次 |
| `rewardMin` | `10` | 一次换几分钟 |
| `rewardTimes` | `2` | 每天最多换几次（上限 = `rewardMin × rewardTimes`） |

- 单题 / 整组（`quizMode`）只影响**额度内**的放行判定：单题答对即放行；整组答满且正确率 ≥ `groupPassRate`% 才放行。
- 换时长模式下不分单题整组：答对攒 1 题进度，攒满 N 题由**服务端**发奖励；答错不计数也不清零。
- 奖励次数和已换时长都由服务端记在设备当天的 `stats` 里（`bonusMs` / `bonusTimes` / `rewardCorrect`），
  电视端只是把 `dailyLimitMin + bonusMs` 当成今日总量，自己算不出多余时间。

### 时段：两种用途，差别很大

| 模式 | 时段内 | 时段外 |
|---|---|---|
| `off` | 按额度管控 | 同左（不看时段） |
| `quizOnly` 仅时段内需要答题 | 正常计时 + 弹题 | **自由使用，不扣额度也不弹题** |
| `block` 仅时段内可用 | 正常计时 + 弹题 | 锁定，显示「下次可用时间」 |

`quizOnly` 是为「白天老人正常看电视、17–21 点再管孩子」这种场景准备的。时段表是 7 天 × 48 格（半小时一格），共 336 个 0/1。

### 学科怎么组织

| 学科 | key | 题目来源 | 首次启动 |
|---|---|---|---|
| 数学 | `math` | 参数生成，题量无限 | 三档各 60 道种子题 |
| 语文 | `chinese` | 预置题库（识字 / 词语 / 古诗 / 成语 / 关联词…） | 三档共 54 道 |
| 拼音 | `pinyin` | 预置题库（声母韵母 / 声调 / 整体认读 / 多音字） | 三档共 49 道 |
| 英语 | `english` | 预置题库（单词 / 短语 / 简单语法） | 三档共 53 道 |

数学能“算”出题，其它三科不行 —— 答案是知识点，只能人工录入，所以放在 `src/subjects.js` 的预置题库里。
每条记录是 `[题干, 正确答案, [干扰项...], 提示]`，想加自己的题最省事的办法是在管理页「批量导入」里按同样格式粘贴。

**零第三方依赖**：只用 Node 标准库，镜像里没有 `npm install`，构建不需要外网拉包（只拉一次 node 基础镜像）。
数据用 JSON 文件存在 `data/` 目录，备份就是拷这个文件夹。

## 目录

```
server/
├── src/adb.js          零依赖 ADB over TCP 客户端
├── src/config.js       配置解析
├── src/store.js        持久化
├── src/apk.js          电视端 APK 收发
├── src/quiz.js         按学科出题 / 判题 / 批量导入
├── src/subjects.js     学科定义 + 语文/拼音/英语预置题库
├── public/index.html   管理网页结构
├── public/css/app.css  全部样式
├── public/js/core.js   工具 登录
├── public/js/policy.js 管控策略 + 可用时段网格
├── public/js/devices.js 电视列表
├── public/js/bank.js   题库 + 错题本
├── public/js/logs.js   事件日志 + 题目详情弹层
├── public/js/apk.js    电视端版本管理
├── public/js/pwd.js    管理密码（查看 / 修改）
├── public/js/main.js   启动、hash 路由、全局事件
├── .env.example        配置模板（复制成 .env 后改，.env 不入库）
├── Dockerfile
├── docker-compose.yml
└── data/               运行时生成：policy.json / devices.json / questions.json / events.jsonl
```

> **改前端时注意**：`public/` 下是 `index.html` + `css/` + `js/` 三个部分，
> 上传时必须整个目录一起覆盖 —— 只传 `index.html` 会变成一个没样式、没脚本的空壳。
> 脚本都是普通 `<script>`（不是 ES module），共享全局作用域，所以页面里的
> `onclick="xxx()"` 照旧能调到 `js/*.js` 里的全局函数。

## 配置变量

**最省事的做法：直接改 `docker-compose.yml` 里那几行**，不依赖任何 `env` 文件，也不会因为隐藏文件、变量插值出岔子。

```yaml
ports:
  - "8088:8088"              # 左边是宿主机端口，改了访问地址也跟着变
environment:
  TZ: Asia/Shanghai
  PORT: "8088"               # 容器内端口，不要和 ports 右边不一致
  DATA_DIR: /data
  ADMIN_PASSWORD: "ChangeMe_2026"   # ← 登录密码，部署前必改
```

改完执行 `docker compose up -d` 重建容器，用新密码登录。改了密码旧浏览器会掉登录态，这是故意的（登录密钥由密码派生）。

想用环境变量/`.env` 管理（多环境迁移时方便）：把 compose 里对应行换成 `${ADMIN_PASSWORD:-}`、`${HOST_PORT:-8088}`，再在同目录放 `.env`（模板见 `.env.example`）。

### 忘记密码怎么办

密码有两个地方能找到，随便哪一个都行：

| 位置 | 说明 |
|---|---|
| 部署目录 `.env` | 你当初填的明文，直接打开看 |
| `data/admin-password.txt` | 服务每次启动自动写，永远记录**当前真正生效**的密码，以及它来自哪儿 |

启动日志只说密码来自哪儿，不打印密码本身；`docker logs` 里翻不到是故意的。

还有一个兜底：管理页登录后，右上角「管理密码」能直接看到当前密码并复制——适合浏览器还留着登录态、但你想不起密码的时候。

> 为什么密码要多存一份：`ADMIN_PASSWORD` 曾经只有「环境变量 / 默认 tvguard」两条路，容器重建时 `.env` 没挂上就会悄悄退回默认值，人以为是密码错了。现在的优先级是：**后台「管理密码」里改过的 > 环境变量 > `data/config.json` 记住的 > 默认值**，所以后台改一次就永久生效，容器重启也不会变回去，`docker-compose.yml` 里那行只当首次的初始密码用。

## Docker 部署

### 目录必须是「平铺」的

这是部署失败最常见的原因：`docker-compose.yml` 必须**直接躺在部署目录里**，不能多一层。

```
✅ 正确
tvguard-server/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── src/
│   ├── app.js
│   ├── config.js
│   ├── quiz.js
│   ├── store.js
│   └── subjects.js
└── public/
    └── index.html
```

### 步骤

1. 把压缩包里的 `Dockerfile`、`docker-compose.yml`、`package.json`、`src/`、`public/` 放进同一目录，按上面的结构摆平。
2. **改密码**：把 `docker-compose.yml` 里的 `ADMIN_PASSWORD: "ChangeMe_2026"` 改成自己的再启动；装好后建议登录后台点右上角「管理密码」→「修改密码」再改一次。后台改的密码写在 `data/config.json` 并优先于环境变量，容器重启也不会变回去。
3. 在该目录执行 `docker compose up -d`。首次会拉 `node:20-alpine`（几十 MB）。
4. 浏览器打开 **`http://<宿主机 IP>:8088`**。
5. 进去点右上角「管理密码」，确认显示的和你想的一致。

> compose 已是免构建版：不跑 Dockerfile、不装包，直接用官方 node 镜像跑源码，改 js 后重启容器即生效。镜像拉不下来时配置 Docker 镜像加速（如 `https://docker.m.daocloud.io`）。

### 卡住/失败对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 一直拉不动，`TLS handshake timeout` | 拉 `node:20-alpine` 超时（国内网络最常见） | 配置镜像加速，或先 `docker pull node:20-alpine` |
| `no such file or directory` / `Cannot locate Dockerfile` | 目录层级不对 | 按上面的「平铺」结构摆好 |
| `port is already allocated` | 8088 被占用 | host 模式改 `PORT`；用 ports 映射时改左边端口 |
| 显示「运行中」但网页打不开 | 容器在重启循环（`restart: unless-stopped`） | `docker compose logs --tail=50`，一般是启动报错 |

> 网络：compose 默认 `network_mode: host`。默认 bridge 下容器既出不到电视的 5555 端口，外部请求源 IP 又会被 NAT 成 Docker 网关而被误当成电视 IP —— 截图 / 离线唤醒 / 保活修复会全废。改网络后必须 `docker compose up -d --force-recreate` 重建，只重启不生效。详见 `INSTALL.txt`。

## 数据与备份

| 文件 | 内容 |
|---|---|
| `data/policy.json` | 全局策略 |
| `data/devices.json` | 每台电视的名称、型号、覆盖策略、当天统计 |
| `data/questions.json` | 题库（含启用状态、提示） |
| `data/events.jsonl` | 事件流（注册/出题/答题/导入），超过 5MB 自动轮转 |
| `data/config.json` | 当前生效的管理密码（后台改过密码后以它为准，优先于 `ADMIN_PASSWORD`） |
| `data/admin-password.txt` | 密码备忘，人肉可读，每次启动刷新 |

全部在部署目录的 `data/`（compose 挂载的卷），拷走即备份。删掉 `devices.json` 里的某台记录，电视下次心跳会自动重新注册。

## 电视端接口（Android 接入用）

所有接口都是 JSON，无需鉴权（只在局域网内）。基址是「管理端宿主机的局域网 IP + `PORT`」（默认 8088），电视端连的是同一个地址，由根目录 `gradle.properties` 的 `tvguard.serverUrl` 配置——改端口时两边要一起改，说明见根 README「发布前必配置：管理端地址」。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/ping` | 连通性自检 |
| POST | `/api/v1/device/register` | 首次注册，body `{deviceId, model, appVersion}` |
| GET | `/api/v1/device/session?deviceId=&model=&v=` | **主接口**。一次拿全：策略 + 时段表 + 今日用量 + 组进度 |
| GET | `/api/v1/device/policy?deviceId=` | 只拉策略（老接口，保留） |
| GET | `/api/v1/quiz?deviceId=&level=&exclude=&subject=` | 取题。`exclude` 是最近出过的 id；`subject` 不传按策略里勾选的学科随机 |
| POST | `/api/v1/quiz/answer` | 判题，body `{deviceId, qid, choice, watchedMsDelta}` |
| POST | `/api/v1/report` | 单独上报，body `{deviceId, watchedMsDelta}`（答题时会顺带上报，一般不用单独调） |

> 电视端**不做长连接、不做后台轮询**。只有两个检查点：开机（App 启动）拉一次 `session`，弹题时拉一次 `quiz`。其余时间靠开机拿到的那份策略和时段表在本地判断。
> 连不上管理端时，客户端**完全放行**：不计时、不弹题、不拦任何东西，电视回到系统桌面自己的行为。

取题响应示例（**注意没有 answer**）：

```json
{
  "id": "qmw6dktto3a",
  "subject": "chinese",
  "subjectName": "语文",
  "type": "choice",
  "stars": 3,
  "prompt": "「守株待（ ）」填哪个字？",
  "options": ["虎", "兔", "羊", "鸟"],
  "hint": "成语「守株待兔」",
  "level": 2
}
```

判题响应（`explanation` 只在答完给，取题时不带）：

```json
{
  "correct": true,
  "answer": "兔",
  "explanation": "成语「守株待兔」",
  "subject": "chinese",
  "type": "choice",
  "stars": 3,
  "rewardMinutes": 3,
  "group": { "asked": 2, "size": 5, "correct": 2, "finished": false, "rate": 100 },
  "policy": { "dailyLimitMin": 120, "quizIntervalMin": 10, "quizMode": "group", "groupSize": 5, "groupPassRate": 60, "schedule": { "mode": "quizOnly" }, "enabled": true }
}
```

`options` 一律是**字符串数组**，2～6 个（数学 4 个、判断题固定 2 个）。多选的 `answer` 用 `|` 连接（如 `blue|red`），判题时按集合比对，顺序无关。

### 批量导入格式

管理页「批量导入」一行一道题，行首可用 `[语文]` / `[拼音/1]` / `[英语/3]` 单独指定学科和难度：

| 学科 | 写法 |
|---|---|
| 数学 | `12+34=46` 或 `题干\|答案`（选项自动生成），也可 `题干\|答案\|提示`、`题干\|答案\|选项\|提示` |
| 语文 / 拼音 / 英语 | 必须带选项：`题干\|答案\|选项`，要提示就 `题干\|答案\|选项\|提示` |
| 判断题 | `题干\|对` 或 `题干\|错`（√ / × / true / false 也认），选项固定是「对 / 错」 |
| 多选题 | 答案用 `\|` 连多个：`题干\|red\|blue\|red,blue,apple,book\|提示` |

示例：

```
12+34=46
7×8=?|56|用七的口诀
[语文] 「骄傲」的反义词是？|谦虚|自豪,高兴,勇敢|
[拼音/1] 「妈」的拼音是？|mā|má,mǎ,mà
[英语/3] one child, two ___|children|childs,childes,child
「妈」和「马」声调相同。|×
```

**离线行为**：电视连不上管理端时**完全放行** —— 不计时、不弹题、不拦任何东西，回到电视原本的使用方式。这是产品定的规则：宁可漏管，也不要孩子因为服务端挂了被卡在答题页上。

## 本地开发

```bash
cd server
cp .env.example .env      # 首次：改掉里面的 ADMIN_PASSWORD
npm run dev               # = node --env-file-if-exists=.env src/app.js
# 浏览器打开 http://localhost:8088
```

想隔离数据（不碰 `.devdata` 里的测试题）：

```bash
DATA_DIR=./.tmpdata PORT=8099 npm run dev
```

不需要 `npm install`（没有依赖）。

## 电视端升级（在后台传 APK）

后台右上角 **「电视版本」** 就是发布入口，不用再连 adb：

1. 选新编译的 `.apk` → **上传并发布**。包名、versionCode、versionName 从 APK 里自动读（自己解析 `AndroidManifest.xml`，不依赖 aapt），传重复的 versionCode 会被拒。
2. 传完自动成为**分发版本**。电视端回一次守时桌面（3 分钟内会查一次）就弹「发现新版本」→ 下载（带进度、md5 校验）→ 拉起系统安装器。
3. 电视上用遥控器点一下「安装」，装完自动回守时桌面继续计时。

### 保留 3 个历史版本

| 行为 | 说明 |
|---|---|
| 快照数量 | 当前分发 + 3 个历史，第 5 个上传时自动删最旧的文件 |
| 设为首发 | 「设为分发」把指针切回旧版本，**只影响还停在旧版本的电视** |
| 下载 | 每个版本都能下载，留给 U 盘手动装 / 应急 |
| 删除 | 当前分发版本不能删 |

⚠️ **降级是有限制的**：Android 不允许安装比当前低的 versionCode。所以「设为分发」不会让已经升级的电视自己降回去 —— 要真降级，得先在电视上卸载当前应用（本地观看记录会清零，服务端数据不受影响），再用 U 盘装旧包。真正常用的路径是：发现问题 → 改代码 → 传一个 versionCode 更大的修复版。

⚠️ **不能全静默**：普通应用没有 `INSTALL_PACKAGES` 权限，系统安装确认框必须有人点一下。这是 Android 的限制，不是没做。

签名必须始终用同一个 keystore（现在是 debug keystore），换了签名就只能卸载重装。

## 已知边界

- 单管理员、单密码，没有多用户和权限分级。一家人用够了。
- 密码在 `data/config.json` 和 `data/admin-password.txt` 里是**明文**——刻意为之，为的是忘不掉。请自行管好 `data` 目录的宿主权限，别暴露给不相关的人。
- 预置题库是按小学低中年级写的（语文/拼音/英语各 50 道上下），不够用就自己导入 —— 课本进度只有家长清楚。
- 难度是全局一档，不区分学科；想单科加深，直接给那一科多导入几道「挑战」再把简单档停用。
- 只按天统计，没有周/月报表。要看长期趋势，把 `events.jsonl` 导到表格里分析。
- HTTP 明文，只在局域网内用。要外网访问请走反向代理 + HTTPS，并把密码换强。
