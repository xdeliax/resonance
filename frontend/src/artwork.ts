import * as THREE from 'three';

export type ArtworkSettings = {
  movement: number;
  speed: number;
  particleSize: number;
  mouseForce: number;
};

const PARTICLE_COUNT = 150_000;
const REFERENCE_CANVAS_SIZE = 400;
const MAX_PIXEL_RATIO = 1.5;

const particleVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uMovement;
  uniform float uParticleSize;
  uniform float uPixelRatio;
  uniform float uCanvasScale;
  uniform vec2 uPointer;
  uniform float uPointerAge;
  uniform float uPointerEnergy;
  uniform float uMouseForce;

  attribute vec2 aOrigin;
  attribute vec3 aColor;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec2 vortex(vec2 p, vec2 center, float radius) {
    vec2 radial = p - center;
    float falloff = exp(-dot(radial, radial) / (radius * radius));
    return vec2(-radial.y, radial.x) * falloff;
  }

  void main() {
    vec2 origin = aOrigin;
    float t = uTime * uSpeed;

    // Overlapping, differently paced vortices create broad currents that ease
    // the image apart and bring its marks back around their sampled origins.
    vec2 current = vortex(origin, vec2(-0.40, 0.15), 0.82) * sin(t * 0.78 + 0.25);
    current += vortex(origin, vec2(0.34, -0.20), 0.68) * sin(t * 0.53 + 2.1);
    current += vortex(origin, vec2(0.06, 0.50), 0.56) * cos(t * 0.37 + 0.8);

    // A softer, finer drift rides on top of the main currents.
    vec2 drift = vec2(t * 0.28, -t * 0.19);
    float rippleA = noise(origin * 7.0 + drift + aSeed * 0.3);
    float rippleB = noise(origin * 7.0 - drift.yx + 14.0 + aSeed * 0.3);
    vec2 fineFlow = vec2(rippleA - 0.5, rippleB - 0.5) * 0.13;

    vec2 position = origin + (current * 0.34 + fineFlow) * uMovement;

    vec2 fromPointer = position - uPointer;
    float pointerDistance = length(fromPointer);
    float reach = exp(-pointerDistance * 3.4);
    float pulse = uPointerEnergy * exp(-uPointerAge * 1.65);
    vec2 radial = normalize(fromPointer + vec2(0.00001));
    vec2 tangent = vec2(-radial.y, radial.x);
    position += (radial * 0.78 + tangent * 0.48) * reach * pulse * uMouseForce;

    vec4 viewPosition = modelViewMatrix * vec4(position, 0.0, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    // particleSize is specified in CSS pixels at the reference canvas size.
    // Convert to drawing-buffer pixels once, using DPR exactly once.
    gl_PointSize = uParticleSize * uCanvasScale * uPixelRatio * (0.88 + 0.24 * sin(t * 0.7 + aSeed * 6.2831));
    vColor = pow(aColor, vec3(2.2));
    vAlpha = 0.88 + 0.12 * sin(t * 0.55 + aSeed * 6.2831);
  }
`;

const particleFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float edge = length(gl_PointCoord - vec2(0.5));
    float coverage = 1.0 - smoothstep(0.34, 0.50, edge);
    if (coverage < 0.025) discard;
    gl_FragColor = vec4(vColor, vAlpha * coverage);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function sampleCover(image: HTMLImageElement, count: number) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not sample the cover image.');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const origins = new Float32Array(count * 2);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const randomAt = (value: number) => {
    const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
    return raw - Math.floor(raw);
  };

  for (let i = 0; i < count; i += 1) {
    // Jittered stratification keeps the cover dense and even while sampling
    // every particle's exact source location and painted color.
    const columns = Math.ceil(Math.sqrt(count));
    const row = Math.floor(i / columns);
    const column = i % columns;
    const x = Math.min(canvas.width - 1, Math.floor((column + randomAt(i + 1)) / columns * canvas.width));
    const y = Math.min(canvas.height - 1, Math.floor((row + randomAt(i + 17)) / Math.ceil(count / columns) * canvas.height));
    const pixel = (y * canvas.width + x) * 4;
    origins[i * 2] = (x / (canvas.width - 1) - 0.5) * 2;
    origins[i * 2 + 1] = (0.5 - y / (canvas.height - 1)) * 2;
    positions[i * 3] = origins[i * 2];
    positions[i * 3 + 1] = origins[i * 2 + 1];
    colors[i * 3] = pixels[pixel] / 255;
    colors[i * 3 + 1] = pixels[pixel + 1] / 255;
    colors[i * 3 + 2] = pixels[pixel + 2] / 255;
    seeds[i] = randomAt(i + 31);
  }
  return { origins, positions, colors, seeds };
}

const defaults: ArtworkSettings = { movement: 1.25, speed: 1, particleSize: 2, mouseForce: 0.20 };

export class Artwork {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private material?: THREE.ShaderMaterial;
  private texture?: THREE.Texture;
  private raf = 0;
  private elapsed = 0;
  private previousTime = 0;
  private pointer = new THREE.Vector2(5, 5);
  private pointerAge = 100;
  private pointerEnergy = 0;
  private pointerEnergyTarget = 0;
  private settings = { ...defaults };
  private paused = false;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private boundPointer: (event: PointerEvent) => void;
  private readonly onResize = () => this.resize();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0xeee9d8);
    this.renderer.domElement.setAttribute('aria-label', 'Flowing cover artwork made from sampled particles');
    this.host.appendChild(this.renderer.domElement);
    this.camera.position.z = 3;

    this.boundPointer = (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((event.clientX - rect.left) / rect.width - 0.5) * 2, (0.5 - (event.clientY - rect.top) / rect.height) * 2);
      this.pointerAge = 0;
      this.pointerEnergy = Math.min(1, this.pointerEnergy + 0.42);
      this.pointerEnergyTarget = 1;
    };
    this.renderer.domElement.addEventListener('pointermove', this.boundPointer);
    this.renderer.domElement.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('resize', this.onResize);
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(host);
    this.resize();
  }

  async load() {
    const texture = await new THREE.TextureLoader().loadAsync('/assets/cover1.jpeg');
    if (this.disposed) { texture.dispose(); return; }
    this.texture = texture;
    const image = texture.image as HTMLImageElement;
    const { origins, positions, colors, seeds } = sampleCover(image, PARTICLE_COUNT);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 2));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const uniforms = {
      uTime: { value: 0 },
      uSpeed: { value: this.settings.speed },
      uMovement: { value: this.settings.movement },
      uParticleSize: { value: this.settings.particleSize },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
      uCanvasScale: { value: this.canvasSize() / REFERENCE_CANVAS_SIZE },
      uPointer: { value: this.pointer },
      uPointerAge: { value: this.pointerAge },
      uPointerEnergy: { value: 0 },
      uMouseForce: { value: this.settings.mouseForce },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Points(geometry, this.material));

    // Keep only a whisper of the original image beneath the moving marks.
    texture.colorSpace = THREE.SRGBColorSpace;
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.035, depthWrite: false }),
    );
    background.position.z = -0.02;
    this.scene.add(background);

    this.resize();
    this.previousTime = performance.now();
    this.animate(this.previousTime);
  }

  setSettings(settings: ArtworkSettings) {
    this.settings = { ...settings };
    if (!this.material) return;
    this.material.uniforms.uMovement.value = settings.movement;
    this.material.uniforms.uSpeed.value = settings.speed;
    this.material.uniforms.uParticleSize.value = settings.particleSize;
    this.material.uniforms.uMouseForce.value = settings.mouseForce;
  }

  private handlePointerLeave = () => { this.pointerEnergyTarget = 0; };

  private canvasSize() {
    return Math.max(1, Math.min(this.host.clientWidth, this.host.clientHeight));
  }

  private resize() {
    const size = this.canvasSize();
    const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(size, size);
    this.camera.left = -1;
    this.camera.right = 1;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    if (this.material) {
      this.material.uniforms.uCanvasScale.value = size / REFERENCE_CANVAS_SIZE;
      this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    }
  }

  private animate = (now: number) => {
    this.raf = requestAnimationFrame(this.animate);
    const delta = Math.min((now - this.previousTime) / 1000 || 0, 0.05);
    this.previousTime = now;
    if (!this.paused) {
      this.elapsed += delta;
      this.pointerAge += delta;
      this.pointerEnergy += (this.pointerEnergyTarget - this.pointerEnergy) * (1 - Math.exp(-delta * 2.6));
    }
    if (this.material) {
      this.material.uniforms.uTime.value = this.elapsed;
      this.material.uniforms.uPointerAge.value = this.pointerAge;
      this.material.uniforms.uPointerEnergy.value = this.pointerEnergy;
    }
    this.renderer.render(this.scene, this.camera);
  };

  setPaused(paused: boolean) { this.paused = paused; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointermove', this.boundPointer);
    this.renderer.domElement.removeEventListener('pointerleave', this.handlePointerLeave);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        if (object instanceof THREE.Mesh) {
          const material = object.material as THREE.Material;
          material.dispose();
        }
      }
    });
    this.texture?.dispose();
    this.material?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
