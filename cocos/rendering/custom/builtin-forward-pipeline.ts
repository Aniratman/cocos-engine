/*
 Copyright (c) 2021-2023 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

import { DEBUG } from 'internal:constants';
import { sys, Vec2, Vec3, Vec4 } from '../../core';
import { AABB } from '../../core/geometry/aabb';
import { Frustum } from '../../core/geometry/frustum';
import intersect from '../../core/geometry/intersect';
import { Sphere } from '../../core/geometry/sphere';
import { ClearFlagBit, Color, Format, FormatFeatureBit, LoadOp, StoreOp, Viewport } from '../../gfx/base/define';
import { RenderScene } from '../../render-scene/core/render-scene';
import { RenderWindow } from '../../render-scene/core/render-window';
import { Camera, CameraUsage } from '../../render-scene/scene/camera';
import { DirectionalLight } from '../../render-scene/scene/directional-light';
import { Light, LightType } from '../../render-scene/scene/light';
import { CSMLevel } from '../../render-scene/scene/shadows';
import { SpotLight } from '../../render-scene/scene/spot-light';
import { BasicPipeline, BasicRenderPassBuilder, PipelineBuilder } from './pipeline';
import { QueueHint, SceneFlags } from './types';
import { supportsR32FloatTexture } from '../define';
import { Material } from '../../asset/assets';
import { PipelineSettings } from './settings';
import { getEditorPipelineCamera, getEditorPipelineSettings } from './framework';

function forwardNeedClearColor (camera: Camera): boolean {
    return !!(camera.clearFlag & (ClearFlagBit.COLOR | (ClearFlagBit.STENCIL << 1)));
}

function getCsmMainLightViewport (
    light: DirectionalLight,
    w: number,
    h: number,
    level: number,
    vp: Viewport,
    screenSpaceSignY: number,
): void {
    if (light.shadowFixedArea || light.csmLevel === CSMLevel.LEVEL_1) {
        vp.left = 0;
        vp.top = 0;
        vp.width = Math.trunc(w);
        vp.height = Math.trunc(h);
    } else {
        vp.left = Math.trunc(level % 2 * 0.5 * w);
        if (screenSpaceSignY > 0) {
            vp.top = Math.trunc((1 - Math.floor(level / 2)) * 0.5 * h);
        } else {
            vp.top = Math.trunc(Math.floor(level / 2) * 0.5 * h);
        }
        vp.width = Math.trunc(0.5 * w);
        vp.height = Math.trunc(0.5 * h);
    }
    vp.left = Math.max(0, vp.left);
    vp.top = Math.max(0, vp.top);
    vp.width = Math.max(1, vp.width);
    vp.height = Math.max(1, vp.height);
}

class ForwardLighting {
    // Active lights
    private readonly lights: Light[] = [];
    // Active spot lights with shadows (Mutually exclusive with `lights`)
    private readonly shadowEnabledSpotLights: SpotLight[] = [];

    // Internal cached resources
    private readonly _sphere = Sphere.create(0, 0, 0, 1);
    private readonly _boundingBox = new AABB();
    private readonly _rangedDirLightBoundingBox = new AABB(0.0, 0.0, 0.0, 0.5, 0.5, 0.5);

    //----------------------------------------------------------------
    // Interface
    //----------------------------------------------------------------
    public cullLights (scene: RenderScene, frustum: Frustum, cameraPos?: Vec3): void {
        // TODO(zhouzhenglong): Make light culling native
        this.lights.length = 0;
        this.shadowEnabledSpotLights.length = 0;
        // spot lights
        for (const light of scene.spotLights) {
            if (light.baked) {
                continue;
            }
            Sphere.set(this._sphere, light.position.x, light.position.y, light.position.z, light.range);
            if (intersect.sphereFrustum(this._sphere, frustum)) {
                if (light.shadowEnabled) {
                    this.shadowEnabledSpotLights.push(light);
                } else {
                    this.lights.push(light);
                }
            }
        }
        // sphere lights
        for (const light of scene.sphereLights) {
            if (light.baked) {
                continue;
            }
            Sphere.set(this._sphere, light.position.x, light.position.y, light.position.z, light.range);
            if (intersect.sphereFrustum(this._sphere, frustum)) {
                this.lights.push(light);
            }
        }
        // point lights
        for (const light of scene.pointLights) {
            if (light.baked) {
                continue;
            }
            Sphere.set(this._sphere, light.position.x, light.position.y, light.position.z, light.range);
            if (intersect.sphereFrustum(this._sphere, frustum)) {
                this.lights.push(light);
            }
        }
        // ranged dir lights
        for (const light of scene.rangedDirLights) {
            AABB.transform(this._boundingBox, this._rangedDirLightBoundingBox, light.node!.getWorldMatrix());
            if (intersect.aabbFrustum(this._boundingBox, frustum)) {
                this.lights.push(light);
            }
        }

        if (cameraPos) {
            this.shadowEnabledSpotLights.sort(
                (lhs, rhs) => Vec3.squaredDistance(cameraPos, lhs.position) - Vec3.squaredDistance(cameraPos, rhs.position),
            );
        }
    }
    private _addLightQueues (camera: Camera, pass: BasicRenderPassBuilder): void {
        for (const light of this.lights) {
            const queue = pass.addQueue(QueueHint.BLEND, 'forward-add');
            switch (light.type) {
            case LightType.SPHERE:
                queue.name = 'sphere-light';
                break;
            case LightType.SPOT:
                queue.name = 'spot-light';
                break;
            case LightType.POINT:
                queue.name = 'point-light';
                break;
            case LightType.RANGED_DIRECTIONAL:
                queue.name = 'ranged-directional-light';
                break;
            default:
                queue.name = 'unknown-light';
            }
            queue.addScene(
                camera,
                SceneFlags.BLEND,
                light,
            );
        }
    }
    public addMobileShadowPasses (ppl: BasicPipeline, camera: Camera, maxNumShadowMaps: number): void {
        let i = 0;
        for (const light of this.shadowEnabledSpotLights) {
            const shadowMapSize = ppl.pipelineSceneData.shadows.size;
            const shadowPass = ppl.addRenderPass(shadowMapSize.x, shadowMapSize.y, 'default');
            shadowPass.name = `SpotLightShadowPass${i}`;
            shadowPass.addRenderTarget(`SpotShadowMap${i}`, LoadOp.CLEAR, StoreOp.STORE, new Color(1, 1, 1, 1));
            shadowPass.addDepthStencil(`SpotShadowDepth${i}`, LoadOp.CLEAR, StoreOp.DISCARD);
            shadowPass.addQueue(QueueHint.NONE, 'shadow-caster')
                .addScene(camera, SceneFlags.OPAQUE | SceneFlags.MASK | SceneFlags.SHADOW_CASTER)
                .useLightFrustum(light);
            ++i;
            if (i >= maxNumShadowMaps) {
                break;
            }
        }
    }
    public addMobileLightQueues (pass: BasicRenderPassBuilder, camera: Camera, maxNumShadowMaps: number): void {
        this._addLightQueues(camera, pass);
        let i = 0;
        for (const light of this.shadowEnabledSpotLights) {
            // Add spot-light pass
            // Save last RenderPass to the `pass` variable
            // TODO(zhouzhenglong): Fix per queue addTexture
            pass.addTexture(`SpotShadowMap${i}`, 'cc_spotShadowMap');
            const queue = pass.addQueue(QueueHint.BLEND, 'forward-add');
            queue.addScene(camera, SceneFlags.BLEND, light);
            ++i;
            if (i >= maxNumShadowMaps) {
                break;
            }
        }
    }

    // Notice: ForwardLighting cannot handle a lot of lights.
    // If there are too many lights, the performance will be very poor.
    // If many lights are needed, please implement a forward+ or deferred rendering pipeline.
    public addLightPasses (
        colorName: string,
        depthStencilName: string,
        id: number, // window id
        width: number,
        height: number,
        camera: Camera,
        ppl: BasicPipeline,
        pass: BasicRenderPassBuilder,
    ): BasicRenderPassBuilder {
        this._addLightQueues(camera, pass);

        const shadowMapSize = ppl.pipelineSceneData.shadows.size;
        for (const light of this.shadowEnabledSpotLights) {
            const shadowPass = ppl.addRenderPass(shadowMapSize.x, shadowMapSize.y, 'default');
            shadowPass.name = 'SpotlightShadowPass';
            // Reuse csm shadow map
            shadowPass.addRenderTarget(`ShadowMap${id}`, LoadOp.CLEAR, StoreOp.STORE, new Color(1, 1, 1, 1));
            shadowPass.addDepthStencil(`ShadowDepth${id}`, LoadOp.CLEAR, StoreOp.DISCARD);
            shadowPass.addQueue(QueueHint.NONE, 'shadow-caster')
                .addScene(camera, SceneFlags.OPAQUE | SceneFlags.MASK | SceneFlags.SHADOW_CASTER)
                .useLightFrustum(light);

            // Add spot-light pass
            // Save last RenderPass to the `pass` variable
            pass = ppl.addRenderPass(width, height, 'default');
            pass.name = 'SpotlightWithShadowMap';
            pass.addRenderTarget(colorName, LoadOp.LOAD);
            pass.addDepthStencil(depthStencilName, LoadOp.LOAD);
            pass.addTexture(`ShadowMap${id}`, 'cc_spotShadowMap');
            const queue = pass.addQueue(QueueHint.BLEND, 'forward-add');
            queue.addScene(
                camera,
                SceneFlags.BLEND,
                light,
            );
        }
        return pass;
    }
}

class PipelineConfigs {
    isMobile = false;
    isHDR = false;
    useFloatOutput = false;
    toneMappingType = 0; // 0: ACES, 1: None
    shadowMapFormat = Format.R32F;
    shadowMapSize = new Vec2(1, 1);
    screenSpaceSignY = 1;
    supportDepthSample = false;
    mobileMaxSpotLightShadowMaps = 1;
    g_platform = new Vec4(0, 0, 0, 0);
}

function setupPipelineConfigs (
    ppl: BasicPipeline,
    configs: PipelineConfigs,
): void {
    const sampleFeature = FormatFeatureBit.SAMPLED_TEXTURE | FormatFeatureBit.LINEAR_FILTER;

    configs.isMobile = sys.isMobile;
    configs.isHDR = ppl.pipelineSceneData.isHDR; // Has tone mapping
    configs.useFloatOutput = ppl.getMacroBool('CC_USE_FLOAT_OUTPUT');
    configs.toneMappingType = ppl.pipelineSceneData.postSettings.toneMappingType;
    configs.shadowMapFormat = supportsR32FloatTexture(ppl.device) ? Format.R32F : Format.RGBA8;
    configs.shadowMapSize.set(ppl.pipelineSceneData.shadows.size);
    configs.screenSpaceSignY = ppl.device.capabilities.screenSpaceSignY;
    configs.supportDepthSample = (ppl.device.getFormatFeatures(Format.DEPTH_STENCIL) & sampleFeature) === sampleFeature;

    const device = ppl.device;
    configs.g_platform.x = configs.isMobile ? 1.0 : 0.0;
    configs.g_platform.w = (device.capabilities.screenSpaceSignY * 0.5 + 0.5) << 1 | (device.capabilities.clipSpaceSignY * 0.5 + 0.5);
}

class CameraConfigs {
    enableShadowMap = false;
    enablePostProcess = false;
    enableProfiler = false;
    enableShadingScale = false;
    shadingScale = 0.5;
    pipelineSettings: PipelineSettings | null = null;
}

function setupCameraConfigs (
    camera: Camera,
    pipelineConfigs: PipelineConfigs,
    cameraConfigs: CameraConfigs,
): void {
    cameraConfigs.enableShadowMap = camera.scene
        ? camera.scene.mainLight !== null && camera.scene.mainLight.shadowEnabled
        : false;
    const isMainGameWindow: boolean = camera.cameraUsage === CameraUsage.GAME && !!camera.window.swapchain;
    const isEditorView: boolean = camera.cameraUsage === CameraUsage.SCENE_VIEW || camera.cameraUsage === CameraUsage.PREVIEW;
    cameraConfigs.enablePostProcess = pipelineConfigs.useFloatOutput && camera.usePostProcess && (isMainGameWindow || isEditorView);
    cameraConfigs.enableProfiler = DEBUG && isMainGameWindow;
    cameraConfigs.pipelineSettings = camera.pipelineSettings;

    if (isEditorView) {
        cameraConfigs.pipelineSettings = getEditorPipelineSettings();
        if (cameraConfigs.pipelineSettings) {
            const pipelineCamera: Camera | null = getEditorPipelineCamera();
            cameraConfigs.enablePostProcess = pipelineConfigs.useFloatOutput
                && pipelineCamera !== null && pipelineCamera.usePostProcess;
        } else {
            cameraConfigs.enablePostProcess = false;
        }
    }

    cameraConfigs.enableShadingScale = cameraConfigs.pipelineSettings !== null
        && cameraConfigs.pipelineSettings.enableShadingScale;
    cameraConfigs.shadingScale = cameraConfigs.pipelineSettings !== null
        ? cameraConfigs.pipelineSettings.shadingScale
        : 1.0;
}

export class BuiltinForwardPipeline implements PipelineBuilder {
    // Internal cached resources
    private readonly _clearColor = new Color(0, 0, 0, 1);
    private readonly _clearColorOpaqueBlack = new Color(0, 0, 0, 0);
    private readonly _viewport = new Viewport();
    private readonly _configs = new PipelineConfigs();
    private readonly _cameraConfigs = new CameraConfigs();
    // DepthOfField
    private readonly _cocParams = new Vec4(0, 0, 0, 0);
    private readonly _cocTexSize = new Vec4(0, 0, 0, 0);
    // Bloom
    private readonly _bloomParams = new Vec4(0, 0, 0, 0);
    private readonly _bloomTexSize = new Vec4(0, 0, 0, 0);
    private readonly _bloomWidths: Array<number> = [];
    private readonly _bloomHeights: Array<number> = [];
    private readonly _bloomTexNames: Array<string> = [];
    // Materials
    private readonly _copyAndTonemapMaterial = new Material();
    private readonly _dofMaterial = new Material();
    private readonly _bloomMaterial = new Material();
    private readonly _fxaaMaterial = new Material();
    private _initialized = false; // TODO(zhouzhenglong): Make default effect asset loading earlier and remove this flag

    // Forward lighting
    private readonly forwardLighting = new ForwardLighting();

    //----------------------------------------------------------------
    // Interface
    //----------------------------------------------------------------
    windowResize (ppl: BasicPipeline, window: RenderWindow, camera: Camera, nativeWidth: number, nativeHeight: number): void {
        setupPipelineConfigs(ppl, this._configs);
        setupCameraConfigs(camera, this._configs, this._cameraConfigs);
        const settings = this._cameraConfigs.pipelineSettings;
        const id = window.renderWindowId;

        const width = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeWidth * this._cameraConfigs.shadingScale), 1)
            : nativeWidth;
        const height = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeHeight * this._cameraConfigs.shadingScale), 1)
            : nativeHeight;

        // Render Window (UI)
        ppl.addRenderWindow(window.colorName, Format.BGRA8, nativeWidth, nativeHeight, window);

        // Radiance
        if (this._configs.useFloatOutput) {
            ppl.addRenderTarget(`Radiance${id}`, Format.RGBA16F, width, height);
        } else if (this._cameraConfigs.enableShadingScale) {
            ppl.addRenderTarget(`Radiance${id}`, Format.RGBA8, width, height);
        } else {
            // Reuse render window
        }
        ppl.addDepthStencil(window.depthStencilName, Format.DEPTH_STENCIL, width, height);

        // Mainlight ShadowMap
        ppl.addRenderTarget(
            `ShadowMap${id}`,
            this._configs.shadowMapFormat,
            this._configs.shadowMapSize.x,
            this._configs.shadowMapSize.y,
        );
        ppl.addDepthStencil(
            `ShadowDepth${id}`,
            Format.DEPTH_STENCIL,
            this._configs.shadowMapSize.x,
            this._configs.shadowMapSize.y,
        );

        // Mobile spot-light shadow map
        if (this._configs.isMobile) {
            const count = this._configs.mobileMaxSpotLightShadowMaps;
            for (let i = 0; i !== count; ++i) {
                ppl.addRenderTarget(
                    `SpotShadowMap${i}`,
                    this._configs.shadowMapFormat,
                    this._configs.shadowMapSize.x,
                    this._configs.shadowMapSize.y,
                );
                ppl.addDepthStencil(
                    `SpotShadowDepth${i}`,
                    Format.DEPTH_STENCIL,
                    this._configs.shadowMapSize.x,
                    this._configs.shadowMapSize.y,
                );
            }
        }

        // Post Process
        if (this._cameraConfigs.enablePostProcess && settings != null) {
            // Ldr Color
            if (settings.fxaa.enabled || settings.depthOfField.enabled) {
                ppl.addRenderTarget(`LdrColor${id}`, Format.RGBA8, width, height);
            }
            if (settings.fxaa.enabled && this._cameraConfigs.enableShadingScale) {
                ppl.addRenderTarget(`AaColor${id}`, Format.RGBA8, width, height);
            }
            // DepthOfField
            if (settings.depthOfField.enabled) {
                const halfWidth = Math.max(Math.floor(width / 2), 1);
                const halfHeight = Math.max(Math.floor(height / 2), 1);
                // `DofCoc${id}` texture will reuse `LdrColor${id}`
                ppl.addRenderTarget(`DofRadiance${id}`, Format.RGBA16F, width, height);
                ppl.addRenderTarget(`DofPrefilter${id}`, Format.RGBA16F, halfWidth, halfHeight);
                ppl.addRenderTarget(`DofBokeh${id}`, Format.RGBA16F, halfWidth, halfHeight);
                ppl.addRenderTarget(`DofFilter${id}`, Format.RGBA16F, halfWidth, halfHeight);
            }
            // Bloom (Kawase Dual Filter)
            if (settings.bloom.enabled) {
                let bloomWidth = width;
                let bloomHeight = height;
                for (let i = 0; i !== settings.bloom.iterations + 1; ++i) {
                    bloomWidth = Math.max(Math.floor(bloomWidth / 2), 1);
                    bloomHeight = Math.max(Math.floor(bloomHeight / 2), 1);
                    ppl.addRenderTarget(`BloomTex${id}_${i}`, Format.RGBA16F, bloomWidth, bloomHeight);
                }
            }
        }
    }
    setup (cameras: Camera[], ppl: BasicPipeline): void {
        // TODO(zhouzhenglong): Make default effect asset loading earlier and remove _initMaterials
        if (this._initMaterials(ppl)) {
            return;
        }
        // Render cameras
        for (const camera of cameras) {
            // Skip invalid camera
            if (camera.scene === null || camera.window === null) {
                continue;
            }
            // Setup camera configs
            setupCameraConfigs(camera, this._configs, this._cameraConfigs);

            // Build pipeline
            if (this._configs.isMobile) {
                this._buildMobileForwardPipeline(ppl, camera, camera.scene);
            } else {
                this._buildForwardPipeline(ppl, camera, camera.scene);
            }
        }
    }

    //----------------------------------------------------------------
    // Pipelines
    //----------------------------------------------------------------
    // Desktop
    private _buildForwardPipeline (
        ppl: BasicPipeline,
        camera: Camera,
        scene: RenderScene,
    ): void {
        // Init
        const settings = this._cameraConfigs.pipelineSettings;
        const nativeWidth = Math.max(Math.floor(camera.window.width), 1);
        const nativeHeight = Math.max(Math.floor(camera.window.height), 1);
        const width = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeWidth * this._cameraConfigs.shadingScale), 1)
            : nativeWidth;
        const height = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeHeight * this._cameraConfigs.shadingScale), 1)
            : nativeHeight;
        const id = camera.window.renderWindowId;
        const colorName = camera.window.colorName;
        const depthStencilName = camera.window.depthStencilName;
        const dofRadianceName = `DofRadiance${id}`;
        const radianceName = `Radiance${id}`;
        const ldrColorName = `LdrColor${id}`;
        const aaColorName = `AaColor${id}`;
        const mainLight = scene.mainLight;

        // Forward Lighting (Light Culling)
        this.forwardLighting.cullLights(scene, camera.frustum);

        // Main Directional light CSM Shadow Map
        if (this._cameraConfigs.enableShadowMap) {
            this._addCascadedShadowMapPass(ppl, id, mainLight!, camera);
        }

        // Forward Lighting
        let lastPass: BasicRenderPassBuilder;
        if (this._configs.useFloatOutput) { // HDR
            if (this._cameraConfigs.enablePostProcess && settings != null) {
                // Post Process
                if (this._configs.supportDepthSample && settings.depthOfField.enabled) {
                    this._addForwardRadiancePasses(ppl, id, camera, width, height, mainLight, dofRadianceName, depthStencilName);
                    this._addDepthOfFieldPasses(ppl, settings, id, camera, width, height, dofRadianceName, depthStencilName, radianceName);
                } else {
                    this._addForwardRadiancePasses(ppl, id, camera, width, height, mainLight, radianceName, depthStencilName);
                }
                if (settings.bloom.enabled) {
                    this._addKawaseDualFilterBloomPasses(ppl, settings, id, width, height, radianceName);
                }
                if (settings.fxaa.enabled) {
                    // FXAA is applied after tone mapping
                    this._addCopyAndTonemapPass(ppl, width, height, radianceName, ldrColorName);
                    // Apply FXAA
                    if (this._cameraConfigs.enableShadingScale) {
                        // Apply FXAA on scaled image
                        this._addFxaaPass(ppl, width, height, ldrColorName, aaColorName);
                        // Copy AA result to screen
                        lastPass = this._addCopyPass(ppl, nativeWidth, nativeHeight, aaColorName, colorName);
                    } else {
                        // Image not scaled, output FXAA result to screen directly
                        lastPass = this._addFxaaPass(ppl, nativeWidth, nativeHeight, ldrColorName, colorName);
                    }
                } else {
                    // No FXAA, tonemap HDR result to screen directly (Size might be scaled)
                    lastPass = this._addCopyAndTonemapPass(ppl, nativeWidth, nativeHeight, radianceName, colorName);
                }
            } else {
                // No post process, output HDR result to screen directly (Size might be scaled)
                this._addForwardRadiancePasses(ppl, id, camera, width, height, mainLight, radianceName, depthStencilName);
                lastPass = this._addCopyAndTonemapPass(ppl, nativeWidth, nativeHeight, radianceName, colorName);
            }
        } else if (this._cameraConfigs.enableShadingScale) { // LDR (Size is scaled)
            this._addForwardRadiancePasses(ppl, id, camera, width, height, mainLight, radianceName, depthStencilName);
            lastPass = this._addCopyAndTonemapPass(ppl, nativeWidth, nativeHeight, radianceName, colorName);
        } else { // LDR (Size is not scaled)
            lastPass = this._addForwardRadiancePasses(ppl, id, camera, nativeWidth, nativeHeight, mainLight, colorName, depthStencilName);
        }
        // UI size is not scaled, does not have AA
        this._addUIQueue(camera, lastPass);
    }

    // Mobile
    private _buildMobileForwardPipeline (
        ppl: BasicPipeline,
        camera: Camera,
        scene: RenderScene,
    ): void {
        // Init
        const nativeWidth = Math.max(Math.floor(camera.window.width), 1);
        const nativeHeight = Math.max(Math.floor(camera.window.height), 1);
        const width = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeWidth * this._cameraConfigs.shadingScale), 1)
            : nativeWidth;
        const height = this._cameraConfigs.enableShadingScale
            ? Math.max(Math.floor(nativeHeight * this._cameraConfigs.shadingScale), 1)
            : nativeHeight;

        const id = camera.window.renderWindowId;
        const colorName = camera.window.colorName;
        const depthStencilName = camera.window.depthStencilName;
        const radianceName = `Radiance${id}`;
        const mainLight = scene.mainLight;

        // Forward Lighting (Light Culling)
        this.forwardLighting.cullLights(scene, camera.frustum, camera.position);

        // Main Directional light CSM shadow map
        if (this._cameraConfigs.enableShadowMap) {
            this._addCascadedShadowMapPass(ppl, id, mainLight!, camera);
        }

        // Spot light shadow maps
        // Currently, only support 1 spot light with shadow map on mobile platform.
        // TODO(zhouzhenglong): Relex this limitation.
        this.forwardLighting.addMobileShadowPasses(ppl, camera, this._configs.mobileMaxSpotLightShadowMaps);

        // Forward Lighting
        let lastPass: BasicRenderPassBuilder;
        if (this._configs.useFloatOutput || this._cameraConfigs.enableShadingScale) {
            this._addMobileForwardRadiancePass(ppl, id, camera, width, height, radianceName, depthStencilName, mainLight);
            lastPass = this._addCopyAndTonemapPass(ppl, nativeWidth, nativeHeight, radianceName, colorName);
        } else {
            lastPass = this._addMobileForwardRadiancePass(ppl, id, camera, nativeWidth, nativeHeight, colorName, depthStencilName, mainLight);
        }
        this._addUIQueue(camera, lastPass);
    }

    //----------------------------------------------------------------
    // Common Passes
    //----------------------------------------------------------------
    private _addCascadedShadowMapPass (
        ppl: BasicPipeline,
        id: number,
        light: DirectionalLight,
        camera: Camera,
    ): void {
        //----------------------------------------------------------------
        // Dynamic states
        //----------------------------------------------------------------
        const width = ppl.pipelineSceneData.shadows.size.x;
        const height = ppl.pipelineSceneData.shadows.size.y;
        this._viewport.left = 0;
        this._viewport.top = 0;
        this._viewport.width = width;
        this._viewport.height = height;

        //----------------------------------------------------------------
        // CSM Shadow Map
        //----------------------------------------------------------------
        const pass = ppl.addRenderPass(width, height, 'default');
        pass.name = 'CSM';
        pass.addRenderTarget(`ShadowMap${id}`, LoadOp.CLEAR, StoreOp.STORE, new Color(1, 1, 1, 1));
        pass.addDepthStencil(`ShadowDepth${id}`, LoadOp.CLEAR, StoreOp.DISCARD);
        const csmLevel = ppl.pipelineSceneData.csmSupported ? light.csmLevel : 1;

        // Add shadow map viewports
        for (let level = 0; level !== csmLevel; ++level) {
            getCsmMainLightViewport(light, width, height, level, this._viewport, this._configs.screenSpaceSignY);
            const queue = pass.addQueue(QueueHint.NONE, 'shadow-caster');
            queue.setViewport(this._viewport);
            queue
                .addScene(camera, SceneFlags.OPAQUE | SceneFlags.MASK | SceneFlags.SHADOW_CASTER)
                .useLightFrustum(light, level);
        }
    }

    private _addCopyPass (
        ppl: BasicPipeline,
        width: number,
        height: number,
        input: string,
        output: string,
    ): BasicRenderPassBuilder {
        const pass = ppl.addRenderPass(width, height, 'post-copy');
        pass.addRenderTarget(output, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        pass.addTexture(input, 'inputTexture');
        pass.setVec4('g_platform', this._configs.g_platform);
        pass.addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._copyAndTonemapMaterial, 2);
        return pass;
    }

    private _addCopyAndTonemapPass (
        ppl: BasicPipeline,
        width: number,
        height: number,
        radianceName: string,
        colorName: string,
    ): BasicRenderPassBuilder {
        const pass = ppl.addRenderPass(width, height, 'post-final-tonemap');
        pass.addRenderTarget(colorName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        pass.addTexture(radianceName, 'inputTexture');
        pass.setVec4('g_platform', this._configs.g_platform);
        pass.addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._copyAndTonemapMaterial, 1);
        return pass;
    }

    private _buildForwardMainLightPass (
        pass: BasicRenderPassBuilder,
        id: number,
        camera: Camera,
        colorName: string,
        depthStencilName: string,
        mainLight: DirectionalLight | null,
    ): void {
        // set viewport
        pass.setViewport(this._viewport);

        // bind output render target
        if (forwardNeedClearColor(camera)) {
            pass.addRenderTarget(colorName, LoadOp.CLEAR, StoreOp.STORE, this._clearColor);
        } else {
            pass.addRenderTarget(colorName, LoadOp.LOAD);
        }

        // bind depth stencil buffer
        if (camera.clearFlag & ClearFlagBit.DEPTH_STENCIL) {
            pass.addDepthStencil(
                depthStencilName,
                LoadOp.CLEAR,
                StoreOp.STORE,
                camera.clearDepth,
                camera.clearStencil,
                camera.clearFlag & ClearFlagBit.DEPTH_STENCIL,
            );
        } else {
            pass.addDepthStencil(depthStencilName, LoadOp.LOAD);
        }

        // Set shadow map if enabled
        if (this._cameraConfigs.enableShadowMap) {
            pass.addTexture(`ShadowMap${id}`, 'cc_shadowMap');
        }

        // TODO(zhouzhenglong): Separate OPAQUE and MASK queue

        // add opaque and mask queue
        pass.addQueue(QueueHint.NONE) // Currently we put OPAQUE and MASK into one queue, so QueueHint is NONE
            .addScene(camera, SceneFlags.OPAQUE | SceneFlags.MASK, mainLight || undefined);
    }

    private _addDepthOfFieldPasses (
        ppl: BasicPipeline,
        settings: PipelineSettings,
        id: number,
        camera: Camera,
        width: number,
        height: number,
        dofRadianceName: string,
        depthStencil: string,
        radianceName: string,
    ): void {
        // https://catlikecoding.com/unity/tutorials/advanced-rendering/depth-of-field/

        this._cocParams.x = settings.depthOfField.focusDistance;
        this._cocParams.y = settings.depthOfField.focusRange;
        this._cocParams.z = settings.depthOfField.bokehRadius;
        this._cocParams.w = 0.0;
        this._cocTexSize.x = 1.0 / width;
        this._cocTexSize.y = 1.0 / height;
        this._cocTexSize.z = width;
        this._cocTexSize.w = height;
        this._dofMaterial.setProperty('cocParams', this._cocParams);
        this._dofMaterial.setProperty('mainTexTexelSize', this._cocTexSize);

        const halfWidth = Math.max(Math.floor(width / 2), 1);
        const halfHeight = Math.max(Math.floor(height / 2), 1);

        const cocName = `LdrColor${id}`;
        const prefilterName = `DofPrefilter${id}`;
        const bokehName = `DofBokeh${id}`;
        const filterName = `DofFilter${id}`;

        // CoC
        const cocPass = ppl.addRenderPass(width, height, 'dof-coc');
        cocPass.addRenderTarget(cocName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        cocPass.addTexture(depthStencil, 'DepthTex');
        cocPass
            .addQueue(QueueHint.OPAQUE)
            .addCameraQuad(camera, this._dofMaterial, 0); // addCameraQuad will set camera related UBOs

        // Downsample and Prefilter
        const prefilterPass = ppl.addRenderPass(halfWidth, halfHeight, 'dof-prefilter');
        prefilterPass.addRenderTarget(prefilterName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        prefilterPass.addTexture(cocName, 'cocTex');
        prefilterPass.addTexture(dofRadianceName, 'colorTex');
        prefilterPass.setVec4('cc_cameraPos', this._configs.g_platform); // We only use cc_cameraPos.w
        prefilterPass
            .addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._dofMaterial, 1);

        // Bokeh blur
        const bokehPass = ppl.addRenderPass(halfWidth, halfHeight, 'dof-bokeh');
        bokehPass.addRenderTarget(bokehName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        bokehPass.addTexture(prefilterName, 'prefilterTex');
        bokehPass.setVec4('cc_cameraPos', this._configs.g_platform); // We only use cc_cameraPos.w
        bokehPass
            .addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._dofMaterial, 2);

        // Filtering
        const filterPass = ppl.addRenderPass(halfWidth, halfHeight, 'dof-filter');
        filterPass.addRenderTarget(filterName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        filterPass.addTexture(bokehName, 'bokehTex');
        filterPass.setVec4('cc_cameraPos', this._configs.g_platform); // We only use cc_cameraPos.w
        filterPass
            .addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._dofMaterial, 3);

        // Combine
        const combinePass = ppl.addRenderPass(width, height, 'dof-combine');
        combinePass.addRenderTarget(radianceName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        combinePass.addTexture(filterName, 'filterTex');
        combinePass.addTexture(dofRadianceName, 'colorTex');
        combinePass.addTexture(cocName, 'cocTex');
        combinePass.setVec4('cc_cameraPos', this._configs.g_platform); // We only use cc_cameraPos.w
        combinePass
            .addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._dofMaterial, 4);
    }

    private _addKawaseDualFilterBloomPasses (
        ppl: BasicPipeline,
        settings: PipelineSettings,
        id: number,
        width: number,
        height: number,
        radianceName: string,
    ): void {
        // Based on Kawase Dual Filter Blur. Saves bandwidth on mobile devices.
        // eslint-disable-next-line max-len
        // https://community.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_marius_2D00_slides.pdf

        // Size: [prefilter(1/2), downsample(1/4), downsample(1/8), downsample(1/16), ...]
        const iterations = settings.bloom.iterations;
        const sizeCount = iterations + 1;
        this._bloomWidths.length = sizeCount;
        this._bloomHeights.length = sizeCount;
        this._bloomWidths[0] = Math.max(Math.floor(width / 2), 1);
        this._bloomHeights[0] = Math.max(Math.floor(height / 2), 1);
        for (let i = 1; i !== sizeCount; ++i) {
            this._bloomWidths[i] = Math.max(Math.floor(this._bloomWidths[i - 1] / 2), 1);
            this._bloomHeights[i] = Math.max(Math.floor(this._bloomHeights[i - 1] / 2), 1);
        }

        // Bloom texture names
        this._bloomTexNames.length = sizeCount;
        for (let i = 0; i !== sizeCount; ++i) {
            this._bloomTexNames[i] = `BloomTex${id}_${i}`;
        }

        // Setup bloom parameters
        this._bloomParams.x = this._configs.useFloatOutput ? 1 : 0;
        this._bloomParams.x = 0; // unused
        this._bloomParams.z = settings.bloom.threshold;
        this._bloomParams.w = settings.bloom.enableAlphaMask ? 1 : 0;

        // Prefilter pass
        const prefilterPass = ppl.addRenderPass(this._bloomWidths[0], this._bloomHeights[0], 'bloom1-prefilter');
        prefilterPass.addRenderTarget(
            this._bloomTexNames[0],
            LoadOp.CLEAR,
            StoreOp.STORE,
            this._clearColorOpaqueBlack,
        );
        prefilterPass.addTexture(radianceName, 'inputTexture');
        prefilterPass.setVec4('g_platform', this._configs.g_platform);
        prefilterPass.setVec4('bloomParams', this._bloomParams);
        prefilterPass
            .addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._bloomMaterial, 0);

        // Downsample passes
        for (let i = 1; i !== sizeCount; ++i) {
            const downPass = ppl.addRenderPass(this._bloomWidths[i], this._bloomHeights[i], 'bloom1-downsample');
            downPass.addRenderTarget(this._bloomTexNames[i], LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
            downPass.addTexture(this._bloomTexNames[i - 1], 'bloomTexture');
            this._bloomTexSize.x = this._bloomWidths[i - 1];
            this._bloomTexSize.y = this._bloomHeights[i - 1];
            downPass.setVec4('g_platform', this._configs.g_platform);
            downPass.setVec4('bloomTexSize', this._bloomTexSize);
            downPass
                .addQueue(QueueHint.OPAQUE)
                .addFullscreenQuad(this._bloomMaterial, 1);
        }

        // Upsample passes
        for (let i = iterations; i-- > 0;) {
            const upPass = ppl.addRenderPass(this._bloomWidths[i], this._bloomHeights[i], 'bloom1-upsample');
            upPass.addRenderTarget(this._bloomTexNames[i], LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
            upPass.addTexture(this._bloomTexNames[i + 1], 'bloomTexture');
            this._bloomTexSize.x = this._bloomWidths[i + 1];
            this._bloomTexSize.y = this._bloomHeights[i + 1];
            upPass.setVec4('g_platform', this._configs.g_platform);
            upPass.setVec4('bloomTexSize', this._bloomTexSize);
            upPass
                .addQueue(QueueHint.OPAQUE)
                .addFullscreenQuad(this._bloomMaterial, 2);
        }

        // Combine pass
        const combinePass = ppl.addRenderPass(width, height, 'bloom1-combine');
        combinePass.addRenderTarget(radianceName, LoadOp.LOAD, StoreOp.STORE);
        combinePass.addTexture(this._bloomTexNames[0], 'bloomTexture');
        combinePass.setVec4('g_platform', this._configs.g_platform);
        combinePass.setVec4('bloomParams', this._bloomParams);
        combinePass
            .addQueue(QueueHint.BLEND)
            .addFullscreenQuad(this._bloomMaterial, 3);
    }

    private _addFxaaPass (
        ppl: BasicPipeline,
        width: number,
        height: number,
        ldrColorName: string,
        colorName: string,
    ): BasicRenderPassBuilder {
        this._fxaaMaterial.setProperty('texSize', new Vec4(width, height, 1 / width, 1 / height));

        const pass = ppl.addRenderPass(width, height, 'fxaa');
        pass.addRenderTarget(colorName, LoadOp.CLEAR, StoreOp.STORE, this._clearColorOpaqueBlack);
        pass.addTexture(ldrColorName, 'sceneColorMap');
        pass.setVec4('cc_cameraPos', this._configs.g_platform); // We only use cc_cameraPos.w
        pass.addQueue(QueueHint.OPAQUE)
            .addFullscreenQuad(this._fxaaMaterial, 0);
        return pass;
    }

    private _addUIQueue (camera: Camera, pass: BasicRenderPassBuilder): void {
        let flags = SceneFlags.UI;
        if (this._cameraConfigs.enableProfiler) {
            flags |= SceneFlags.PROFILER;
            pass.showStatistics = true;
        }
        pass
            .addQueue(QueueHint.BLEND)
            .addScene(camera, flags);
    }

    //----------------------------------------------------------------
    // Desktop
    //----------------------------------------------------------------
    private _addForwardRadiancePasses (
        ppl: BasicPipeline,
        id: number,
        camera: Camera,
        width: number,
        height: number,
        mainLight: DirectionalLight | null,
        colorName: string,
        depthStencilName: string,
    ): BasicRenderPassBuilder {
        //----------------------------------------------------------------
        // Dynamic states
        //----------------------------------------------------------------
        // Prepare camera clear color
        this._clearColor.x = camera.clearColor.x;
        this._clearColor.y = camera.clearColor.y;
        this._clearColor.z = camera.clearColor.z;
        this._clearColor.w = camera.clearColor.w;

        // Prepare camera viewport
        this._viewport.left = Math.floor(camera.viewport.x * width);
        this._viewport.top = Math.floor(camera.viewport.y * height);
        this._viewport.width = Math.floor(camera.viewport.z * width);
        this._viewport.height = Math.floor(camera.viewport.w * height);

        //----------------------------------------------------------------
        // Forward Lighting (Main Directional Light)
        //----------------------------------------------------------------
        const pass = ppl.addRenderPass(width, height, 'default');
        pass.name = 'ForwardPass';
        this._buildForwardMainLightPass(pass, id, camera, colorName, depthStencilName, mainLight);

        //----------------------------------------------------------------
        // Forward Lighting (Additive Lights)
        //----------------------------------------------------------------
        // Additive lights
        const lastPass = this.forwardLighting
            .addLightPasses(colorName, depthStencilName, id, width, height, camera, ppl, pass);

        //----------------------------------------------------------------
        // Forward Lighting (Blend)
        //----------------------------------------------------------------
        // Add transparent queue
        lastPass
            .addQueue(QueueHint.BLEND)
            .addScene(camera, SceneFlags.BLEND, mainLight || undefined);

        return lastPass;
    }

    //----------------------------------------------------------------
    // Mobile
    //----------------------------------------------------------------
    private _addMobileForwardRadiancePass (
        ppl: BasicPipeline,
        id: number,
        camera: Camera,
        width: number,
        height: number,
        colorName: string,
        depthStencilName: string,
        mainLight: DirectionalLight | null,
    ): BasicRenderPassBuilder {
        //----------------------------------------------------------------
        // Dynamic states
        //----------------------------------------------------------------
        // Prepare camera clear color
        this._clearColor.x = camera.clearColor.x;
        this._clearColor.y = camera.clearColor.y;
        this._clearColor.z = camera.clearColor.z;
        this._clearColor.w = camera.clearColor.w;

        // Prepare camera viewport
        this._viewport.left = Math.floor(camera.viewport.x * width);
        this._viewport.top = Math.floor(camera.viewport.y * height);
        this._viewport.width = Math.floor(camera.viewport.z * width);
        this._viewport.height = Math.floor(camera.viewport.w * height);

        //----------------------------------------------------------------
        // Forward Lighting (Main Directional Light)
        //----------------------------------------------------------------
        const pass = ppl.addRenderPass(width, height, 'default');
        pass.name = 'ForwardPass';
        this._buildForwardMainLightPass(pass, id, camera, colorName, depthStencilName, mainLight);

        //----------------------------------------------------------------
        // Forward Lighting (Additive Lights)
        //----------------------------------------------------------------
        // Additive lights
        this.forwardLighting.addMobileLightQueues(
            pass,
            camera,
            this._configs.mobileMaxSpotLightShadowMaps,
        );

        //----------------------------------------------------------------
        // Forward Lighting (Blend)
        //----------------------------------------------------------------
        // Add transparent queue
        pass
            .addQueue(QueueHint.BLEND)
            .addScene(camera, SceneFlags.BLEND, mainLight || undefined);

        return pass;
    }

    private _initMaterials (ppl: BasicPipeline): number {
        if (this._initialized) {
            return 0;
        }

        setupPipelineConfigs(ppl, this._configs);

        // When add new effect asset, please add its uuid to the dependentAssets in cc.config.json.
        this._copyAndTonemapMaterial._uuid = `custom-forward-post-final-tonemap-material`;
        this._copyAndTonemapMaterial.initialize({ effectName: 'pipeline/post-process/post-final' });

        this._dofMaterial._uuid = `custom-forward-post-dof-material`;
        this._dofMaterial.initialize({ effectName: 'pipeline/post-process/dof' });

        this._bloomMaterial._uuid = `custom-forward-post-bloom-material`;
        this._bloomMaterial.initialize({ effectName: 'pipeline/post-process/bloom1' });

        this._fxaaMaterial._uuid = `custom-forward-post-fxaa-material`;
        this._fxaaMaterial.initialize({ effectName: 'pipeline/post-process/fxaa-hq' });

        if (this._copyAndTonemapMaterial.effectAsset !== null
            && this._dofMaterial.effectAsset !== null
            && this._bloomMaterial.effectAsset !== null
            && this._fxaaMaterial.effectAsset !== null
        ) {
            this._initialized = true;
        }

        return this._initialized ? 0 : 1;
    }
}
