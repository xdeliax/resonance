import { useEffect, useRef } from 'react';
import type { CoverVisualProfile } from './coverProfile';

export function CoverProfilePreview({ profile }: { profile: CoverVisualProfile }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    canvas.width = profile.width * 3;
    canvas.height = profile.height;
    [profile.luminance, profile.edges, profile.detail].forEach((map, mapIndex) => {
      const image = context.createImageData(profile.width, profile.height);
      for (let i = 0; i < map.length; i += 1) {
        const pixel = i * 4;
        image.data[pixel] = map[i];
        image.data[pixel + 1] = map[i];
        image.data[pixel + 2] = map[i];
        image.data[pixel + 3] = 255;
      }
      context.putImageData(image, mapIndex * profile.width, 0);
    });
  }, [profile]);

  return (
    <div className="profile-preview">
      <div className="palette-preview" aria-label="Extracted cover palette">
        {profile.palette.map((color, index) => (
          <span key={`${color}-${index}`} title={`${color} · ${Math.round(profile.proportions[index] * 100)}%`} style={{ backgroundColor: color, flexGrow: profile.proportions[index] }} />
        ))}
      </div>
      <canvas ref={canvasRef} className="profile-maps" aria-label="Cover luminance, edge, and detail maps" />
      <div className="profile-map-labels"><span>LIGHT</span><span>EDGE</span><span>DETAIL</span></div>
    </div>
  );
}
