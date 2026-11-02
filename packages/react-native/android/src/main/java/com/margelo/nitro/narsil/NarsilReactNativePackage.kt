package com.margelo.nitro.narsil

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

class NarsilReactNativePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider { HashMap() }

    companion object {
        init {
            try {
                NarsilReactNativeOnLoad.initializeNative()
            } catch (unsupportedAbi: UnsatisfiedLinkError) {
                android.util.Log.e("NarsilReactNative", "Narsil runs only on 64-bit Android", unsupportedAbi)
            }
        }
    }
}
