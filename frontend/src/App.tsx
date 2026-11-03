import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { Artwork, type ArtworkSettings } from './artwork';
import { LocalAudioTrack, type AudioFeatures } from './audio';
import { validateMatchingAnalysis, type AudioAnalysis } from './analysis';
import { analyzeCover, type CoverVisualProfile } from './coverProfile';
import { CoverProfilePreview } from './CoverProfilePreview';
import { FlowStudyArtwork } from './flowStudy';
import { LandingPage, type LibraryTrack } from './LandingPage';
import './landing.css';

const initialSettings: ArtworkSettings = { movement: 1.25, speed: 1, particleSize: 2, mouseForce: 0.2, flowStrength: 0.8, persistence: 0.94, ribbonThickness: 1, audioInfluence: 0.7 };

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const audioElementRef = useRef<HTMLAudioElement>(null);
  const artworkRef = useRef<Artwork | FlowStudyArtwork | null>(null);
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [audioArtist, setAudioArtist] = useState('The Strokes');
  const [page, setPage] = useState<'landing' | 'artwork'>(() =>
    window.location.pathname.replace(/\/$/, '') === '/canvas' ? 'artwork' : 'landing');
  const [loadingTrack, setLoadingTrack] = useState(false);
  const [coverUrl, setCoverUrl] = useState('/assets/cover1.jpeg');
  const [coverName, setCoverName] = useState('ORIGINAL COVER');
  const [coverProfile, setCoverProfile] = useState<CoverVisualProfile | null>(null);
  const [mode, setMode] = useState<'flow' | 'particles'>('flow');
  const audioFileRef = useRef<File | null>(null);
  const analysisPromiseRef = useRef<Promise<boolean> | null>(null);
  const selectionIdRef = useRef(0);
  const libraryAbortRef = useRef<AbortController | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [audioFeatures, setAudioFeatures] = useState<AudioFeatures>({
    bass: 0, mid: 0, high: 0, beat: 0, beatAge: 10,
    beatPulse: 0, downbeatPulse: 0, beatPhase: 0,
    rms: 0, brightness: 0, onsetStrength: 0, playbackTime: 0, analysisMapped: false,
  });
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [settings, setSettings] = useState(initialSettings);
  const coverUrlRef = useRef('/assets/cover1.jpeg');

  useEffect(() => {
    const audioElement = audioElementRef.current;
    if (!audioElement) return;
    const audioTrack = new LocalAudioTrack(audioElement, setAudioFeatures);
    audioTrackRef.current = audioTrack;
    return () => {
      audioTrack.dispose();
      audioTrackRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCoverProfile(null);
    analyzeCover(coverUrl).then((profile) => {
      if (!cancelled) setCoverProfile(profile);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'The cover could not be analyzed.');
    });
    return () => { cancelled = true; };
  }, [coverUrl]);

  const profileForRenderer = mode === 'flow' && coverProfile?.source === coverUrl ? coverProfile : null;
  useEffect(() => {
    const host = mountRef.current;
    if (page !== 'artwork' || !host || (mode === 'flow' && !profileForRenderer)) return;
    let cancelled = false;
    let artwork: Artwork | FlowStudyArtwork | null = null;
    try {
      const created = mode === 'flow'
        ? new FlowStudyArtwork(host, profileForRenderer!, settings)
        : new Artwork(host, coverUrl);
      artwork = created;
      artworkRef.current = created;
      created.setAudioSource(audioTrackRef.current ?? undefined);
      created.setSettings(settings);
      created.setPaused(paused);
      created.load().catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'The artwork could not be loaded.');
          created.dispose();
          artworkRef.current = null;
        }
      });
    } catch {
      setError('WebGL could not start in this browser. Please try a browser with hardware acceleration enabled.');
    }
    return () => {
      cancelled = true;
      artwork?.dispose();
      if (artworkRef.current === artwork) artworkRef.current = null;
    };
  }, [mode, coverUrl, profileForRenderer, page]);

  useEffect(() => { artworkRef.current?.setSettings(settings); }, [settings]);
  useEffect(() => { artworkRef.current?.setPaused(paused); }, [paused]);
  useEffect(() => {
    if (artworkRef.current instanceof FlowStudyArtwork) artworkRef.current.setAnalysis(analysis);
  }, [analysis, mode, profileForRenderer, page]);
  useEffect(() => () => {
    if (coverUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(coverUrlRef.current);
    libraryAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      selectionIdRef.current += 1;
      libraryAbortRef.current?.abort();
      audioTrackRef.current?.pause();
      setAudioPlaying(false);
      setLoadingTrack(false);
      if (window.location.pathname.replace(/\/$/, '') === '/canvas') {
        setPage('artwork');
      } else {
        setAudioError(null);
        setPage('landing');
        if (window.location.hash) {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() =>
            document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: 'auto' })));
        }
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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

  const loadCover = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const nextUrl = URL.createObjectURL(file);
    if (coverUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(coverUrlRef.current);
    coverUrlRef.current = nextUrl;
    setCoverUrl(nextUrl);
    setCoverName(file.name);
    setError(null);
  };

  const loadAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !audioTrackRef.current) return;
    selectionIdRef.current += 1;
    libraryAbortRef.current?.abort();
    analysisPromiseRef.current = null;
    audioFileRef.current = file;
    audioTrackRef.current.load(file);
    setAnalysis(null);
    setAnalyzing(false);
    setHasStarted(false);
    setAudioName(file.name.replace(/\.[^.]+$/, ''));
    setAudioArtist('LOCAL AUDIO');
    setAudioError(null);
    setAudioPlaying(false);
  };

  const chooseLibraryTrack = async (item: LibraryTrack) => {
    const selectionId = ++selectionIdRef.current;
    libraryAbortRef.current?.abort();
    const controller = new AbortController();
    libraryAbortRef.current = controller;
    audioTrackRef.current?.pause();
    audioFileRef.current = null;
    analysisPromiseRef.current = null;
    setAnalysis(null);
    setAnalyzing(false);
    setAudioPlaying(false);
    setHasStarted(false);
    setAudioName(item.title);
    setAudioArtist(item.artist);
    setAudioError(null);
    setLoadingTrack(true);
    try {
      const response = await fetch(`/api/library/audio?id=${encodeURIComponent(item.id)}`, { signal: controller.signal });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? 'Could not load this track.');
      }
      const blob = await response.blob();
      if (selectionId !== selectionIdRef.current) return;
      const file = new File([blob], `${item.id}.mp3`, { type: 'audio/mpeg' });
      const track = audioTrackRef.current;
      if (!track) return;
      analysisPromiseRef.current = null;
      audioFileRef.current = file;
      track.load(file);
      if (item.artwork) {
        if (coverUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(coverUrlRef.current);
        coverUrlRef.current = item.artwork;
        setCoverUrl(item.artwork);
        setCoverName(`${item.title} cover art`);
      }
      setLoadingTrack(false);
      if (!(await analyzeSelectedAudio(file)) || selectionId !== selectionIdRef.current) return;
      await track.play();
      setAudioPlaying(true);
      setHasStarted(true);
    } catch (reason) {
      if (!controller.signal.aborted && selectionId === selectionIdRef.current) {
        setAudioError(reason instanceof Error ? reason.message : 'Could not load this track.');
      }
    } finally {
      if (selectionId === selectionIdRef.current) setLoadingTrack(false);
    }
  };

  const analyzeSelectedAudio = async (selectedFile?: File): Promise<boolean> => {
    if (analysisPromiseRef.current) return analysisPromiseRef.current;
    const trackFile = selectedFile ?? audioFileRef.current;
    const audioTrack = audioTrackRef.current;
    if (!trackFile || !audioTrack) {
      return false;
    }
    const work = (async () => {
      setAnalyzing(true);
      try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Audio-File-Name': encodeURIComponent(trackFile.name),
        },
        body: trackFile,
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === 'object' && 'error' in result ? String(result.error) : 'Local analysis failed.';
        throw new Error(message);
      }
      if (audioFileRef.current !== trackFile) throw new Error('The selected track changed during analysis. Run analysis again for the current track.');
      const matched = await validateMatchingAnalysis(result, trackFile);
      audioTrack.setAnalysis(matched);
      setAnalysis(matched);
      setAudioError(null);
      return true;
    } catch (reason) {
      const message = reason instanceof TypeError
        ? 'Could not reach the local analysis service. Start the app with npm run dev and confirm backend/.venv is installed.'
        : reason instanceof Error ? reason.message : 'Local audio analysis failed.';
      if (audioFileRef.current === trackFile) setAudioError(message);
      return false;
    } finally {
      if (audioFileRef.current === trackFile) {
        setAnalyzing(false);
        analysisPromiseRef.current = null;
      }
    }
    })();
    analysisPromiseRef.current = work;
    return work;
  };

  const toggleAudio = async () => {
    const track = audioTrackRef.current;
    if (!track) return;
    setAudioError(null);
    if (track.isPlaying) {
      track.pause();
      setAudioPlaying(false);
      return;
    }
    try {
      if (!analysis && !(await analyzeSelectedAudio())) return;
      await track.play();
      setAudioPlaying(true);
      setHasStarted(true);
    } catch (reason) {
      setAudioError(reason instanceof Error ? reason.message : 'Audio playback could not start.');
    }
  };

  const showLanding = (section: 'top' | 'collection' | 'about' = 'top') => {
    selectionIdRef.current += 1;
    libraryAbortRef.current?.abort();
    audioTrackRef.current?.pause();
    setAudioPlaying(false);
    setLoadingTrack(false);
    setAudioError(null);
    window.history.pushState({ resonancePage: 'landing' }, '', section === 'top' ? '/' : `/#${section}`);
    setPage('landing');
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (section === 'top') window.scrollTo({ top: 0, behavior: 'auto' });
      else document.getElementById(section)?.scrollIntoView({ behavior: 'auto' });
    }));
  };

  const openCanvas = () => {
    if (window.location.pathname.replace(/\/$/, '') !== '/canvas') {
      window.history.pushState({ resonancePage: 'artwork' }, '', '/canvas');
    }
    setError(null);
    setPage('artwork');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const enterArtwork = (track: LibraryTrack) => {
    setError(null);
    if (track.artwork) {
      if (coverUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(coverUrlRef.current);
      coverUrlRef.current = track.artwork;
      setCoverUrl(track.artwork);
      setCoverName(`${track.title} cover art`);
    }
    openCanvas();
    void chooseLibraryTrack(track);
  };

  return (
    <>
    {page === 'artwork' ? <main className="page-shell">
      <header className="landing-nav canvas-nav">
        <button className="landing-brand" type="button" onClick={() => showLanding('top')}>RESONANCE</button>
        <nav aria-label="Main navigation">
          <a href="/canvas" aria-current="page" onClick={(event) => event.preventDefault()}>CANVAS</a>
          <a href="/#about" onClick={(event) => { event.preventDefault(); showLanding('about'); }}>ABOUT</a>
        </nav>
      </header>
      <section className="stage" aria-label="Track artwork">
        <div className="track-meta">
          <p className="track-kicker">{audioName ? 'NOW PLAYING' : 'CANVAS'}</p>
          <h1>{audioName ?? 'The Adults Are Talking'}</h1>
          <p className="track-artist">{audioArtist}</p>
          <div className="track-actions">
            <label className="audio-load">
              LOAD AUDIO
              <input type="file" accept="audio/*" onChange={loadAudio} aria-label="Choose a local audio file" />
            </label>
            <span className="audio-file" title={audioName ?? undefined}>{audioName ?? 'NO TRACK SELECTED'}</span>
            <button className="pause-control track-play" onClick={toggleAudio} disabled={loadingTrack || analyzing || !audioFileRef.current} aria-label={loadingTrack ? 'Loading track' : analyzing ? 'Analyzing audio' : audioPlaying ? 'Pause' : 'Play'}>
              {audioPlaying ? <Pause size={12} strokeWidth={1.8} /> : analyzing ? null : <Play size={12} strokeWidth={1.8} />}
              <span>{loadingTrack ? 'LOADING…' : analyzing ? 'ANALYZING…' : audioPlaying ? 'PAUSE' : 'PLAY'}</span>
            </button>
          </div>
          {analysis && hasStarted && (
            <div className="live-audio-values" aria-label="Live audio analysis values" aria-live="polite">
              <span><b>BEAT</b>{audioFeatures.beatPulse.toFixed(2)}</span>
              <span><b>DOWNBEAT</b>{audioFeatures.downbeatPulse.toFixed(2)}</span>
              <span><b>PHASE</b>{audioFeatures.beatPhase.toFixed(2)}</span>
              <span><b>LOUDNESS</b>{audioFeatures.rms.toFixed(2)}</span>
              <span><b>BRIGHTNESS</b>{audioFeatures.brightness.toFixed(2)}</span>
              <span><b>ONSET</b>{audioFeatures.onsetStrength.toFixed(2)}</span>
            </div>
          )}
          <div className="canvas-mode-select">
            <span className="canvas-mode-label">VISUAL MODE</span>
            <div className="mode-switch" role="group" aria-label="Artwork mode">
              <button type="button" aria-pressed={mode === 'flow'} onClick={() => setMode('flow')}>FLOW STUDY</button>
              <button type="button" aria-pressed={mode === 'particles'} onClick={() => setMode('particles')}>PARTICLES</button>
            </div>
          </div>
        </div>
        <div className="art-frame" aria-label={mode === 'flow' ? 'Flow Study artwork' : 'Particle artwork'}>
          <div className="canvas-mount" ref={mountRef} />
          {error && <div className="fallback" role="alert"><span className="fallback-mark">R</span><p>{error}</p></div>}
          <details className="tuning">
            <summary>{mode === 'flow' ? 'FLOW / TUNE' : 'MOVE / TUNE'}</summary>
            <div className="tuning-controls">
              {mode === 'flow' ? (
                <>
                  <label>Flow strength <output>{settings.flowStrength.toFixed(2)}</output>
                    <input type="range" min="0.2" max="1.5" step="0.05" value={settings.flowStrength} onChange={(event) => updateSetting('flowStrength', Number(event.target.value))} />
                  </label>
                  <label>Persistence <output>{settings.persistence.toFixed(3)}</output>
                    <input type="range" min="0.78" max="0.985" step="0.005" value={settings.persistence} onChange={(event) => updateSetting('persistence', Number(event.target.value))} />
                  </label>
                  <label>Ribbon thickness <output>{settings.ribbonThickness.toFixed(2)}</output>
                    <input type="range" min="0.45" max="2.5" step="0.05" value={settings.ribbonThickness} onChange={(event) => updateSetting('ribbonThickness', Number(event.target.value))} />
                  </label>
                  <label>Audio influence <output>{settings.audioInfluence.toFixed(2)}</output>
                    <input type="range" min="0" max="1.5" step="0.05" value={settings.audioInfluence} onChange={(event) => updateSetting('audioInfluence', Number(event.target.value))} />
                  </label>
                  {profileForRenderer && <CoverProfilePreview profile={profileForRenderer} />}
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </details>
        </div>
        <label className="cover-thumb" title="Choose a cover image">
          <img src={coverUrl} alt={coverName} />
          <span>CHANGE COVER</span>
          <input type="file" accept="image/*" onChange={loadCover} aria-label="Choose a cover image" />
        </label>
      </section>
      <footer className="bottomline">
        <div className="playback-controls">
          <button className="pause-control visual-pause" onClick={togglePause} aria-label={paused ? 'Resume animation' : 'Pause animation'}>
            {paused ? <Play size={12} strokeWidth={1.8} /> : <Pause size={12} strokeWidth={1.8} />}
            <span>{paused ? 'RESUME VISUAL' : 'PAUSE VISUAL'}</span>
          </button>
        </div>
      </footer>
    </main> : <LandingPage onEnter={enterArtwork} onOpenArtwork={openCanvas} />}
      <audio ref={audioElementRef} onEnded={() => setAudioPlaying(false)} />
      {audioError && <p className="audio-error" role="status">{audioError}</p>}
    </>
  );
}
