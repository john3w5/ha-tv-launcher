import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val dashboardUrl = providers.gradleProperty("dashboardUrl")
    .orElse("http://home-tv.local:4317/").get()
val dashboardUri = URI(dashboardUrl)
val dashboardHost = dashboardUri.host ?: error("dashboardUrl must have a hostname")
val privateIpv4 = dashboardHost.split('.').map { it.toIntOrNull() }.let {
    it.size == 4 && it.all { part -> part != null && part in 0..255 } &&
        (it[0] == 10 || it[0] == 127 || (it[0] == 192 && it[1] == 168) ||
            (it[0] == 172 && it[1]!! in 16..31))
}
val localHost = dashboardHost == "localhost" || dashboardHost.endsWith(".local") ||
    dashboardHost.endsWith(".home.arpa") || privateIpv4
require(dashboardUri.scheme == "https" || (dashboardUri.scheme == "http" && localHost)) {
    "Use HTTPS, or HTTP on an explicit private IPv4/.local/.home.arpa LAN host"
}
require(dashboardUri.userInfo == null && dashboardUri.fragment == null && dashboardUri.rawQuery == null && dashboardUri.path in listOf("", "/")) {
    "dashboardUrl must be a server origin without credentials, path, query or fragment"
}
require(dashboardUri.port == -1 || dashboardUri.port in 1..65535) { "Invalid dashboard port" }
require(Regex("[A-Za-z0-9.-]+").matches(dashboardHost)) { "Unsupported dashboard hostname" }

// Generate a host-specific cleartext exception for an explicitly selected LAN server.
// All other cleartext hosts remain blocked by Android's network security policy.
val networkResources = layout.buildDirectory.dir("generated/dashboardNetwork/res")
val generateDashboardNetwork by tasks.registering {
    inputs.property("dashboardHost", dashboardHost)
    inputs.property("dashboardScheme", dashboardUri.scheme)
    outputs.dir(networkResources)
    doLast {
        val file = networkResources.get().file("xml/network_security_config.xml").asFile
        file.parentFile.mkdirs()
        val domain = if (dashboardUri.scheme == "http") """
            <domain-config cleartextTrafficPermitted="true">
                <domain includeSubdomains="false">$dashboardHost</domain>
            </domain-config>
        """.trimIndent() else ""
        file.writeText("""
            <?xml version="1.0" encoding="utf-8"?>
            <network-security-config>
                <base-config cleartextTrafficPermitted="false">
                    <trust-anchors><certificates src="system" /></trust-anchors>
                </base-config>
                $domain
            </network-security-config>
        """.trimIndent().trimStart())
    }
}

android {
    namespace = "org.hometv.launcher"
    compileSdk = 36
    defaultConfig {
        applicationId = "org.hometv.launcher"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-experimental"
        providers.gradleProperty("tvAbi").orNull?.let { abi ->
            require(abi in listOf("armeabi-v7a", "arm64-v8a")) { "Unsupported TV ABI" }
            ndk { abiFilters += abi }
        }
        buildConfigField("String", "DASHBOARD_URL", "\"${dashboardUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }
    buildFeatures { buildConfig = true }
    sourceSets.getByName("main").res.srcDir(networkResources)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
tasks.named("preBuild").configure { dependsOn(generateDashboardNetwork) }

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    val providedWebRtcAar = providers.gradleProperty("webrtcAarPath").orNull
    if (providedWebRtcAar != null) {
        val aar = file(providedWebRtcAar)
        require(aar.isFile && aar.extension == "aar") { "webrtcAarPath must point to a local WebRTC AAR" }
        implementation(files(aar))
    } else {
        implementation("io.github.webrtc-sdk:android:150.7871.04")
    }
}
