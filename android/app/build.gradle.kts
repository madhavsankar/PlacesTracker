import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.placestracker.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.placestracker.app"
        minSdk = 26
        targetSdk = 34
        val runNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionCode = runNumber
        versionName = "1.0.$runNumber"
        val defaultWebUrl = localProps.getProperty("PLACES_TRACKER_URL")
            ?: System.getenv("PLACES_TRACKER_URL")
            ?: "https://places-tracker.example.workers.dev"
        buildConfigField("String", "DEFAULT_WEB_URL", "\"$defaultWebUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    val keystorePath = localProps.getProperty("KEYSTORE_FILE")
        ?: System.getenv("KEYSTORE_FILE")
        ?: ""
    val keystorePassword = localProps.getProperty("KEYSTORE_PASSWORD")
        ?: System.getenv("KEYSTORE_PASSWORD")
        ?: ""
    val keyAliasName = localProps.getProperty("KEY_ALIAS")
        ?: System.getenv("KEY_ALIAS")
        ?: "upload"
    val keyPasswordValue = localProps.getProperty("KEY_PASSWORD")
        ?: System.getenv("KEY_PASSWORD")
        ?: keystorePassword
    val keystoreFile = if (keystorePath.isNotBlank()) file(keystorePath) else null
    val hasReleaseKeystore = keystoreFile != null && keystoreFile.exists() && keystorePassword.isNotBlank()

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.gms:play-services-auth:21.2.0")
    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-analytics")
}

