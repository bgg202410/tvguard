# 第三方材料与许可

本仓库代码本身按 MIT 许可，见 `LICENSE`。下面这些东西不是本项目的代码，各有各的许可，别混着看。

## 题库数据（本仓库不分发）

`server/scripts/build-question-pack.py` 会在运行时把外部题库数据下载到 `server/scripts/.cache/`（已被 `.gitignore` 忽略）。只有你手动跑这个脚本生成题库包时才会出现，仓库里没有任何题库数据文件。

| 数据 | 来源 | 许可 | 能否商用 |
| --- | --- | --- | --- |
| CMATH | github.com/iskybear/cmath | CC BY 4.0 | 可以，需署名 |
| cn-math-taxonomy | github.com/xiaoyang111222/cn-math-taxonomy | CC BY-NC 4.0 | **不行，仅限非商业使用** |
| pep-english-words | github.com/cyforkk/pep-english-words | MIT | 可以，保留许可声明 |

脚本生成的题库包会在 `sources` 字段记下每份数据的来源和许可，导入后台后也留着，别删。

`cn-math-taxonomy` 那份是 CC BY-NC 4.0：自己在家用、教学、研究没问题；拿去卖，或者放进收费产品之前，要么换掉这批题，要么联系原作者单独取得商业授权。原作者也说明了题目是 AI 生成的初稿、未经一线教师审核，后台可以停用或删掉不合适的题。

`server/src/subjects.js` 里语文 / 拼音 / 英语的预置题是本项目自己录入的，不属于上面任何一份数据。

## 构建与运行依赖

- Gradle Wrapper（`gradlew`、`gradlew.bat`、`gradle/wrapper/gradle-wrapper.jar`）：来自 Gradle 项目，Apache-2.0。
- AndroidX、Kotlin、kotlinx-coroutines 等：只在构建时从 Maven 仓库拉取，不随本仓库分发，各自按其许可（多为 Apache-2.0）。
- `node:20-alpine`：运行时的官方镜像，不由本仓库分发。
- 服务端 `src/adb.js`、`src/img.js`、`src/apk.js` 是本项目零依赖手写实现，没有引入第三方代码。
