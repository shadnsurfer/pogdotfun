import { useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { CID } from 'multiformats/cid';
import './token-image.css';

const FALLBACK = '/assets/brand/mark.svg';

/** Presentation URLs only. Never changes the original URI saved in token metadata. */
export function tokenImageSource(source: string): string {
  if (!source || source.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(source)) return FALLBACK;
  if (source.startsWith('/') && !source.startsWith('//')) return source;
  if (source.startsWith('ipfs://')) {
    const match = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/.exec(source);
    if (!match) return FALLBACK;
    try {
      CID.parse(match[1]);
      const path = match[2] ?? '';
      for (const part of path.split('/')) {
        const decoded = decodeURIComponent(part);
        if (decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f\\/]/.test(decoded))
          return FALLBACK;
      }
      return `https://gateway.pinata.cloud/ipfs/${match[1]}${path}`;
    } catch {
      return FALLBACK;
    }
  }
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'onLoad' | 'onError'> & {
  src: string;
};

/** Only a source change replaces the inner image; catalog polling preserves loaded DOM. */
export function TokenImage({ src, ...props }: Props) {
  const source = tokenImageSource(src);
  return <ImageSource key={source} source={source} {...props} />;
}
function ImageSource({
  source,
  className = '',
  loading = 'lazy',
  ...props
}: Omit<Props, 'src'> & { source: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'fallback'>(
    source === FALLBACK ? 'fallback' : 'loading',
  );
  return (
    <img
      {...props}
      className={`token-image ${className}`.trim()}
      alt={state === 'fallback' && props.alt ? `${props.alt} unavailable` : props.alt}
      src={state === 'fallback' ? FALLBACK : source}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      data-image-state={state}
      onLoad={() => setState((current) => (current === 'fallback' ? current : 'loaded'))}
      onError={() => setState('fallback')}
    />
  );
}
