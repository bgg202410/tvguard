# 保底规则：暂不开启混淆，发布前再补
# ProGuard 规则不支持 ${applicationId} 占位符，这一行只能写字面量；改包名时必须同步。
-keep class cn.binguoguo.tvguard.** { *; }
