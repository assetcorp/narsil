package com.margelo.nitro.narsil

import android.app.ActivityManager
import android.content.Context
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules

@DoNotStrip
@Keep
object NarsilAndroidEnvironment {
    private const val UNKNOWN_BYTES = -1.0

    @JvmStatic
    @DoNotStrip
    @Keep
    fun availableBytes(): Double {
        val context = NitroModules.applicationContext ?: return UNKNOWN_BYTES
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return UNKNOWN_BYTES
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        return maxOf(0L, info.availMem - info.threshold).toDouble()
    }

    @JvmStatic
    @DoNotStrip
    @Keep
    fun filesDirectory(): String? = NitroModules.applicationContext?.filesDir?.absolutePath
}
