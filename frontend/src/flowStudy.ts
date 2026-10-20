import * as THREE from 'three';
import type { AudioFeatures } from './audio';
import { PALETTE_LIMIT, type CoverVisualProfile } from './coverProfile';
import { MusicChoreography } from './musicMapping';
import { buildVisualScore, type VisualScore, type VisualState } from './visualScore';
import type { AudioAnalysis } from './analysis';
import type { ArtworkSettings } from './artwork';

type AudioFeatureSource = { sample: () => AudioFeatures; readonly isPlaying?: boolean };

const FIELD_SIZE = 160;
const FIXED_STEP = 1 / 60;
const MAX_PIXEL_RATIO = 1.5;
const DEFAULT_SETTINGS: ArtworkSettings = {
  movement: 1.25, speed: 1, particleSize: 2, mouseForce: 0.2,
  flowStrength: 0.8, persistence: 0.94, ribbonThickness: 1, audioInfluence: 0.7,
};
const RESTING_VISUAL: VisualState = {
  fromPalette: 0, toPalette: 0, blend: 1, direction: 0, currentScale: 1, foldScale: 1,
  swirl: 0, sweep: 0, centerX: 0.5, centerY: 0.5,
};

const fullScreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const flowFragment = /* glsl */ `
  uniform sampler2D uPrevious;
  uniform sampler2D uCoverMaps;
  uniform vec2 uPointer;
  uniform float uPointerEnergy;
  uniform float uTime;
  uniform float uDelta;
  uniform float uFlowStrength;
  uniform float uPersistence;
  uniform float uBass;
  uniform float uBeatCycle;
  uniform float uBeatAccent;
  uniform float uDownbeat;
  uniform float uFineActivity;
  uniform float uIntensity;
  uniform float uAspect;
  uniform float uCurrentAngle;
  uniform float uCurrentScale;
  uniform float uSwirl;
  uniform float uSweep;
  uniform vec2 uVortexCenter;
  varying vec2 vUv;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float total = 0.0, weight = 0.5;
    for (int i = 0; i < 3; i++) {
      total += noise(p) * weight;
      p = mat2(1.62, 1.18, -1.18, 1.62) * p + 11.7;
      weight *= 0.5;
    }
    return total;
  }
  vec2 mapUv(vec2 uv) {
    if (uAspect >= 1.0) {
      float height = 1.0 / uAspect;
      return vec2(uv.x, (uv.y - (1.0 - height) * 0.5) / height);
    }
    float width = uAspect;
    return vec2((uv.x - (1.0 - width) * 0.5) / width, uv.y);
  }

  void main() {
    vec2 uv = vUv;
    vec2 oldVelocity = texture2D(uPrevious, uv).xy;
    vec2 backUv = clamp(uv - oldVelocity * uDelta * 0.75, 0.002, 0.998);
    vec4 carried = texture2D(uPrevious, backUv);
    vec2 texel = vec2(1.0 / ${FIELD_SIZE}.0);
    vec4 neighbors = (texture2D(uPrevious, backUv + vec2(texel.x, 0.0))
      + texture2D(uPrevious, backUv - vec2(texel.x, 0.0))
      + texture2D(uPrevious, backUv + vec2(0.0, texel.y))
      + texture2D(uPrevious, backUv - vec2(0.0, texel.y))) * 0.25;
    vec2 velocity = mix(carried.xy, neighbors.xy, 0.08);

    vec2 coverUv = mapUv(uv);
    float inside = step(0.0, coverUv.x) * step(coverUv.x, 1.0) * step(0.0, coverUv.y) * step(coverUv.y, 1.0);
    coverUv = clamp(vec2(coverUv.x, 1.0 - coverUv.y), 0.0, 1.0);
    vec3 maps = texture2D(uCoverMaps, coverUv).rgb;
    float edgeGuide = maps.g * inside;
    float detailGuide = maps.b * inside;

    float time = uTime * 0.075;
    vec2 p = uv - 0.5;
    float eps = 0.004;
    float turn = uCurrentAngle;
    mat2 orientation = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));
    vec2 drift = orientation * vec2(time * 0.65, -time * 0.43);
    float scale = 3.1 * uCurrentScale;
    float px1 = fbm((p + vec2(eps, 0.0)) * scale + drift + edgeGuide * 0.2);
    float px0 = fbm((p - vec2(eps, 0.0)) * scale + drift + edgeGuide * 0.2);
    float py1 = fbm((p + vec2(0.0, eps)) * scale + drift + detailGuide * 0.15);
    float py0 = fbm((p - vec2(0.0, eps)) * scale + drift + detailGuide * 0.15);
    vec2 curl = normalize(orientation * vec2(py1 - py0, px0 - px1) + vec2(0.00001));
    float broadCycle = 0.92 + 0.32 * uBeatCycle + 0.22 * uBeatAccent;
    vec2 currentForce = curl * (0.075 * uFlowStrength * broadCycle)
      * (0.85 + uBass * 2.0 + uIntensity * 0.85)
      * (0.74 + edgeGuide * 0.48 + detailGuide * 0.20);
    currentForce += vec2(curl.y, -curl.x) * uFlowStrength
      * (0.03 * uBeatCycle + 0.075 * uDownbeat);
    currentForce += (orientation * vec2(0.018, -0.008)) * uFlowStrength * (0.65 + uIntensity);
    vec2 fromCenter = uv - uVortexCenter;
    float vortexFalloff = exp(-dot(fromCenter, fromCenter) / 0.13);
    vec2 vortex = normalize(vec2(-fromCenter.y, fromCenter.x) + vec2(0.00001));
    currentForce += vortex * vortexFalloff * (0.05 * uSwirl * uFlowStrength);
    currentForce += (orientation * vec2(1.0, 0.0)) * ((uv.y - 0.5) * 0.075 * uSweep * uFlowStrength);

    vec2 toPointer = uv - uPointer;
    float radius = exp(-dot(toPointer, toPointer) / 0.0022);
    vec2 tangent = normalize(vec2(-toPointer.y, toPointer.x) + vec2(0.00001));
    vec2 pointerForce = tangent * radius * uPointerEnergy * (0.34 * uFlowStrength);
    float damping = mix(3.8, 0.72, clamp(uPersistence, 0.0, 1.0));
    velocity = velocity * exp(-damping * uDelta) + (currentForce + pointerForce) * uDelta;
    velocity = clamp(velocity, vec2(-0.16), vec2(0.16));
    // The second pair of channels carries bounded material travel. It keeps
    // evolving after the force changes and gradually returns toward its source.
    vec2 travel = mix(carried.zw, neighbors.zw, 0.22) * exp(-0.26 * uDelta)
      + velocity * (2.4 * uDelta);
    travel = travel / max(1.0, length(travel) / 0.19);
    gl_FragColor = vec4(velocity, travel);
  }
`;

const pigmentFragment = /* glsl */ `
  uniform sampler2D uFlow;
  uniform sampler2D uCoverMaps;
  uniform vec3 uColors[${PALETTE_LIMIT}];
  uniform float uWeights[${PALETTE_LIMIT}];
  uniform int uPaletteCount;
  uniform int uDominantCount;
  uniform float uAspect;
  uniform float uTime;
  uniform float uFlowStrength;
  uniform float uBass;
  uniform float uBeatCycle;
  uniform float uBeatAccent;
  uniform float uDownbeat;
  uniform float uFineActivity;
  uniform float uIntensity;
  uniform float uFoldAngle;
  uniform float uFoldScale;
  varying vec2 vUv;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float total = 0.0, weight = 0.5;
    for (int i = 0; i < 4; i++) {
      total += noise(p) * weight;
      p = mat2(1.62, 1.18, -1.18, 1.62) * p + 11.7;
      weight *= 0.5;
    }
    return total;
  }
  vec2 mapUv(vec2 uv) {
    if (uAspect >= 1.0) {
      float height = 1.0 / uAspect;
      return vec2(uv.x, (uv.y - (1.0 - height) * 0.5) / height);
    }
    float width = uAspect;
    return vec2((uv.x - (1.0 - width) * 0.5) / width, uv.y);
  }
  vec3 paletteAt(float selector) {
    float weights[${PALETTE_LIMIT}];
    float total = 0.0;
    for (int i = 0; i < ${PALETTE_LIMIT}; i++) {
      weights[i] = i < uDominantCount ? max(uWeights[i], 0.006) : 0.0;
      total += weights[i];
    }
    float cursor = 0.0;
    vec3 color = vec3(0.0);
    for (int i = 0; i < ${PALETTE_LIMIT}; i++) {
      if (i < uDominantCount) {
        float next = cursor + weights[i] / total;
        float entering = smoothstep(cursor - 0.012, cursor + 0.012, selector);
        float leaving = 1.0 - smoothstep(next - 0.012, next + 0.012, selector);
        color += uColors[i] * entering * leaving;
        cursor = next;
      }
    }
    return color;
  }

  void main() {
    vec2 uv = vUv;
    vec4 field = texture2D(uFlow, uv);
    vec2 flow = field.xy;
    vec2 travel = field.zw;
    vec2 direction = flow / max(length(flow), 0.009);
    vec2 tangent = vec2(-direction.y, direction.x);
    vec2 musicWarp = direction * (0.034 * uBeatCycle + 0.014 * uBeatAccent)
      + tangent * (0.026 * uDownbeat + 0.012 * uBass);
    vec2 materialUv = uv - travel * (0.9 + 0.25 * uFlowStrength)
      * (1.0 + 0.65 * uIntensity) - musicWarp;
    vec2 coverUv = mapUv(materialUv);
    float inside = step(0.0, coverUv.x) * step(coverUv.x, 1.0) * step(0.0, coverUv.y) * step(coverUv.y, 1.0);
    coverUv = clamp(vec2(coverUv.x, 1.0 - coverUv.y), 0.0, 1.0);
    vec3 maps = texture2D(uCoverMaps, coverUv).rgb;
    float luminanceGuide = mix(0.52, maps.r, inside);
    float edgeGuide = maps.g * inside;
    float detailGuide = maps.b * inside;

    float t = uTime;
    vec2 current = materialUv + flow * 0.24;
    mat2 foldOrientation = mat2(cos(uFoldAngle), sin(uFoldAngle), -sin(uFoldAngle), cos(uFoldAngle));
    vec2 pattern = foldOrientation * (current - 0.5) + 0.5;
    float broad = fbm(pattern * (2.4 * uFoldScale) + vec2(t * 0.040, -t * 0.027));
    float fold = fbm(pattern * (5.3 * uFoldScale) + flow * 1.3 + vec2(-t * 0.057, t * 0.042));
    float fine = noise(pattern * (12.0 + uFineActivity * 3.2) + flow * 3.8 + t * 0.035);
    vec2 warp = vec2(broad - 0.45, fold - 0.45) * (0.075 + 0.035 * uFlowStrength)
      * (1.0 + 0.55 * uIntensity)
      + vec2(fold - 0.45, 0.45 - broad) * uDownbeat * 0.025;
    vec2 sculpted = materialUv + warp
      + tangent * (fine - 0.5) * (0.008 * uFineActivity);

    float largeShape = broad;
    float midShape = fold;
    float colorField = noise(sculpted * 3.7 + vec2(fold - 0.45, broad - 0.45) * 1.4);
    float selector = smoothstep(0.24, 0.76, colorField
      + (luminanceGuide - 0.5) * 0.17 + edgeGuide * 0.045 + detailGuide * 0.025);
    vec3 pigment = paletteAt(selector);

    float ridge = 1.0 - abs(midShape * 2.0 - 1.0);
    float broadFold = 1.0 - abs(largeShape * 2.0 - 1.0);
    // Accent colors form sparse painted flecks along the same moving folds.
    for (int i = 0; i < ${PALETTE_LIMIT}; i++) {
      if (i >= uDominantCount && i < uPaletteCount) {
        float accent = noise(sculpted * 13.0 + vec2(float(i) * 13.7, float(i) * 5.3));
        float coverage = smoothstep(0.84, 0.95, accent)
          * (0.18 + detailGuide * 0.82) * (0.55 + ridge * 0.45);
        pigment = mix(pigment, uColors[i], min(1.0, coverage * 1.25));
      }
    }
    float slope = length(vec2(dFdx(ridge), dFdy(ridge)));
    float roughness = (fine - 0.5) * (0.025 + detailGuide * 0.035 + uFineActivity * 0.012);
    float shade = clamp(0.78 + ridge * 0.17 + broadFold * 0.08 + edgeGuide * 0.035 - slope * 0.12 + roughness, 0.62, 1.06);
    shade *= 0.96 + 0.06 * uIntensity + 0.018 * uBeatAccent + 0.01 * uBass;
    gl_FragColor = vec4(pigment * shade, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const ribbonVertex = /* glsl */ `
  uniform sampler2D uFlow;
  uniform vec3 uColors[${PALETTE_LIMIT}];
  uniform float uRibbonThickness;
  uniform float uIntensity;
  uniform float uFineActivity;
  uniform float uDownbeat;
  uniform float uBeatCycle;
  uniform float uBeatAccent;
  attribute vec2 aSeed;
  attribute float aTrail;
  attribute float aSide;
  attribute float aColorIndex;
  varying vec3 vColor;
  varying float vAlpha;

  vec2 pathPoint(vec2 seed, float age) {
    vec4 seedFlow = texture2D(uFlow, seed);
    vec2 direction = seedFlow.xy / max(length(seedFlow.xy), 0.009);
    vec2 p = clamp(seed + seedFlow.zw * 0.9
      + direction * (0.028 * uBeatCycle + 0.012 * uBeatAccent), 0.015, 0.985);
    float steps = age * 12.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= steps) break;
      vec2 velocity = texture2D(uFlow, clamp(p, 0.002, 0.998)).xy;
      vec2 around = p - 0.5;
      vec2 fallback = normalize(vec2(-around.y, around.x) + vec2(0.00001));
      vec2 direction = length(velocity) > 0.0008 ? normalize(velocity) : fallback;
      p += direction * 0.0072 * min(1.0, steps - float(i));
    }
    return clamp(p, 0.015, 0.985);
  }

  void main() {
    vec2 point = pathPoint(aSeed, aTrail);
    vec2 velocity = texture2D(uFlow, point).xy;
    vec2 around = point - 0.5;
    vec2 direction = length(velocity) > 0.0008 ? normalize(velocity) : normalize(vec2(-around.y, around.x) + vec2(0.00001));
    vec2 normal = vec2(-direction.y, direction.x);
    float width = (0.0015 + 0.0004 * aSeed.x) * uRibbonThickness
      * (1.0 + uDownbeat * 0.32 + uBeatAccent * 0.12);
    point += normal * aSide * width;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point * 2.0 - 1.0, 0.02, 1.0);
    int colorIndex = int(aColorIndex + 0.5);
    vColor = uColors[0];
    for (int i = 0; i < ${PALETTE_LIMIT}; i++) if (i == colorIndex) vColor = uColors[i];
    float ends = smoothstep(0.0, 0.08, aTrail) * (1.0 - smoothstep(0.86, 1.0, aTrail));
    vAlpha = ends * (0.34 + uIntensity * 0.12 + uFineActivity * 0.08
      + uDownbeat * 0.08 + uBeatAccent * 0.06);
  }
`;

const ribbonFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createMapTexture(profile: CoverVisualProfile) {
  const data = new Uint8Array(profile.width * profile.height * 4);
  for (let i = 0; i < profile.luminance.length; i += 1) {
    const offset = i * 4;
    data[offset] = profile.luminance[i];
    data[offset + 1] = profile.edges[i];
    data[offset + 2] = profile.detail[i];
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, profile.width, profile.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function paletteUniforms(profile: CoverVisualProfile) {
  const colors = Array.from({ length: PALETTE_LIMIT }, (_, index) => {
    const color = new THREE.Color(profile.palette[index % profile.palette.length] ?? '#777777');
    return new THREE.Vector3(color.r, color.g, color.b);
  });
  const weights = new Float32Array(PALETTE_LIMIT);
  for (let i = 0; i < PALETTE_LIMIT; i += 1) weights[i] = profile.proportions[i] ?? 0;
  return { colors, weights };
}

function seedRibbons(profile: CoverVisualProfile, ribbonCount: number, pointsPerRibbon: number) {
  const vertexCount = ribbonCount * pointsPerRibbon * 2;
  const seeds = new Float32Array(vertexCount * 2);
  const trails = new Float32Array(vertexCount);
  const sides = new Float32Array(vertexCount);
  const paletteIndices = new Float32Array(vertexCount);
  const indices: number[] = [];
  let randomState = 0x5f3759df;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const cumulative = profile.proportions.map((_, index) => profile.proportions.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
  for (let ribbon = 0; ribbon < ribbonCount; ribbon += 1) {
    let bestX = 0.5, bestY = 0.5, bestScore = -1;
    for (let attempt = 0; attempt < 28; attempt += 1) {
      const x = Math.floor(random() * profile.width);
      const y = Math.floor(random() * profile.height);
      const mapIndex = y * profile.width + x;
      const density = profile.edges[mapIndex] / 255 * 0.6 + profile.detail[mapIndex] / 255 * 0.4;
      const score = density * 0.55 + random() * 0.45;
      if (score > bestScore) { bestScore = score; bestX = x; bestY = y; }
    }
    const seedX = (bestX + 0.5) / profile.width;
    const seedY = 1 - (bestY + 0.5) / profile.height;
    const choice = random();
    const colorIndex = ribbon < profile.palette.length ? ribbon
      : Math.max(0, cumulative.findIndex((value) => choice <= value));
    for (let point = 0; point < pointsPerRibbon; point += 1) {
      const age = point / (pointsPerRibbon - 1);
      const first = (ribbon * pointsPerRibbon + point) * 2;
      for (let side = 0; side < 2; side += 1) {
        const vertex = first + side;
        seeds[vertex * 2] = seedX;
        seeds[vertex * 2 + 1] = seedY;
        trails[vertex] = age;
        sides[vertex] = side === 0 ? -1 : 1;
        paletteIndices[vertex] = colorIndex;
      }
      if (point < pointsPerRibbon - 1) {
        const a = first, b = first + 1, c = first + 2, d = first + 3;
        indices.push(a, c, b, b, c, d);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2));
  geometry.setAttribute('aTrail', new THREE.BufferAttribute(trails, 1));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  geometry.setAttribute('aColorIndex', new THREE.BufferAttribute(paletteIndices, 1));
  geometry.setIndex(indices);
  return geometry;
}

export class FlowStudyArtwork {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5);
  private flowScene = new THREE.Scene();
  private flowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5);
  private mapTexture: THREE.DataTexture;
  private flowTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private flowMaterial: THREE.ShaderMaterial;
  private pigmentMaterial: THREE.ShaderMaterial;
  private ribbonMaterial: THREE.ShaderMaterial;
  private mapAspect: number;
  private raf = 0;
  private previousTime = 0;
  private elapsed = 0;
  private accumulator = 0;
  private pointer = new THREE.Vector2(-2, -2);
  private pointerActivity = 0;
  private paused = false;
  private disposed = false;
  private settings: ArtworkSettings;
  private audioFeatures: AudioFeatures = {
    bass: 0, mid: 0, high: 0, beat: 0, beatAge: 10,
    beatPulse: 0, downbeatPulse: 0, beatPhase: 0,
    rms: 0, brightness: 0, onsetStrength: 0, playbackTime: 0, analysisMapped: false,
  };
  private audioSource?: AudioFeatureSource;
  private music = new MusicChoreography();
  private musicState: ReturnType<MusicChoreography['update']> = {
    bassForce: 0, beatCycle: 0, beatAccent: 0, downbeatAccent: 0,
    fineActivity: 0, intensity: 0,
  };
  private visualScore: VisualScore | null = null;
  private visualState: VisualState = RESTING_VISUAL;
  private baseColors: THREE.Vector3[];
  private liveColors: THREE.Vector3[];
  private writeIndex = 0;
  private resizeObserver: ResizeObserver;
  private boundPointer: (event: PointerEvent) => void;
  private readonly onResize = () => this.resize();

  constructor(private host: HTMLElement, private profile: CoverVisualProfile, settings = DEFAULT_SETTINGS) {
    this.settings = { ...settings };
    this.mapAspect = profile.aspect;
    this.mapTexture = createMapTexture(profile);
    const { colors, weights } = paletteUniforms(profile);
    this.baseColors = colors.map((color) => color.clone());
    this.liveColors = colors;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.camera.position.z = 3;
    this.flowCamera.position.z = 3;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0xeee9d8);
    this.renderer.domElement.setAttribute('aria-label', 'Flow Study flowing pigment and ribbons based on the selected cover');
    this.host.appendChild(this.renderer.domElement);

    const targetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.flowTargets = [
      new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, targetOptions),
      new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, targetOptions),
    ];
    this.flowTargets.forEach((target) => {
      this.renderer.setRenderTarget(target);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, false, false);
    });
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0xeee9d8, 1);

    const simUniforms = {
      uPrevious: { value: this.flowTargets[0].texture }, uCoverMaps: { value: this.mapTexture },
      uPointer: { value: this.pointer }, uPointerEnergy: { value: 0 }, uTime: { value: 0 }, uDelta: { value: FIXED_STEP },
      uFlowStrength: { value: settings.flowStrength }, uPersistence: { value: settings.persistence },
      uBass: { value: 0 }, uBeatCycle: { value: 0 }, uBeatAccent: { value: 0 }, uDownbeat: { value: 0 },
      uFineActivity: { value: 0 }, uIntensity: { value: 0 }, uAspect: { value: this.mapAspect },
      uCurrentAngle: { value: 0 }, uCurrentScale: { value: 1 },
      uSwirl: { value: 0 }, uSweep: { value: 0 }, uVortexCenter: { value: new THREE.Vector2(0.5, 0.5) },
    };
    this.flowMaterial = new THREE.ShaderMaterial({ uniforms: simUniforms, vertexShader: fullScreenVertex, fragmentShader: flowFragment });
    this.flowScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flowMaterial));

    const visualUniforms = {
      uFlow: { value: this.flowTargets[0].texture }, uCoverMaps: { value: this.mapTexture },
      uColors: { value: colors }, uWeights: { value: weights }, uPaletteCount: { value: profile.palette.length },
      uDominantCount: { value: profile.dominantCount },
      uAspect: { value: this.mapAspect }, uTime: { value: 0 }, uFlowStrength: { value: settings.flowStrength },
      uBass: { value: 0 }, uBeatCycle: { value: 0 }, uBeatAccent: { value: 0 }, uDownbeat: { value: 0 },
      uFineActivity: { value: 0 }, uIntensity: { value: 0 },
      uFoldAngle: { value: 0 }, uFoldScale: { value: 1 },
    };
    this.pigmentMaterial = new THREE.ShaderMaterial({
      uniforms: visualUniforms, vertexShader: fullScreenVertex, fragmentShader: pigmentFragment,
      depthTest: false, depthWrite: false,
    });
    const pigment = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pigmentMaterial);
    this.scene.add(pigment);

    const ribbonGeometry = seedRibbons(profile, 34, 64);
    this.ribbonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uFlow: { value: this.flowTargets[0].texture }, uColors: { value: colors },
        uRibbonThickness: { value: settings.ribbonThickness }, uIntensity: { value: 0 },
        uFineActivity: { value: 0 }, uDownbeat: { value: 0 },
        uBeatCycle: { value: 0 }, uBeatAccent: { value: 0 },
      },
      vertexShader: ribbonVertex, fragmentShader: ribbonFragment, transparent: true,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.scene.add(new THREE.Mesh(ribbonGeometry, this.ribbonMaterial));

    this.boundPointer = (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height);
      this.pointerActivity = 1;
    };
    this.renderer.domElement.addEventListener('pointermove', this.boundPointer);
    window.addEventListener('resize', this.onResize);
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(host);
    this.resize();
  }

  async load() {
    this.previousTime = performance.now();
    this.raf = requestAnimationFrame(this.animate);
  }

  setAudioSource(source?: AudioFeatureSource) { this.audioSource = source; }

  setAnalysis(analysis: AudioAnalysis | null) {
    this.visualScore = analysis ? buildVisualScore(analysis, this.profile) : null;
    this.applyVisualScore(RESTING_VISUAL);
  }

  private applyVisualScore(state: VisualState) {
    this.visualState = state;
    const from = this.visualScore?.palettes[state.fromPalette];
    const to = this.visualScore?.palettes[state.toPalette];
    for (let slot = 0; slot < this.liveColors.length; slot += 1) {
      const first = this.baseColors[from?.[slot] ?? slot];
      const last = this.baseColors[to?.[slot] ?? slot];
      this.liveColors[slot].copy(first).lerp(last, state.blend);
    }
    this.pigmentMaterial.uniforms.uFoldAngle.value = state.direction * 0.82;
    this.pigmentMaterial.uniforms.uFoldScale.value = state.foldScale;
  }

  setSettings(settings: ArtworkSettings) {
    this.settings = { ...settings };
    this.flowMaterial.uniforms.uFlowStrength.value = settings.flowStrength;
    this.flowMaterial.uniforms.uPersistence.value = settings.persistence;
    this.pigmentMaterial.uniforms.uFlowStrength.value = settings.flowStrength;
    this.ribbonMaterial.uniforms.uRibbonThickness.value = settings.ribbonThickness;
  }

  setPaused(paused: boolean) { this.paused = paused; }

  private canvasSize() { return Math.max(1, Math.min(this.host.clientWidth, this.host.clientHeight)); }

  private resize() {
    const size = this.canvasSize();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(size, size);
    this.camera.left = -1; this.camera.right = 1; this.camera.top = 1; this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
  }

  private stepFlow(dt: number, music: ReturnType<MusicChoreography['update']>) {
    const source = this.flowTargets[this.writeIndex];
    const destination = this.flowTargets[1 - this.writeIndex];
    const uniforms = this.flowMaterial.uniforms;
    uniforms.uPrevious.value = source.texture;
    uniforms.uPointerEnergy.value = this.pointerActivity;
    uniforms.uTime.value = this.elapsed;
    uniforms.uDelta.value = dt;
    uniforms.uBass.value = music.bassForce;
    uniforms.uBeatCycle.value = music.beatCycle;
    uniforms.uBeatAccent.value = music.beatAccent;
    uniforms.uDownbeat.value = music.downbeatAccent;
    uniforms.uFineActivity.value = music.fineActivity;
    uniforms.uIntensity.value = music.intensity;
    uniforms.uCurrentAngle.value = this.visualState.direction;
    uniforms.uCurrentScale.value = this.visualState.currentScale;
    uniforms.uSwirl.value = this.visualState.swirl;
    uniforms.uSweep.value = this.visualState.sweep;
    uniforms.uVortexCenter.value.set(this.visualState.centerX, this.visualState.centerY);
    this.renderer.setRenderTarget(destination);
    this.renderer.render(this.flowScene, this.flowCamera);
    this.renderer.setRenderTarget(null);
    this.writeIndex = 1 - this.writeIndex;
  }

  private animate = (now: number) => {
    this.raf = requestAnimationFrame(this.animate);
    const frameDelta = Math.min((now - this.previousTime) / 1000 || 0, 0.05);
    this.previousTime = now;
    if (!this.paused) {
      this.elapsed += frameDelta;
      this.accumulator = Math.min(0.08, this.accumulator + frameDelta);
      if (this.audioSource) this.audioFeatures = this.audioSource.sample();
      const mapped = this.audioFeatures.analysisMapped && this.audioSource?.isPlaying === true;
      this.musicState = this.music.update(this.audioFeatures, frameDelta, mapped, this.settings.audioInfluence);
      this.applyVisualScore(this.visualScore && this.audioFeatures.analysisMapped
        ? this.visualScore.sample(this.audioFeatures.playbackTime) : RESTING_VISUAL);
      this.pointerActivity *= Math.exp(-frameDelta * 1.8);
      while (this.accumulator >= FIXED_STEP) {
        this.stepFlow(FIXED_STEP, this.musicState);
        this.accumulator -= FIXED_STEP;
      }
    } else if (this.audioSource) {
      this.audioSource.sample();
    }

    const flowTexture = this.flowTargets[this.writeIndex].texture;
    this.pigmentMaterial.uniforms.uFlow.value = flowTexture;
    this.pigmentMaterial.uniforms.uTime.value = this.elapsed;
    this.ribbonMaterial.uniforms.uFlow.value = flowTexture;
    this.pigmentMaterial.uniforms.uBass.value = this.musicState.bassForce;
    this.pigmentMaterial.uniforms.uBeatCycle.value = this.musicState.beatCycle;
    this.pigmentMaterial.uniforms.uBeatAccent.value = this.musicState.beatAccent;
    this.pigmentMaterial.uniforms.uDownbeat.value = this.musicState.downbeatAccent;
    this.pigmentMaterial.uniforms.uFineActivity.value = this.musicState.fineActivity;
    this.pigmentMaterial.uniforms.uIntensity.value = this.musicState.intensity;
    this.ribbonMaterial.uniforms.uIntensity.value = this.musicState.intensity;
    this.ribbonMaterial.uniforms.uFineActivity.value = this.musicState.fineActivity;
    this.ribbonMaterial.uniforms.uDownbeat.value = this.musicState.downbeatAccent;
    this.ribbonMaterial.uniforms.uBeatCycle.value = this.musicState.beatCycle;
    this.ribbonMaterial.uniforms.uBeatAccent.value = this.musicState.beatAccent;
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointermove', this.boundPointer);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      }
    });
    this.flowScene.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
    });
    this.flowTargets.forEach((target) => target.dispose());
    this.mapTexture.dispose();
    this.flowMaterial.dispose();
    this.pigmentMaterial.dispose();
    this.ribbonMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
