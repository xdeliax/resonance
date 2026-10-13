import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Artwork, type ArtworkSettings } from './artwork';

const initialSettings: ArtworkSettings = { movement: 1.25, speed: 1, particleSize: 2, mouseForce: 0.2 };

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const artworkRef = useRef<Artwork | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    let cancelled = false;
    let artwork: Artwork;
    try {
      artwork = new Artwork(host);
      artworkRef.current = artwork;
      artwork.load().catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'The artwork could not be loaded.');
          artwork.dispose();
          artworkRef.current = null;
        }
      });
    } catch {
      setError('WebGL could not start in this browser. Please try a browser with hardware acceleration enabled.');
    }
    return () => {
      cancelled = true;
      artwork?.dispose();
      artworkRef.current = null;
    };
  }, []);

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    artworkRef.current?.setPaused(next);
  };

  const updateSetting = (key: keyof ArtworkSettings, value: number) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    artworkRef.current?.setSettings(next);
  };

  return (
    <main className="page-shell">
      <header className="topline">
        <div className="wordmark" aria-label="Resonance"><span className="mark">R</span><span>RESONANCE</span></div>
        <div className="study-label">VISUAL STUDY <span>01</span></div>
      </header>
      <section className="stage" aria-label="Track artwork">
        <div className="track-meta">
          <p className="track-kicker">NOW PLAYING</p>
          <h1>The Adults Are Talking</h1>
          <p className="track-artist">The Strokes</p>
        </div>
        <div className="art-frame" aria-label="Procedural visual artwork">
          <div className="canvas-mount" ref={mountRef} />
          {error && <div className="fallback" role="alert"><span className="fallback-mark">R</span><p>{error}</p></div>}
          <details className="tuning">
            <summary>MOVE / TUNE</summary>
            <div className="tuning-controls">
              <label>Movement <output>{settings.movement.toFixed(2)}</output>
                <input type="range" min="0.35" max="2.4" step="0.05" value={settings.movement} onChange={(event) => updateSetting('movement', Number(event.target.value))} />
              </label>
              <label>Speed <output>{settings.speed.toFixed(2)}</output>
                <input type="range" min="0.3" max="2.2" step="0.05" value={settings.speed} onChange={(event) => updateSetting('speed', Number(event.target.value))} />
              </label>
              <label>Particle size <output>{settings.particleSize.toFixed(2)}</output>
                <input type="range" min="0.65" max="2.8" step="0.05" value={settings.particleSize} onChange={(event) => updateSetting('particleSize', Number(event.target.value))} />
              </label>
              <label>Mouse force <output>{settings.mouseForce.toFixed(2)}</output>
                <input type="range" min="0" max="0.55" step="0.01" value={settings.mouseForce} onChange={(event) => updateSetting('mouseForce', Number(event.target.value))} />
              </label>
            </div>
          </details>
        </div>
        <figure className="cover-thumb">
          <img src="/assets/cover1.jpeg" alt="Original cover artwork" />
        </figure>
      </section>
      <footer className="bottomline">
        <p className="caption">A STUDY IN MOTION <span>·</span> PROCEDURAL / MOUSE-DRIVEN</p>
        <button className="pause-control" onClick={togglePause} aria-label={paused ? 'Resume animation' : 'Pause animation'}>
          {paused ? <Play size={12} strokeWidth={1.8} /> : <Pause size={12} strokeWidth={1.8} />}
          <span>{paused ? 'RESUME' : 'PAUSE'}</span>
        </button>
      </footer>
    </main>
  );
}
