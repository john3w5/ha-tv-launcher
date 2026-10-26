package org.hometv.launcher

fun main() {
    val hw = NativeDecoderEvidence.Codec("c2.vendor.avc.decoder", "c2.vendor.avc.decoder", true, false)
    val alias = NativeDecoderEvidence.Codec("OMX.vendor.avc.decoder", "c2.vendor.avc.decoder", true, false)
    val sw = NativeDecoderEvidence.Codec("c2.android.avc.decoder", "c2.android.avc.decoder", false, true)
    val hybrid = NativeDecoderEvidence.Codec("vendor.hybrid", "vendor.hybrid", false, false)
    val inventory = listOf(hw, alias, sw, hybrid)
    var checks = 0
    fun expect(actual: NativeDecoderEvidence.Evidence, expected: NativeDecoderEvidence.Evidence) {
        check(actual == expected) { "Unexpected numeric decoder evidence" }; checks++
    }
    val unknown = NativeDecoderEvidence.Evidence()
    expect(NativeDecoderEvidence.classify(hw.name, inventory), NativeDecoderEvidence.Evidence(1, 1, 0))
    expect(NativeDecoderEvidence.classify(alias.name, inventory), NativeDecoderEvidence.Evidence(1, 1, 0))
    expect(NativeDecoderEvidence.classify(sw.name, inventory), NativeDecoderEvidence.Evidence(1, 0, 1))
    expect(NativeDecoderEvidence.classify(hybrid.name, inventory), NativeDecoderEvidence.Evidence(1, 0, 0))
    expect(NativeDecoderEvidence.classify(null, inventory), unknown)
    expect(NativeDecoderEvidence.classify(42, inventory), unknown)
    expect(NativeDecoderEvidence.classify("", inventory), unknown)
    expect(NativeDecoderEvidence.classify(" ", inventory), unknown)
    expect(NativeDecoderEvidence.classify("x".repeat(257), inventory), unknown)
    expect(NativeDecoderEvidence.classify(hw.name, null), unknown)
    expect(NativeDecoderEvidence.classify("FFmpeg", inventory), NativeDecoderEvidence.Evidence(0))
    expect(NativeDecoderEvidence.classify("fallback from: ${hw.name}", inventory), NativeDecoderEvidence.Evidence(0))
    expect(NativeDecoderEvidence.classify(hw.name.uppercase(), inventory), NativeDecoderEvidence.Evidence(0))
    expect(NativeDecoderEvidence.classify(hw.name, listOf(hw.copy(encoder = true))), NativeDecoderEvidence.Evidence(0))
    expect(NativeDecoderEvidence.classify(hw.name, listOf(hw, hw.copy(hardware = false, software = true))), unknown)
    expect(NativeDecoderEvidence.classify(hw.name, listOf(hw.copy(software = true))), unknown)
    expect(NativeDecoderEvidence.classify("c2.vendor.avc.decoder", listOf(alias)), NativeDecoderEvidence.Evidence(1, 1, 0))
    println("NativeDecoderEvidenceTest: $checks assertions PASS")
}
