package org.hometv.launcher

import android.media.MediaCodecList
import android.os.Build

/** Diagnostic evidence only. Codec identities stay inside the process and never enter logs. */
internal object NativeDecoderEvidence {
    data class Evidence(val matched: Int = -1, val hardware: Int = -1, val software: Int = -1)
    internal data class Codec(
        val name: String,
        val canonicalName: String,
        val hardware: Boolean,
        val software: Boolean,
        val encoder: Boolean = false,
    )

    // Platform codec inventory is stable for the process. A failed/unavailable inventory is unknown.
    private val codecs: List<Codec>? by lazy {
        if (Build.VERSION.SDK_INT < 29) null else runCatching {
            MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos.map { info ->
                Codec(info.name, info.canonicalName, info.isHardwareAccelerated, info.isSoftwareOnly, info.isEncoder)
            }
        }.getOrNull()
    }

    fun read(implementation: Any?): Evidence = classify(implementation, codecs)

    /** Exact aliases/canonical names only; native or decorated fallback descriptions remain unknown. */
    internal fun classify(implementation: Any?, inventory: List<Codec>?): Evidence {
        val name = implementation as? String ?: return Evidence()
        if (name.isBlank() || name.length > 256 || inventory == null) return Evidence()
        val matches = inventory.filter { !it.encoder && (it.name == name || it.canonicalName == name) }
        if (matches.isEmpty()) return Evidence(matched = 0)
        val first = matches.first()
        if (matches.any { it.hardware != first.hardware || it.software != first.software } || (first.hardware && first.software)) return Evidence()
        return Evidence(1, if (first.hardware) 1 else 0, if (first.software) 1 else 0)
    }
}
