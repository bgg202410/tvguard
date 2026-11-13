package cn.binguoguo.tvguard.net

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object Api {

    private const val CONNECT_MS = 3000
    private const val READ_MS = 4000

    fun get(base: String, path: String, params: Map<String, String> = emptyMap()): JSONObject? {
        val qs = params.entries.joinToString("&") {
            "${it.key}=${URLEncoder.encode(it.value, "UTF-8")}"
        }
        val url = base.trimEnd('/') + path + if (qs.isEmpty()) "" else "?$qs"
        return request(url, "GET", null)
    }

    fun post(base: String, path: String, body: JSONObject): JSONObject? =
        request(base.trimEnd('/') + path, "POST", body.toString())

    private fun request(urlStr: String, method: String, body: String?): JSONObject? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = CONNECT_MS
                readTimeout = READ_MS
                useCaches = false
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            if (body != null) {
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            if (code !in 200..299) return null
            val text = conn.inputStream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } catch (t: Throwable) {
            null
        } finally {
            try { conn?.disconnect() } catch (t: Throwable) { /* ignore */ }
        }
    }
}
